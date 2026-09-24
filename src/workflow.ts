import { decision, describeSuggestion } from './output.js';
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
    offbudget?: boolean;
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
    transferPayeeAccountIds: ReadonlyMap<string, string>;
    payeeNames?: ReadonlyMap<string, string>;
    categories: readonly CategoryCandidate[];
    classify(transaction: ActualTransaction & { accountName?: string }): Promise<Classification>;
    updateTransaction(id: string, fields: Partial<ActualTransaction>): Promise<unknown>;
    choose?(transaction: ActualTransaction, result: Classification): Promise<string | null>;
    print(line: string): void;
    color?: boolean;
}

function isSkippableTransfer(
    transaction: ActualTransaction,
    transferPayeeAccountIds: ReadonlyMap<string, string>,
    accountById: ReadonlyMap<string, AccountInfo>,
    transactionById: ReadonlyMap<string, ActualTransaction>,
): boolean {
    const targetAccountId =
        (transaction.payee && transferPayeeAccountIds.get(transaction.payee)) ||
        (transaction.transfer_id && transactionById.get(transaction.transfer_id)?.account);
    if (targetAccountId && accountById.get(targetAccountId)?.offbudget) return false;
    return Boolean(transaction.transfer_id || (transaction.payee && transferPayeeAccountIds.has(transaction.payee)));
}

function inRange(transaction: ActualTransaction, options: RunOptions): boolean {
    return (!options.from || transaction.date >= options.from) && (!options.to || transaction.date <= options.to);
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
    const allowedAccounts = new Set(
        selectedAccounts.filter((account) => !account.offbudget).map((account) => account.id),
    );
    const transactionById = new Map(
        port.transactions
            .flatMap((transaction) => [transaction, ...(transaction.subtransactions ?? [])])
            .map((transaction) => [transaction.id, transaction]),
    );
    const categoryById = new Map(port.categories.map((category) => [category.id, category]));
    const summary: RunSummary = { examined: 0, applied: 0, wouldApply: 0, skipped: 0, transfersSkipped: 0 };

    const color = Boolean(port.color);

    async function process(transaction: ActualTransaction, accountName: string): Promise<void> {
        summary.examined++;
        const result = await port.classify({ ...transaction, accountName });
        const suggestion = result.categoryId ? categoryById.get(result.categoryId) : undefined;
        if (result.categoryId && !suggestion)
            throw new Error('Classifier returned a category outside the visible catalog');
        const line = describeSuggestion(
            transaction,
            accountName,
            suggestion,
            result.confidence,
            port.payeeNames,
            color,
        );
        let selected = result.categoryId;
        let skipped = 'Skipped';
        const interactive = options.mode === 'interactive';
        if (interactive) {
            if (!port.choose) throw new Error('Interactive mode requires a choice handler');
            port.print(line);
            selected = await port.choose(transaction, result);
            if (selected && !categoryById.has(selected))
                throw new Error('Selected category is outside the visible catalog');
        } else if (!selected || result.confidence < options.threshold) {
            skipped += selected ? ' · below threshold' : ' · no match';
            selected = null;
        }

        let message: string;
        let applied = false;
        if (!selected) {
            summary.skipped++;
            message = skipped;
        } else if (options.mode === 'dry-run') {
            summary.wouldApply++;
            message = 'Would apply';
        } else {
            await port.updateTransaction(transaction.id, { category: selected });
            summary.applied++;
            applied = true;
            const category = categoryById.get(selected)!;
            message = interactive ? `Applied ${category.groupName} / ${category.name}` : 'Applied';
        }
        port.print(`${interactive ? '' : `${line}\n`}${decision(message, color, applied)}`);
    }

    for (const transaction of port.transactions) {
        if (!allowedAccounts.has(transaction.account)) continue;
        const accountName = accountById.get(transaction.account)?.name ?? transaction.account;
        const children = transaction.subtransactions?.length ? transaction.subtransactions : undefined;
        if (!children && transaction.is_child) continue;
        const parentTransfer = isSkippableTransfer(
            transaction,
            port.transferPayeeAccountIds,
            accountById,
            transactionById,
        );
        for (const row of children ?? [transaction]) {
            if (row.category || !inRange(row, options)) continue;
            if (
                parentTransfer ||
                (children && isSkippableTransfer(row, port.transferPayeeAccountIds, accountById, transactionById))
            ) {
                summary.transfersSkipped++;
                continue;
            }
            // Eligibility uses the original child; inherit display/classification details afterward.
            const candidate = children
                ? {
                      ...row,
                      payee: row.payee ?? transaction.payee,
                      imported_payee: row.imported_payee ?? transaction.imported_payee,
                      date: row.date ?? transaction.date,
                  }
                : row;
            await process(candidate, accountName);
        }
    }
    return summary;
}
