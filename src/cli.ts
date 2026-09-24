#!/usr/bin/env node
import * as actual from '@actual-app/api';
import search from '@inquirer/search';
import { stdin, stdout } from 'node:process';
import { mkdir } from 'node:fs/promises';
import { createActualClassifier, type ActualTransaction } from './actual.js';
import type { Classification } from './classifier.js';
import { categoryChoices } from './choices.js';
import { runCategorization, type RunMode, type RunOptions } from './workflow.js';

function usage(): string {
    return `Usage: actual-jev [--interactive | --auto | --dry-run] [options]

Modes: --interactive (default), --auto, --dry-run
Interactive: type to search grouped categories, use arrow keys to move,
and press Enter to select the highlighted category or Skip.
Options:
  --threshold NUMBER   Minimum Jev confidence for auto/dry-run (default: 0.9)
  --account ID_OR_NAME  Limit to one account
  --from YYYY-MM-DD     Inclusive start date
  --to YYYY-MM-DD       Inclusive end date
  --data-dir PATH       Local Actual cache directory (default: .actual-data)
  --help

Environment: ACTUAL_SERVER_URL, ACTUAL_PASSWORD, ACTUAL_SYNC_ID,
ACTUAL_ENCRYPTION_PASSWORD (if enabled), TYPESAFE_API_KEY`;
}

function parseDate(value: string, flag: string): string {
    if (
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
    ) {
        throw new Error(`${flag} requires a valid YYYY-MM-DD date`);
    }
    return value;
}

export function parseArgs(args: readonly string[]): RunOptions & { dataDir: string; help: boolean } {
    let mode: RunMode = 'interactive';
    let modeSet = false;
    let threshold = 0.9;
    let account: string | undefined;
    let from: string | undefined;
    let to: string | undefined;
    let dataDir = '.actual-data';
    let help = false;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--help' || arg === '-h') {
            help = true;
            continue;
        }
        if (arg === '--auto' || arg === '--interactive' || arg === '--dry-run') {
            if (modeSet) throw new Error('Choose only one mode');
            mode = arg.slice(2) as RunMode;
            modeSet = true;
            continue;
        }
        if (
            arg === '--threshold' ||
            arg === '--account' ||
            arg === '--from' ||
            arg === '--to' ||
            arg === '--data-dir'
        ) {
            const value = args[++index];
            if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
            if (arg === '--threshold') {
                threshold = Number(value);
                if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
                    throw new Error('--threshold must be between 0 and 1');
            } else if (arg === '--account') account = value;
            else if (arg === '--from') from = parseDate(value, arg);
            else if (arg === '--to') to = parseDate(value, arg);
            else dataDir = value;
            continue;
        }
        throw new Error(`Unknown option: ${arg}`);
    }
    if (from && to && from > to) throw new Error('--from must be on or before --to');
    return { mode, threshold, account, from, to, dataDir, help };
}

function requireEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`Missing environment variable ${name}`);
    return value;
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(usage());
        return;
    }
    const serverURL = requireEnv('ACTUAL_SERVER_URL');
    const password = requireEnv('ACTUAL_PASSWORD');
    const syncId = requireEnv('ACTUAL_SYNC_ID');
    requireEnv('TYPESAFE_API_KEY');
    if (options.mode === 'interactive' && !stdin.isTTY)
        throw new Error('Interactive mode requires a terminal; use --dry-run or --auto');

    let initialized = false;
    let writes = false;
    try {
        await mkdir(options.dataDir, { recursive: true });
        await actual.init({ serverURL, password, dataDir: options.dataDir, verbose: false });
        initialized = true;
        await actual.downloadBudget(syncId, { password: process.env.ACTUAL_ENCRYPTION_PASSWORD });
        await actual.sync();
        const [accounts, payees, classifier, queryResult] = await Promise.all([
            actual.getAccounts(),
            actual.getPayees(),
            createActualClassifier(actual),
            actual.aqlQuery(actual.q('transactions').select('*').options({ splits: 'grouped' })),
        ]);
        const transactions = (queryResult as { data?: ActualTransaction[] }).data;
        if (!Array.isArray(transactions)) throw new Error('ActualQL did not return transaction rows');
        const transferPayeeAccountIds = new Map(
            payees.flatMap((payee) => (payee.transfer_acct ? [[payee.id, payee.transfer_acct] as const] : [])),
        );
        const categories = classifier.categories;
        const summary = await runCategorization(
            {
                accounts,
                transactions,
                transferPayeeAccountIds,
                payeeNames: new Map(payees.map((payee) => [payee.id, payee.name])),
                categories,
                classify: (transaction) => classifier.classify(transaction),
                updateTransaction: async (id, fields) => {
                    await actual.updateTransaction(id, fields);
                    writes = true;
                },
                print: (line) => console.log(line),
                color: Boolean(stdout.isTTY && !('NO_COLOR' in process.env)),
                choose:
                    options.mode === 'interactive'
                        ? async (_transaction, result: Classification) =>
                              search<string | null>({
                                  message: 'Category (type to search, arrows to move, Enter to select)',
                                  source: (term) => categoryChoices(categories, term),
                                  default: result.categoryId,
                                  pageSize: Math.max(7, Math.min((stdout.rows ?? 20) - 6, 20)),
                              })
                        : undefined,
            },
            options,
        );
        console.log(
            `Examined ${summary.examined}; applied ${summary.applied}; would apply ${summary.wouldApply}; skipped ${summary.skipped}; transfers skipped ${summary.transfersSkipped}.`,
        );
    } finally {
        if (initialized) {
            try {
                if (writes) await actual.sync();
            } finally {
                await actual.shutdown();
            }
        }
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
