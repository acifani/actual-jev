import type * as ActualApi from '@actual-app/api';
import {
    classifyTransaction,
    type CategoryCandidate,
    type CategorizedExample,
    type Classification,
    type ClassifierOptions,
    type JevChoiceClient,
    type TransactionDetails,
} from './classifier.js';

export type ActualTransaction = Awaited<ReturnType<typeof ActualApi.getTransactions>>[number];
export type ActualClient = Pick<typeof ActualApi, 'getCategoryGroups' | 'getPayees' | 'getNote'>;
export type ActualDataClient = ActualClient & Pick<typeof ActualApi, 'getAccounts' | 'aqlQuery' | 'q'>;

export type ActualTransactionInput = Partial<ActualTransaction> & {
    payee_name?: string;
    accountName?: string;
    payeeDefaultCategoryId?: string;
};

export interface ActualClassifier {
    readonly categories: readonly CategoryCandidate[];
    classify(transaction: ActualTransactionInput): Promise<Classification>;
    refresh(): Promise<void>;
}

export interface ActualClassifierOptions extends ClassifierOptions {
    history?: readonly ActualTransaction[];
    eligibleAccountIds?: ReadonlySet<string>;
}

interface JevConfig {
    jev: JevChoiceClient;
    model?: string;
    maxExamplesPerCategory?: number;
}

export type ActualJevConfig = JevConfig &
    (
        | { actual: ActualDataClient; categories?: never; examples?: never }
        | { actual?: never; categories: readonly CategoryCandidate[]; examples?: readonly CategorizedExample[] }
    );

function usefulNote(note: string | undefined): string | undefined {
    const text = note
        ?.split('\n')
        .filter((line) => !/^\s*#(?:template|goal)\b/i.test(line))
        .join('\n')
        .trim();
    return text || undefined;
}

/** Reuses a loaded category catalog when classifying several imported transactions. */
export async function createActualClassifier(
    actual: ActualClient,
    options: ActualClassifierOptions = {},
): Promise<ActualClassifier> {
    let categories: CategoryCandidate[] = [];
    let payees = new Map<string, string>();
    let examples: CategorizedExample[] = [];

    async function refresh(): Promise<void> {
        const [groups, currentPayees] = await Promise.all([
            actual.getCategoryGroups({ hidden: false }),
            actual.getPayees(),
        ]);
        const visible = groups.flatMap((group) =>
            (group.categories ?? []).map((category) => ({
                id: category.id,
                name: category.name,
                groupName: group.name,
                isIncome: category.is_income ?? group.is_income ?? false,
            })),
        );
        categories = await Promise.all(
            visible.map(async (category) => ({
                ...category,
                note: usefulNote((await actual.getNote(category.id))?.note),
            })),
        );
        payees = new Map(currentPayees.map((payee) => [payee.id, payee.name]));
        const transferPayees = new Set(currentPayees.filter((payee) => payee.transfer_acct).map((payee) => payee.id));
        const visibleIds = new Set(categories.map((category) => category.id));
        examples = [...(options.examples ?? [])];
        for (const row of options.history ?? []) {
            if (options.eligibleAccountIds && !options.eligibleAccountIds.has(row.account)) continue;
            for (const transaction of row.subtransactions?.length ? row.subtransactions : [row]) {
                if (
                    !transaction.category ||
                    !visibleIds.has(transaction.category) ||
                    row.transfer_id ||
                    transaction.transfer_id ||
                    row.is_child
                )
                    continue;
                const payee = transaction.payee ?? row.payee;
                if (payee && transferPayees.has(payee)) continue;
                examples.push({
                    id: transaction.id,
                    categoryId: transaction.category,
                    payeeName: payee ? payees.get(payee) : undefined,
                    importedPayee: transaction.imported_payee ?? row.imported_payee,
                    notes: transaction.notes ?? row.notes,
                    amount: transaction.amount,
                    date: transaction.date ?? row.date,
                });
            }
        }
    }

    await refresh();
    return {
        get categories() {
            return categories;
        },
        refresh,
        classify(transaction) {
            const details: TransactionDetails = {
                id: transaction.id,
                payeeName: transaction.payee_name ?? (transaction.payee ? payees.get(transaction.payee) : undefined),
                importedPayee: transaction.imported_payee,
                notes: transaction.notes,
                amount: transaction.amount,
                date: transaction.date,
                accountName: transaction.accountName,
                payeeDefaultCategoryId: transaction.payeeDefaultCategoryId,
            };
            return classifyTransaction(details, categories, { ...options, examples });
        },
    };
}

interface ActualSnapshot {
    classifier: ActualClassifier;
    accountNames: ReadonlyMap<string, string>;
}

/** Classifies with either caller-supplied data or a lazily loaded Actual budget snapshot. */
export class ActualJev {
    private snapshot: ActualSnapshot | undefined;
    private loading: Promise<ActualSnapshot> | undefined;

    constructor(private readonly config: ActualJevConfig) {
        if (!config.jev) throw new TypeError('A configured Jev client is required');
    }

    get categories(): readonly CategoryCandidate[] {
        return 'actual' in this.config ? (this.snapshot?.classifier.categories ?? []) : this.config.categories;
    }

    private async load(): Promise<ActualSnapshot> {
        if (!this.config.actual) throw new TypeError('Manual data cannot be refreshed from Actual');
        const actual = this.config.actual;
        const [accounts, queryResult] = await Promise.all([
            actual.getAccounts(),
            actual.aqlQuery(actual.q('transactions').select('*').options({ splits: 'grouped' })),
        ]);
        const history = (queryResult as { data?: ActualTransaction[] }).data;
        if (!Array.isArray(history)) throw new Error('ActualQL did not return transaction rows');
        const classifier = await createActualClassifier(actual, {
            client: this.config.jev,
            model: this.config.model,
            maxExamplesPerCategory: this.config.maxExamplesPerCategory,
            history,
            eligibleAccountIds: new Set(accounts.filter((account) => !account.offbudget).map((account) => account.id)),
        });
        return { classifier, accountNames: new Map(accounts.map((account) => [account.id, account.name])) };
    }

    async refresh(): Promise<void> {
        if (!this.config.actual) return;
        if (!this.loading) {
            const loading = this.load();
            this.loading = loading;
            void loading.then(
                (snapshot) => {
                    this.snapshot = snapshot;
                    if (this.loading === loading) this.loading = undefined;
                },
                () => {
                    if (this.loading === loading) this.loading = undefined;
                },
            );
        }
        await this.loading;
    }

    async classify(transaction: ActualTransactionInput | TransactionDetails): Promise<Classification> {
        if (!this.config.actual) {
            return classifyTransaction(transaction, this.config.categories, {
                client: this.config.jev,
                model: this.config.model,
                examples: this.config.examples,
                maxExamplesPerCategory: this.config.maxExamplesPerCategory,
            });
        }
        if (!this.snapshot) await this.refresh();
        const snapshot = this.snapshot!;
        const input = transaction as ActualTransactionInput;
        return snapshot.classifier.classify({
            ...input,
            accountName: input.accountName ?? (input.account ? snapshot.accountNames.get(input.account) : undefined),
        });
    }
}
