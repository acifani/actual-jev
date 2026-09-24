#!/usr/bin/env node
import * as actual from '@actual-app/api';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import search from '@inquirer/search';
import { input, password as passwordPrompt, confirm } from '@inquirer/prompts';
import { stdin, stdout } from 'node:process';
import { mkdir } from 'node:fs/promises';
import { createActualClassifier, type ActualTransaction } from './actual.js';
import { type Classification } from './classifier.js';
import { categoryChoices } from './choices.js';
import { runCategorization } from './workflow.js';
import { parseArgs } from './args.js';
import { budgetDataDir, configSummary, missingSettings, readConfig, resolveConfig, userPaths } from './config.js';
import { runSetup } from './setup.js';
import { resolve } from 'node:path';

export { parseArgs } from './args.js';

function usage(): string {
    return `Usage: actual-jev [--interactive | --auto | --dry-run] [options]
       actual-jev setup
       actual-jev config show [--env-file PATH]

Run setup once to save your connection settings. config show hides secrets.

Modes: --interactive (default), --auto, --dry-run
Interactive: type to search grouped categories, use arrow keys to move,
and press Enter to select the highlighted category or Skip.
Options:
  --threshold NUMBER                   Minimum confidence for auto/dry-run (default: 0.9)
  --max-examples-per-category NUMBER    Historical examples per category, 0–100 (default: 3)
  --account ID_OR_NAME                  Limit to one account
  --from YYYY-MM-DD                     Inclusive start date
  --to YYYY-MM-DD                       Inclusive end date
  --data-dir PATH                       Override the user Actual cache directory
  --env-file PATH                       Read environment settings from a file
  --help

Use setup for saved settings, or supply all connection settings through
exported environment variables and/or --env-file:
  ACTUAL_SERVER_URL, ACTUAL_PASSWORD, ACTUAL_SYNC_ID, TYPESAFE_API_KEY
  ACTUAL_ENCRYPTION_PASSWORD (only for encrypted budgets)

Environment configuration never uses saved settings. Exported variables
win over values in --env-file. No .env file is loaded automatically.
Use command flags for run options. The saved maxExamplesPerCategory setting
provides the example limit for saved configuration; the flag overrides it.`;
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(usage());
        return;
    }
    const paths = userPaths();
    const setup = async () => {
        if (!stdin.isTTY || !stdout.isTTY)
            throw new Error('Setup requires a terminal. Use environment variables for unattended runs.');
        await runSetup(await readConfig(paths.configFile), paths.configFile, {
            input: (message, initial) =>
                input({ message, default: initial, validate: (value) => Boolean(value.trim()) || 'Enter a value' }),
            secret: (message) =>
                passwordPrompt({ message, mask: '*', validate: (value) => Boolean(value.trim()) || 'Enter a value' }),
            select: (message, choices, initial) =>
                search({
                    message,
                    default: initial,
                    source: (term) =>
                        choices.filter((choice) => choice.name.toLowerCase().includes((term ?? '').toLowerCase())),
                }),
            print: (line) => console.log(line),
            actual,
        });
    };
    if (options.command === 'setup') {
        await setup();
        return;
    }
    const { config, source } = await resolveConfig(paths.configFile, process.env, options.envFile);
    const maxExamplesPerCategory = options.maxExamplesPerCategory ?? config.maxExamplesPerCategory ?? 3;
    const dataDir = options.dataDir ? resolve(options.dataDir) : budgetDataDir(paths.dataRoot, config);
    if (options.command === 'config-show') {
        console.log(
            [
                `Configuration: ${source}${source === 'saved configuration' ? ` (${paths.configFile})` : ''}`,
                `Actual data: ${dataDir} (${options.dataDir ? '--data-dir' : 'default'})`,
                ...configSummary(config),
                `threshold: ${options.threshold}`,
                `maxExamplesPerCategory: ${maxExamplesPerCategory}`,
            ].join('\n'),
        );
        return;
    }
    const missing = missingSettings(config);
    if (missing.length) {
        if (
            source === 'saved configuration' &&
            options.mode === 'interactive' &&
            stdin.isTTY &&
            stdout.isTTY &&
            (await confirm({ message: 'Configuration is incomplete. Start setup?', default: true }))
        ) {
            await setup();
            return;
        }
        throw new Error(
            `Missing configuration: ${missing.join(', ')}. ${source === 'environment' ? 'Provide all connection settings through environment variables or --env-file (see --help). Saved settings are not used.' : 'Run actual-jev setup.'}`,
        );
    }
    const { serverURL, password, syncId } = config;
    if (options.mode === 'interactive' && (!stdin.isTTY || !stdout.isTTY))
        throw new Error('Interactive mode requires a terminal; use --dry-run or --auto');

    let initialized = false;
    let writes = false;
    try {
        await mkdir(dataDir, { recursive: true, mode: 0o700 });
        await actual.init({ serverURL: serverURL!, password: password!, dataDir, verbose: false });
        initialized = true;
        await actual.downloadBudget(syncId!, { password: config.encryptionPassword });
        await actual.sync();
        const [accounts, payees, queryResult] = await Promise.all([
            actual.getAccounts(),
            actual.getPayees(),
            actual.aqlQuery(actual.q('transactions').select('*').options({ splits: 'grouped' })),
        ]);
        const transactions = (queryResult as { data?: ActualTransaction[] }).data;
        if (!Array.isArray(transactions)) throw new Error('ActualQL did not return transaction rows');
        const jev = new TypeSafeClient({ apiKey: config.apiKey });
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
    if (error instanceof Error && error.name === 'ExitPromptError') {
        console.error('Setup or selection cancelled.');
        process.exitCode = 130;
        return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
