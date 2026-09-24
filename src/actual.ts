import type * as ActualApi from '@actual-app/api';
import {
    classifyTransaction,
    type CategoryCandidate,
    type CategorizedExample,
    type Classification,
    type ClassifierOptions,
    type TransactionDetails,
} from './classifier.js';

export type ActualTransaction = Awaited<ReturnType<typeof ActualApi.getTransactions>>[number];
export type ActualClient = Pick<typeof ActualApi, 'getCategoryGroups' | 'getPayees' | 'getNote'>;

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
