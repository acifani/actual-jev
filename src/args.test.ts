import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs } from './args.js';

void test('defaults to interactive and supports every option', () => {
    assert.deepEqual(parseArgs([]), {
        mode: 'interactive',
        threshold: 0.9,
        account: undefined,
        from: undefined,
        to: undefined,
        dataDir: '.actual-data',
        help: false,
    });
    assert.deepEqual(
        parseArgs([
            '--auto',
            '--threshold',
            '0',
            '--account',
            'Checking',
            '--from',
            '2024-02-29',
            '--to',
            '2024-03-01',
            '--data-dir',
            '/tmp/budget',
            '-h',
        ]),
        {
            mode: 'auto',
            threshold: 0,
            account: 'Checking',
            from: '2024-02-29',
            to: '2024-03-01',
            dataDir: '/tmp/budget',
            help: true,
        },
    );
    assert.equal(parseArgs(['--dry-run', '--threshold', '1']).mode, 'dry-run');
    assert.equal(parseArgs(['--interactive', '--help']).help, true);
});

void test('repeated value flags use their last value, but repeated modes are errors', () => {
    assert.equal(parseArgs(['--threshold', '0.2', '--threshold', '1']).threshold, 1);
    assert.equal(parseArgs(['--account', 'first', '--account', 'second']).account, 'second');
    for (const modes of [
        ['--auto', '--auto'],
        ['--interactive', '--dry-run'],
    ]) {
        assert.throws(() => parseArgs(modes), /Choose only one mode/);
    }
});

void test('validates values and unknown options even when help is requested', () => {
    for (const flag of ['--threshold', '--account', '--from', '--to', '--data-dir']) {
        for (const tail of [[], [''], ['--help']]) {
            assert.throws(() => parseArgs([flag, ...tail]), /requires a value/);
        }
    }
    for (const value of ['NaN', 'Infinity', '-0.1', '1.1']) {
        assert.throws(() => parseArgs(['--threshold', value]), /between 0 and 1/);
    }
    for (const value of ['2025-02-29', '2026-04-31', '2026-13-01', '2026-1-01']) {
        assert.throws(() => parseArgs(['--from', value]), /valid YYYY-MM-DD/);
    }
    assert.throws(() => parseArgs(['--from', '2026-09-02', '--to', '2026-09-01']), /on or before/);
    assert.throws(() => parseArgs(['--help', '--unknown']), /Unknown option/);
    // A short flag is accepted as a string value, matching the original parser.
    assert.equal(parseArgs(['--account', '-h']).account, '-h');
});
