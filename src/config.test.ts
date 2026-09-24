import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    budgetDataDir,
    configSummary,
    missingSettings,
    readConfig,
    resolveConfig,
    saveConfig,
    userPaths,
    validateConfig,
    type Config,
} from './config.js';

const saved: Config = {
    version: 1,
    serverURL: 'https://actual.example',
    password: ' secret ',
    syncId: 'budget',
    apiKey: 'test-key',
    maxExamplesPerCategory: 2,
};
void test('saved and environment configurations are independent', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'jev-config-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const configFile = join(dir, 'config.json');
    await saveConfig(configFile, { ...saved, encryptionPassword: 'saved-encryption' });
    const personal = await resolveConfig(configFile, {});
    assert.equal(personal.source, 'saved configuration');
    assert.equal(personal.config.maxExamplesPerCategory, 2);
    assert.equal(personal.config.apiKey, saved.apiKey);
    const partial = await resolveConfig(configFile, { ACTUAL_SERVER_URL: 'https://automation.example' });
    assert.equal(partial.source, 'environment');
    assert.deepEqual(missingSettings(partial.config), ['password', 'syncId', 'apiKey']);
    assert.equal(partial.config.encryptionPassword, undefined);
    assert.equal(partial.config.maxExamplesPerCategory, undefined);
    const envFile = join(dir, 'test.env');
    await writeFile(
        envFile,
        'ACTUAL_SERVER_URL=https://automation.example\nACTUAL_PASSWORD="file password"\nACTUAL_SYNC_ID=automation-budget\nTYPESAFE_API_KEY=automation-key\nACTUAL_ENCRYPTION_PASSWORD=',
    );
    const file = await resolveConfig(configFile, {}, envFile);
    const exported = await resolveConfig(configFile, {
        ACTUAL_SERVER_URL: 'https://automation.example',
        ACTUAL_PASSWORD: 'file password',
        ACTUAL_SYNC_ID: 'automation-budget',
        TYPESAFE_API_KEY: 'automation-key',
        ACTUAL_ENCRYPTION_PASSWORD: '',
    });
    assert.deepEqual(file, exported);
    assert.deepEqual(missingSettings(file.config), []);
    assert.equal(
        (await resolveConfig(configFile, { ACTUAL_PASSWORD: 'exported' }, envFile)).config.password,
        'exported',
    );
    await writeFile(configFile, 'invalid JSON');
    assert.deepEqual(await resolveConfig(configFile, {}, envFile), file);
    await assert.rejects(resolveConfig(configFile, {}), /Invalid configuration/);
    await assert.rejects(resolveConfig(configFile, {}, join(dir, 'missing.env')), /ENOENT/);
    await writeFile(envFile, '# An empty file must not fall back to saved credentials');
    assert.deepEqual(missingSettings((await resolveConfig(configFile, {}, envFile)).config), [
        'serverURL',
        'password',
        'syncId',
        'apiKey',
    ]);
});
void test('configuration roundtrips privately and invalid files give safe errors', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'jev-config-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, 'settings', 'config.json');
    assert.deepEqual(await readConfig(file), { version: 1 });
    await saveConfig(file, saved);
    assert.deepEqual(await readConfig(file), saved);
    await saveConfig(file, { ...saved, password: 'replacement' });
    assert.equal((await readConfig(file)).password, 'replacement');
    assert.deepEqual(await readdir(join(dir, 'settings')), ['config.json']);
    if (process.platform !== 'win32') {
        assert.equal((await stat(file)).mode & 0o777, 0o600);
        assert.equal((await stat(join(dir, 'settings'))).mode & 0o777, 0o700);
    }
    await writeFile(file, '{"password":"sensitive",oops');
    await assert.rejects(
        readConfig(file),
        (error) => error instanceof Error && error.message.includes(file) && !error.message.includes('sensitive'),
    );
    await writeFile(file, JSON.stringify({ version: 2 }));
    await assert.rejects(readConfig(file), /Unsupported configuration version/);
    assert.match(await readFile(file, 'utf8'), /version/);
});
void test('validation and redaction keep secrets out of displays', () => {
    for (const value of [
        { version: 1, threshold: 2 },
        { version: 1, serverURL: 'ftp://example.com' },
        { version: 1, serverURL: 'https://user:secret@example.com' },
        { version: 1, apiKey: '' },
        { version: 1, typo: true },
    ])
        assert.throws(() => validateConfig(value));
    const output = configSummary({ ...saved, encryptionPassword: 'encrypted-secret' }).join('\n');
    for (const value of [' secret ', 'test-key', 'encrypted-secret']) assert.ok(!output.includes(value));
    assert.match(output, /password: \[redacted\]/);
    assert.match(output, /https:\/\/actual.example/);
});
void test('platform paths and budget cache identity are independent of working directory', () => {
    assert.equal(userPaths({}, 'linux', '/users/test').configFile, '/users/test/.config/actual-jev/config.json');
    assert.equal(
        userPaths({ XDG_CONFIG_HOME: '/config', XDG_DATA_HOME: '/data' }, 'linux', '/home/test').dataRoot,
        '/data/actual-jev/budgets',
    );
    assert.match(userPaths({}, 'darwin', '/users/test').configFile, /Library\/Application Support\/actual-jev/);
    assert.match(
        userPaths({ APPDATA: '/roaming', LOCALAPPDATA: '/local' }, 'win32', '/test').configFile,
        /roaming\/actual-jev/,
    );
    const root = '/data/budgets';
    assert.equal(budgetDataDir(root, saved), budgetDataDir(root, { ...saved, serverURL: `${saved.serverURL}/` }));
    assert.notEqual(budgetDataDir(root, saved), budgetDataDir(root, { ...saved, syncId: 'other' }));
    assert.notEqual(budgetDataDir(root, saved), budgetDataDir(root, { ...saved, serverURL: 'https://other.example' }));
});
