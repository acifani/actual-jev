#!/usr/bin/env node
import * as actual from '@actual-app/api';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import search from '@inquirer/search';
import { stdin, stdout } from 'node:process';
import { mkdir } from 'node:fs/promises';
import { createActualClassifier, type ActualTransaction } from './actual.js';
import { examplesPerCategoryFromEnv, type Classification } from './classifier.js';
import { categoryChoices } from './choices.js';
import { runCategorization } from './workflow.js';
import { parseArgs } from './args.js';

export { parseArgs } from './args.js';

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
ACTUAL_ENCRYPTION_PASSWORD (if enabled), TYPESAFE_API_KEY,
ACTUAL_JEV_MAX_EXAMPLES_PER_CATEGORY (default: 3)`;
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
    const maxExamplesPerCategory = examplesPerCategoryFromEnv(process.env);
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
        const [accounts, payees, queryResult] = await Promise.all([
            actual.getAccounts(),
            actual.getPayees(),
            actual.aqlQuery(actual.q('transactions').select('*').options({ splits: 'grouped' })),
        ]);
        const transactions = (queryResult as { data?: ActualTransaction[] }).data;
        if (!Array.isArray(transactions)) throw new Error('ActualQL did not return transaction rows');
        const jev = new TypeSafeClient();
        const classifier = await createActualClassifier(actual, {
            client: jev,
            maxExamplesPerCategory,
            history: transactions,
            eligibleAccountIds: new Set(accounts.filter((account) => !account.offbudget).map((account) => account.id)),
        });
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
