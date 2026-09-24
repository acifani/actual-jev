import type { ActualTransaction } from './actual.js';
import type { CategoryCandidate } from './classifier.js';

function wrapText(value: string): string[] {
    const prefix = '  ';
    const words = value.replace(/\s+/g, ' ').trim().split(' ');
    const lines: string[] = [];
    let line = prefix;
    for (const word of words) {
        if (line !== prefix && line.length + word.length + 1 > 88) {
            lines.push(line);
            line = `${prefix}${word}`;
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

export function decision(value: string, color: boolean, applied = false): string {
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
    const payeeLines = wrapText(payee || 'Unknown payee');
    return `\n  ${emphasize(amount, '1;36', color)}\n${payeeLines.map((line) => emphasize(line, '1', color)).join('\n')}\n  ${emphasize(`${transaction.date} · ${accountName}`, '2', color)}`;
}

export function describeSuggestion(
    transaction: ActualTransaction,
    accountName: string,
    category: CategoryCandidate | undefined,
    confidence: number,
    payeeNames?: ReadonlyMap<string, string>,
    color = false,
): string {
    const name = category ? `${category.groupName} / ${category.name}` : 'no match';
    return `${describe(transaction, accountName, payeeNames, color)}\n\n  Suggestion  ${emphasize(name, '36', color)} · ${Math.round(confidence * 100)}% confidence`;
}
