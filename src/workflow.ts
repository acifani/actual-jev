import type { ActualTransaction } from './actual.js';
import type { CategoryCandidate, Classification } from './classifier.js';

export type RunMode = 'auto' | 'interactive' | 'dry-run';
export interface RunOptions {
    mode: RunMode;
    threshold: number;
    account?: string;
    from?: string;
    to?: string;
}
export interface AccountInfo {
    id: string;
    name: string;
}
export interface RunSummary {
    examined: number;
    applied: number;
    wouldApply: number;
    skipped: number;
    transfersSkipped: number;
}
export interface WorkflowPort {
    accounts: readonly AccountInfo[];
    transactions: readonly ActualTransaction[];
    transferPayeeIds: ReadonlySet<string>;
    payeeNames?: ReadonlyMap<string, string>;
    categories: readonly CategoryCandidate[];
    classify(transaction: ActualTransaction & { accountName?: string }): Promise<Classification>;
    updateTransaction(id: string, fields: Partial<ActualTransaction>): Promise<unknown>;
    choose?(transaction: ActualTransaction, result: Classification): Promise<string | null>;
    print(line: string): void;
}

function isUncategorized(transaction: ActualTransaction): boolean {
    return !transaction.category;
}

function isTransfer(transaction: ActualTransaction, transferPayeeIds: ReadonlySet<string>): boolean {
    return Boolean(transaction.transfer_id || (transaction.payee && transferPayeeIds.has(transaction.payee)));
}

function inRange(transaction: ActualTransaction, options: RunOptions): boolean {
    return (!options.from || transaction.date >= options.from) && (!options.to || transaction.date <= options.to);
}

function describe(
    transaction: ActualTransaction,
    accountName: string,
    payeeNames?: ReadonlyMap<string, string>,
): string {
    return `${transaction.date} | ${accountName} | ${transaction.imported_payee ?? (transaction.payee && payeeNames?.get(transaction.payee)) ?? 'Unknown payee'} | ${transaction.amount}`;
}

/** Process grouped ActualQL rows, classifying each split child once. */
export async function runCategorization(port: WorkflowPort, options: RunOptions): Promise<RunSummary> {
    const accountById = new Map(port.accounts.map((account) => [account.id, account]));
    const selectedAccounts = options.account
        ? port.accounts.filter((account) => account.id === options.account || account.name === options.account)
        : port.accounts;
    if (options.account && selectedAccounts.length !== 1) {
        throw new Error(`Account must match exactly one ID or name: ${options.account}`);
    }
    const allowedAccounts = new Set(selectedAccounts.map((account) => account.id));
    const categoryById = new Map(port.categories.map((category) => [category.id, category]));
    const summary: RunSummary = { examined: 0, applied: 0, wouldApply: 0, skipped: 0, transfersSkipped: 0 };

    async function select(transaction: ActualTransaction, accountName: string): Promise<string | null> {
        summary.examined++;
        const result = await port.classify({ ...transaction, accountName });
        const suggestion = result.categoryId ? categoryById.get(result.categoryId) : undefined;
        if (result.categoryId && !suggestion)
            throw new Error('Classifier returned a category outside the visible catalog');
        const line = `${describe(transaction, accountName, port.payeeNames)} -> ${suggestion ? `${suggestion.groupName} / ${suggestion.name}` : 'no match'} (${result.confidence.toFixed(2)})`;
        port.print(line);
        if (options.mode === 'interactive') {
            if (!port.choose) throw new Error('Interactive mode requires a choice handler');
            const selected = await port.choose(transaction, result);
            if (selected && !categoryById.has(selected))
                throw new Error('Selected category is outside the visible catalog');
            if (!selected) summary.skipped++;
            return selected;
        }
        if (!result.categoryId || result.confidence < options.threshold) {
            summary.skipped++;
            return null;
        }
        if (options.mode === 'dry-run') {
            summary.wouldApply++;
            return null;
        }
        return result.categoryId;
    }

    for (const transaction of port.transactions) {
        if (!allowedAccounts.has(transaction.account)) continue;
        const accountName = accountById.get(transaction.account)?.name ?? transaction.account;
        if (transaction.subtransactions?.length) {
            if (isTransfer(transaction, port.transferPayeeIds)) {
                summary.transfersSkipped += transaction.subtransactions.filter(
                    (child) => isUncategorized(child) && inRange(child, options),
                ).length;
                continue;
            }
            for (const child of transaction.subtransactions) {
                if (!isUncategorized(child) || !inRange(child, options)) continue;
                if (isTransfer(child, port.transferPayeeIds)) {
                    summary.transfersSkipped++;
                    continue;
                }
                const categoryId = await select(
                    {
                        ...child,
                        payee: child.payee ?? transaction.payee,
                        imported_payee: child.imported_payee ?? transaction.imported_payee,
                        date: child.date ?? transaction.date,
                    },
                    accountName,
                );
                if (categoryId) {
                    await port.updateTransaction(child.id, { category: categoryId });
                    summary.applied++;
                }
            }
            continue;
        }
        if (transaction.is_child || !isUncategorized(transaction) || !inRange(transaction, options)) continue;
        if (isTransfer(transaction, port.transferPayeeIds)) {
            summary.transfersSkipped++;
            continue;
        }
        const categoryId = await select(transaction, accountName);
        if (categoryId) {
            await port.updateTransaction(transaction.id, { category: categoryId });
            summary.applied++;
        }
    }
    return summary;
}
