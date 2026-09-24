import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readConfig, saveConfig, type Config } from './config.js';
import { runSetup, type SetupPort } from './setup.js';

function fixture(encrypted = false) {
    const calls: string[] = [];
    const port: SetupPort = {
        input: () => Promise.resolve('https://actual.example'),
        secret: (message) => {
            calls.push(message);
            return Promise.resolve('fixture-secret');
        },
        select: (message, choices) => {
            calls.push(message);
            return Promise.resolve(choices[0]!.value);
        },
        print: (message) => calls.push(message),
        actual: {
            init: () => {
                calls.push('init');
                return Promise.resolve();
            },
            getBudgets: () =>
                Promise.resolve([
                    { name: 'Unsynced', cloudFileId: 'unsynced-file', groupId: null },
                    {
                        name: 'Household',
                        cloudFileId: 'cloud-file',
                        groupId: 'budget',
                        encryptKeyId: encrypted ? 'encryption-key' : null,
                    },
                ]),
            downloadBudget: (syncId, options) => {
                assert.equal(syncId, 'budget', 'downloadBudget requires groupId, not cloudFileId');
                calls.push(`download:${options.password ?? 'none'}`);
                return Promise.resolve();
            },
            shutdown: () => {
                calls.push('shutdown');
                return Promise.resolve();
            },
        },
    };
    return { port, calls };
}
void test('setup opens and saves the sync ID rather than the cloud file ID, including encrypted budgets', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'jev-setup-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    for (const encrypted of [false, true]) {
        const { port, calls } = fixture(encrypted);
        const file = join(dir, `config-${encrypted}.json`);
        await runSetup({ version: 1 }, file, port);
        const config = await readConfig(file);
        assert.equal(config.syncId, 'budget');
        assert.equal(config.apiKey, 'fixture-secret');
        assert.equal(config.encryptionPassword, encrypted ? 'fixture-secret' : undefined);
        assert.ok(calls.includes('shutdown'));
        assert.ok(calls.some((line) => line.includes('Budget: Household')));
    }
});
void test('updates keep saved secrets and deduplicate budget choices', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'jev-setup-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, 'config.json');
    const saved: Config = {
        version: 1,
        serverURL: 'https://actual.example',
        password: 'old-password',
        apiKey: 'old-key',
        syncId: 'budget',
        encryptionPassword: 'old-encryption',
        maxExamplesPerCategory: 2,
    };
    const { port } = fixture(true);
    port.actual.getBudgets = () =>
        Promise.resolve([
            { name: 'Home', cloudFileId: 'cloud-file', groupId: 'budget', encryptKeyId: 'key' },
            { name: 'Home', cloudFileId: 'cloud-file', groupId: 'budget', encryptKeyId: 'key' },
        ]);
    port.select = (message, choices, initial) => {
        if (message === 'Choose your budget') {
            assert.equal(choices.length, 1);
            assert.equal(choices[0]!.value, 'budget');
            assert.equal(initial, 'budget');
        }
        return Promise.resolve(choices[0]!.value);
    };
    port.secret = () => {
        throw new Error('Should retain saved secret');
    };
    await runSetup(saved, file, port);
    assert.deepEqual(await readConfig(file), saved);
});
void test('cancellation and connection failures preserve saved configuration', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'jev-setup-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, 'config.json');
    const saved: Config = { version: 1, apiKey: 'old-key' };
    await saveConfig(file, saved);
    for (const stage of ['init', 'list', 'empty', 'download', 'cancel'] as const) {
        const { port, calls } = fixture();
        if (stage === 'init') port.actual.init = () => Promise.reject(new Error('sensitive details'));
        if (stage === 'list') port.actual.getBudgets = () => Promise.reject(new Error('sensitive details'));
        if (stage === 'empty') port.actual.getBudgets = () => Promise.resolve([]);
        if (stage === 'download') port.actual.downloadBudget = () => Promise.reject(new Error('sensitive details'));
        if (stage === 'cancel') port.select = () => Promise.reject(new Error('Cancelled'));
        await assert.rejects(
            runSetup(saved, file, port),
            (error) => error instanceof Error && !error.message.includes('sensitive details'),
        );
        assert.deepEqual(await readConfig(file), saved);
        if (stage !== 'init') assert.ok(calls.includes('shutdown'));
    }
});

void test('setup replaces credentials and clears encryption for an unencrypted budget', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'jev-setup-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const saved: Config = {
        version: 1,
        serverURL: 'https://actual.example',
        password: 'old',
        apiKey: 'old',
        syncId: 'budget',
        encryptionPassword: 'old',
    };
    const { port } = fixture();
    port.select = (_message, choices) =>
        Promise.resolve(choices.find((choice) => choice.value === 'replace')?.value ?? choices[0]!.value);
    const file = join(dir, 'config.json');
    await runSetup(saved, file, port);
    const config = await readConfig(file);
    assert.equal(config.password, 'fixture-secret');
    assert.equal(config.apiKey, 'fixture-secret');
    assert.equal(config.encryptionPassword, undefined);
});
