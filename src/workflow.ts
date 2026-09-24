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
    transferPayeeIds: ReadonlySet<string>;
    payeeNames?: ReadonlyMap<string, string>;
    categories: readonly CategoryCandidate[];
    classify(transaction: ActualTransaction & { accountName?: string }): Promise<Classification>;
    updateTransaction(id: string, fields: Partial<ActualTransaction>): Promise<unknown>;
    choose?(transaction: ActualTransaction, result: Classification): Promise<string | null>;
    print(line: string): void;
    color?: boolean;
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

function wrapText(value: string, prefix: string, continuation: string): string[] {
    const words = value.replace(/\s+/g, ' ').trim().split(' ');
    const lines: string[] = [];
    let line = prefix;
    for (const word of words) {
        if (line !== prefix && line.length + word.length + 1 > 88) {
            lines.push(line);
            line = `${continuation}${word}`;
        } else {
            line += `${line === prefix ? '' : ' '}${word}`;
        }
    }
    lines.push(line);
    return lines;
}

function emphasize(value: string, code: string, color: boolean): string {
    return color ? `\u001b[${code}m${value}\u001b[0m` : value;
}

function decision(value: string, color: boolean, applied = false): string {
    return `  Decision    ${emphasize(value, applied ? '32' : '33', color)}`;
}

function describe(
    transaction: ActualTransaction,
    accountName: string,
    payeeNames?: ReadonlyMap<string, string>,
    color = false,
): string {
    const amount = (transaction.amount / 100).toFixed(2);
    const namedPayee = transaction.payee ? payeeNames?.get(transaction.payee)?.trim() : undefined;
    const importedPayee = transaction.imported_payee?.trim();
    const merchant = importedPayee?.match(/\bPresso\s+(.+?)\s+-\s+Transazione\b/i)?.[1]?.trim();
    const payee = namedPayee && namedPayee !== importedPayee ? namedPayee : (merchant ?? namedPayee ?? importedPayee);
    const payeeLines = wrapText(payee || 'Unknown payee', '  ', '  ');
    return `\n  ${emphasize(amount, '1;36', color)}\n${payeeLines.map((line) => emphasize(line, '1', color)).join('\n')}\n  ${emphasize(`${transaction.date} · ${accountName}`, '2', color)}`;
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
    const allowedAccounts = new Set(selectedAccounts.filter((account) => !account.offbudget).map((account) => account.id));
    const categoryById = new Map(port.categories.map((category) => [category.id, category]));
    const summary: RunSummary = { examined: 0, applied: 0, wouldApply: 0, skipped: 0, transfersSkipped: 0 };

    async function process(transaction: ActualTransaction, accountName: string): Promise<void> {
        summary.examined++;
        const result = await port.classify({ ...transaction, accountName });
        const suggestion = result.categoryId ? categoryById.get(result.categoryId) : undefined;
        if (result.categoryId && !suggestion)
            throw new Error('Classifier returned a category outside the visible catalog');
        const suggestedName = suggestion ? `${suggestion.groupName} / ${suggestion.name}` : 'no match';
        const suggestionLine = `  Suggestion  ${emphasize(suggestedName, '36', Boolean(port.color))} · ${Math.round(result.confidence * 100)}% confidence`;
        const line = `${describe(transaction, accountName, port.payeeNames, port.color)}\n\n${suggestionLine}`;
        if (options.mode === 'interactive') {
            if (!port.choose) throw new Error('Interactive mode requires a choice handler');
            port.print(line);
            const selected = await port.choose(transaction, result);
            if (selected && !categoryById.has(selected))
                throw new Error('Selected category is outside the visible catalog');
            if (!selected) {
                summary.skipped++;
                port.print(decision('Skipped', Boolean(port.color)));
                return;
            }
            await port.updateTransaction(transaction.id, { category: selected });
            summary.applied++;
            const category = categoryById.get(selected)!;
            port.print(decision(`Applied ${category.groupName} / ${category.name}`, Boolean(port.color), true));
            return;
        }
        if (!result.categoryId || result.confidence < options.threshold) {
            summary.skipped++;
            port.print(
                `${line}\n${decision(`Skipped · ${result.categoryId ? 'below threshold' : 'no match'}`, Boolean(port.color))}`,
            );
            return;
        }
        if (options.mode === 'dry-run') {
            summary.wouldApply++;
            port.print(`${line}\n${decision('Would apply', Boolean(port.color))}`);
            return;
        }
        await port.updateTransaction(transaction.id, { category: result.categoryId });
        summary.applied++;
        port.print(`${line}\n${decision('Applied', Boolean(port.color), true)}`);
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
                await process(
                    {
                        ...child,
                        payee: child.payee ?? transaction.payee,
                        imported_payee: child.imported_payee ?? transaction.imported_payee,
                        date: child.date ?? transaction.date,
                    },
                    accountName,
                );
            }
            continue;
        }
        if (transaction.is_child || !isUncategorized(transaction) || !inRange(transaction, options)) continue;
        if (isTransfer(transaction, port.transferPayeeIds)) {
            summary.transfersSkipped++;
            continue;
        }
        await process(transaction, accountName);
    }
    return summary;
}
