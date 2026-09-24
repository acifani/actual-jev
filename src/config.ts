import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

export interface Config {
    version: 1;
    serverURL?: string;
    password?: string;
    syncId?: string;
    encryptionPassword?: string;
    apiKey?: string;
    maxExamplesPerCategory?: number;
}
export type Environment = Record<string, string | undefined>;
export function userPaths(env: Environment = process.env, platform = process.platform, home = homedir()) {
    const configRoot =
        platform === 'win32'
            ? (env.APPDATA ?? join(home, 'AppData', 'Roaming'))
            : platform === 'darwin'
              ? join(home, 'Library', 'Application Support')
              : env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
                ? env.XDG_CONFIG_HOME
                : join(home, '.config');
    const dataRoot =
        platform === 'win32'
            ? (env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'))
            : platform === 'darwin'
              ? join(home, 'Library', 'Application Support')
              : env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME)
                ? env.XDG_DATA_HOME
                : join(home, '.local', 'share');
    return {
        configFile: join(configRoot, 'actual-jev', 'config.json'),
        dataRoot: join(dataRoot, 'actual-jev', 'budgets'),
    };
}
export function validateConfig(value: unknown): Config {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuration must be an object');
    const raw = value as Record<string, unknown>;
    if (raw.version !== 1) throw new Error('Unsupported configuration version');
    const allowed = [
        'version',
        'serverURL',
        'password',
        'syncId',
        'encryptionPassword',
        'apiKey',
        'maxExamplesPerCategory',
    ];
    for (const key of Object.keys(raw))
        if (!allowed.includes(key)) throw new Error(`Unknown configuration setting: ${key}`);
    for (const key of ['serverURL', 'password', 'syncId', 'encryptionPassword', 'apiKey']) {
        if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !raw[key].trim()))
            throw new Error(`Invalid ${key}: expected a nonempty string`);
    }
    if (raw.serverURL !== undefined) {
        let url: URL;
        try {
            url = new URL(raw.serverURL as string);
        } catch {
            throw new Error('serverURL must be an http or https URL');
        }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
            throw new Error('serverURL must be an http or https URL without embedded credentials');
    }
    if (
        raw.maxExamplesPerCategory !== undefined &&
        (typeof raw.maxExamplesPerCategory !== 'number' ||
            !Number.isSafeInteger(raw.maxExamplesPerCategory) ||
            raw.maxExamplesPerCategory < 0 ||
            raw.maxExamplesPerCategory > 100)
    )
        throw new Error('maxExamplesPerCategory must be an integer between 0 and 100');
    return raw as unknown as Config;
}
export async function readConfig(path: string): Promise<Config> {
    let content: string;
    try {
        content = await readFile(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1 };
        throw new Error(`Cannot read configuration at ${path}`, { cause: error });
    }
    try {
        return validateConfig(JSON.parse(content));
    } catch (error) {
        throw new Error(
            `Invalid configuration at ${path}. Correct or remove the file. ${error instanceof SyntaxError ? 'Invalid JSON.' : (error as Error).message}`,
            { cause: error },
        );
    }
}
export async function saveConfig(path: string, config: Config): Promise<void> {
    validateConfig(config);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(dirname(path), 0o700);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        await rename(temporary, path);
    } finally {
        await rm(temporary, { force: true });
    }
}
const envKeys = {
    serverURL: 'ACTUAL_SERVER_URL',
    password: 'ACTUAL_PASSWORD',
    syncId: 'ACTUAL_SYNC_ID',
    encryptionPassword: 'ACTUAL_ENCRYPTION_PASSWORD',
    apiKey: 'TYPESAFE_API_KEY',
} as const;
/** Environment configuration is complete on its own and never reads saved credentials. */
export async function resolveConfig(configFile: string, env: Environment, envFile?: string) {
    const useEnvironment = envFile !== undefined || Object.values(envKeys).some((name) => env[name] !== undefined);
    if (!useEnvironment) return { config: await readConfig(configFile), source: 'saved configuration' as const };
    const fileEnv = envFile ? parseEnv(await readFile(resolve(envFile), 'utf8')) : {};
    const config: Config = { version: 1 };
    for (const key of Object.keys(envKeys) as (keyof typeof envKeys)[]) {
        const name = envKeys[key];
        const value = env[name] ?? fileEnv[name];
        if (value !== undefined && !(key === 'encryptionPassword' && value === '')) config[key] = value;
    }
    return { config: validateConfig(config), source: 'environment' as const };
}
export function missingSettings(config: Config): string[] {
    return (['serverURL', 'password', 'syncId', 'apiKey'] as const).filter((key) => !config[key]);
}
export function budgetDataDir(root: string, config: Config): string {
    const server = config.serverURL ? new URL(config.serverURL).href.replace(/\/$/, '') : '';
    return join(
        root,
        createHash('sha256')
            .update(JSON.stringify([server, config.syncId]))
            .digest('hex'),
    );
}
export function configSummary(config: Config): string[] {
    return (Object.keys(envKeys) as (keyof typeof envKeys)[]).map((key) => {
        const value = config[key];
        const secret = ['password', 'encryptionPassword', 'apiKey'].includes(key);
        return `${key}: ${value === undefined ? '(not set)' : secret ? '[redacted]' : String(value)}`;
    });
}
