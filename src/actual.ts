import type * as ActualApi from '@actual-app/api';
import {
    classifyTransaction,
    type CategoryCandidate,
    type Classification,
    type ClassifierOptions,
    type TransactionDetails,
} from './classifier.js';

export type ActualTransaction = Awaited<ReturnType<typeof ActualApi.getTransactions>>[number];
export type ActualClient = Pick<typeof ActualApi, 'getCategoryGroups' | 'getPayees'>;

export type ActualTransactionInput = Partial<ActualTransaction> & {
    payee_name?: string;
    accountName?: string;
};

export interface ActualClassifier {
    readonly categories: readonly CategoryCandidate[];
    classify(transaction: ActualTransactionInput): Promise<Classification>;
    refresh(): Promise<void>;
}

/** Reuses a loaded category catalog when classifying several imported transactions. */
export async function createActualClassifier(
    actual: ActualClient,
    options: ClassifierOptions = {},
): Promise<ActualClassifier> {
    let categories: CategoryCandidate[] = [];
    let payees = new Map<string, string>();

    async function refresh(): Promise<void> {
        const [groups, currentPayees] = await Promise.all([
            actual.getCategoryGroups({ hidden: false }),
            actual.getPayees(),
        ]);
        categories = groups.flatMap((group) =>
            (group.categories ?? []).map((category) => ({
                id: category.id,
                name: category.name,
                groupName: group.name,
                isIncome: category.is_income ?? group.is_income ?? false,
            })),
        );
        payees = new Map(currentPayees.map((payee) => [payee.id, payee.name]));
    }

    await refresh();
    return {
        get categories() {
            return categories;
        },
        refresh,
        classify(transaction) {
            const details: TransactionDetails = {
                payeeName: transaction.payee_name ?? (transaction.payee ? payees.get(transaction.payee) : undefined),
                importedPayee: transaction.imported_payee,
                notes: transaction.notes,
                amount: transaction.amount,
                date: transaction.date,
                accountName: transaction.accountName,
            };
            return classifyTransaction(details, categories, options);
        },
    };
}
