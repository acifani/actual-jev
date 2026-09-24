import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveConfig, validateConfig, type Config } from './config.js';

export interface BudgetChoice {
    name: string;
    cloudFileId: string;
    groupId?: string | null;
    encryptKeyId?: string | null;
}
export interface SetupPort {
    input(message: string, initial?: string): Promise<string>;
    secret(message: string): Promise<string>;
    select(message: string, choices: { name: string; value: string }[], initial?: string): Promise<string>;
    print(message: string): void;
    actual: {
        init(options: { serverURL: string; password: string; dataDir: string; verbose: boolean }): Promise<unknown>;
        getBudgets(): Promise<BudgetChoice[]>;
        downloadBudget(id: string, options: { password?: string }): Promise<unknown>;
        shutdown(): Promise<unknown>;
    };
}
async function secretSetting(
    port: SetupPort,
    name: string,
    previous?: string,
    clear = false,
): Promise<string | undefined> {
    if (previous !== undefined) {
        const action = await port.select(name, [
            { name: 'Keep saved value', value: 'keep' },
            { name: 'Replace', value: 'replace' },
            ...(clear ? [{ name: 'Clear', value: 'clear' }] : []),
        ]);
        if (action === 'keep') return previous;
        if (action === 'clear') return undefined;
    }
    return port.secret(name);
}
export async function runSetup(saved: Config, configFile: string, port: SetupPort): Promise<void> {
    port.print(`Credentials will be saved locally in ${configFile}.`);
    const serverURL = (await port.input('Actual server URL', saved.serverURL)).trim();
    validateConfig({ version: 1, serverURL });
    const password = (await secretSetting(port, 'Actual server password', saved.password))!;
    const candidate: Config = { ...saved, version: 1, serverURL, password };
    const dataDir = await mkdtemp(join(tmpdir(), 'actual-jev-setup-'));
    let initialized = false;
    let budgetName: string;
    try {
        try {
            await port.actual.init({ serverURL, password, dataDir, verbose: false });
            initialized = true;
        } catch {
            throw new Error(
                'Could not connect to Actual. Check the server URL and password, then run actual-jev setup again.',
            );
        }
        let budgets: BudgetChoice[];
        try {
            budgets = await port.actual.getBudgets();
        } catch {
            throw new Error('Could not list budgets. Check the Actual connection and run actual-jev setup again.');
        }
        // Actual downloads by groupId (the sync ID); cloudFileId identifies the server file.
        const unique = [
            ...new Map(
                budgets
                    .filter((budget): budget is BudgetChoice & { groupId: string } =>
                        Boolean(budget.cloudFileId && budget.groupId),
                    )
                    .map((budget) => [budget.groupId, budget]),
            ).values(),
        ];
        if (!unique.length)
            throw new Error(
                'No synced budgets found. Upload a budget to your Actual server, then run actual-jev setup again.',
            );
        const syncId = await port.select(
            'Choose your budget',
            unique.map((budget) => ({
                name:
                    unique.filter((other) => other.name === budget.name).length > 1
                        ? `${budget.name} (${budget.groupId})`
                        : budget.name,
                value: budget.groupId,
            })),
            saved.serverURL === serverURL ? saved.syncId : undefined,
        );
        const budget = unique.find((budget) => budget.groupId === syncId)!;
        candidate.syncId = syncId;
        budgetName = budget.name;
        const previousEncryption =
            saved.serverURL === serverURL && saved.syncId === syncId ? saved.encryptionPassword : undefined;
        candidate.encryptionPassword = budget.encryptKeyId
            ? await secretSetting(port, 'Budget encryption password', previousEncryption, true)
            : undefined;
        try {
            await port.actual.downloadBudget(syncId, { password: candidate.encryptionPassword });
        } catch {
            throw new Error(
                'Could not open the budget. Check its encryption password and connection, then run actual-jev setup again.',
            );
        }
        candidate.apiKey = await secretSetting(port, 'TypeSafe API key', saved.apiKey);
        validateConfig(candidate);
    } finally {
        try {
            if (initialized) await port.actual.shutdown();
        } finally {
            await rm(dataDir, { recursive: true, force: true });
        }
    }
    await saveConfig(configFile, candidate);
    port.print(
        `Saved configuration to ${configFile}.\nBudget: ${budgetName}\nTry actual-jev --dry-run to preview suggestions and verify your TypeSafe API key.`,
    );
}
