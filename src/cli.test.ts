import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveConfig, userPaths, type Environment } from './config.js';

void test('CLI works outside the project with saved settings and fixture clients', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'jev-cli-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const first = join(root, 'first');
    const second = join(root, 'second');
    await Promise.all([mkdir(first), mkdir(second)]);
    // Deliberately do not inherit any Actual or TypeSafe credentials from the environment.
    const env = {
        PATH: process.env.PATH,
        HOME: root,
        USERPROFILE: root,
        XDG_CONFIG_HOME: join(root, 'config'),
        XDG_DATA_HOME: join(root, 'data'),
        APPDATA: join(root, 'roaming'),
        LOCALAPPDATA: join(root, 'local'),
        FIXTURE_LOG: join(root, 'calls.json'),
    };
    const hooks = join(root, 'hooks.mjs');
    await writeFile(
        hooks,
        `import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from ${JSON.stringify(import.meta.resolve('typescript'))};
const actual = ${JSON.stringify(`
import { writeFile } from 'node:fs/promises';
export async function init(options) {
    if (options.password !== 'fixture-password') throw new Error('Incorrect resolved password');
    await writeFile(process.env.FIXTURE_LOG, JSON.stringify(options));
}
export async function downloadBudget(id) { if (id !== 'fixture-budget') throw new Error('Incorrect budget'); }
export async function sync() {}
export async function shutdown() {}
export async function getAccounts() { return []; }
export async function getPayees() { return []; }
export async function getCategoryGroups() { return []; }
export async function getNote() { return {}; }
export async function aqlQuery() { return { data: [] }; }
export function q() { return { select() { return this; }, options() { return this; } }; }
export async function updateTransaction() { throw new Error('Unexpected write'); }
`)};
const sdk = "export function choice() { throw new Error('Unexpected classification'); } export class TypeSafeClient { constructor(config) { if (config.apiKey !== 'fixture-key') throw new Error('Incorrect resolved API key'); } }";
registerHooks({ resolve(specifier, context, next) {
    if (specifier === '@actual-app/api' || specifier === '@typesafe-ai/sdk') return { url: 'data:text/javascript,' + encodeURIComponent(specifier === '@actual-app/api' ? actual : sdk), shortCircuit: true };
    if (context.parentURL?.endsWith('.ts') && specifier.startsWith('./') && specifier.endsWith('.js')) return next(specifier.slice(0, -3) + '.ts', context);
    return next(specifier, context);
}, load(url, context, next) {
    if (url.endsWith('.ts')) return { format: 'module', source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 } }).outputText, shortCircuit: true };
    return next(url, context);
} });`,
    );
    const entry = process.env.JEV_TEST_CLI_ENTRY ?? fileURLToPath(new URL('./cli.ts', import.meta.url));
    const run = async (args: string[], cwd = first, connection: Environment = {}) => {
        const outputPath = join(root, 'stdout');
        const errorPath = join(root, 'stderr');
        const out = openSync(outputPath, 'w');
        const err = openSync(errorPath, 'w');
        let code: number | null;
        try {
            code = await new Promise<number | null>((resolve, reject) => {
                const child = spawn(process.execPath, ['--import', hooks, entry, ...args], {
                    cwd,
                    env: { ...env, ...connection },
                    stdio: ['ignore', out, err],
                });
                child.once('error', reject);
                child.once('close', resolve);
            });
        } finally {
            closeSync(out);
            closeSync(err);
        }
        const stdout = await readFile(outputPath, 'utf8');
        const stderr = await readFile(errorPath, 'utf8');
        if (code !== 0) throw new Error(stderr || `CLI exited with ${code}`);
        return { stdout, stderr };
    };
    const help = await run(['--help']);
    assert.match(help.stdout, /actual-jev setup/);
    await assert.rejects(
        run(['--dry-run']),
        (error) => error instanceof Error && error.message.includes('Missing configuration'),
    );
    await assert.rejects(
        run(['setup']),
        (error) => error instanceof Error && error.message.includes('requires a terminal'),
    );
    await saveConfig(userPaths(env, process.platform, root).configFile, {
        version: 1,
        serverURL: 'https://fixture.example',
        password: 'fixture-password',
        syncId: 'fixture-budget',
        apiKey: 'fixture-key',
        maxExamplesPerCategory: 2,
    });
    await writeFile(join(first, '.env'), 'ACTUAL_PASSWORD=wrong\nTYPESAFE_API_KEY=wrong');
    const output = (await run(['--dry-run'])).stdout;
    assert.match(output, /Examined 0; applied 0/);
    const firstLog = await readFile(env.FIXTURE_LOG, 'utf8');
    await run(['--dry-run'], second);
    assert.equal(await readFile(env.FIXTURE_LOG, 'utf8'), firstLog);
    const summary = (await run(['config', 'show'])).stdout;
    assert.match(summary, /saved configuration/);
    assert.ok(!summary.includes('fixture-password') && !summary.includes('fixture-key'));
    assert.match(summary, /maxExamplesPerCategory: 2/);
    const flags = (await run(['config', 'show', '--threshold', '0.6', '--max-examples-per-category', '0'])).stdout;
    assert.match(flags, /threshold: 0.6/);
    assert.match(flags, /maxExamplesPerCategory: 0/);
    const connection = {
        ACTUAL_SERVER_URL: 'https://fixture.example',
        ACTUAL_PASSWORD: 'fixture-password',
        ACTUAL_SYNC_ID: 'fixture-budget',
        TYPESAFE_API_KEY: 'fixture-key',
    };
    await assert.rejects(run(['--dry-run'], first, { TYPESAFE_API_KEY: 'fixture-key' }), /Saved settings are not used/);
    const envFile = join(root, 'automation.env');
    await writeFile(
        envFile,
        Object.entries(connection)
            .map(([key, value]) => `${key}=${value}`)
            .join('\n'),
    );
    // Automation does not even read the personal config, including when it is malformed.
    await writeFile(userPaths(env, process.platform, root).configFile, 'invalid JSON');
    assert.match((await run(['--dry-run'], first, connection)).stdout, /Examined 0; applied 0/);
    assert.match((await run(['--env-file', envFile, '--dry-run'])).stdout, /Examined 0; applied 0/);
    const exportedSummary = (await run(['config', 'show'], first, connection)).stdout;
    const fileSummary = (await run(['config', 'show', '--env-file', envFile])).stdout;
    assert.equal(fileSummary, exportedSummary);
    assert.match(fileSummary, /Configuration: environment/);
    assert.match(fileSummary, /maxExamplesPerCategory: 3/);
});
