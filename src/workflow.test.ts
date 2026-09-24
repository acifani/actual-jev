import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActualTransaction } from './actual.js';
import { runCategorization, type WorkflowPort } from './workflow.js';

const category = { id: 'groceries', name: 'Groceries', groupName: 'Food' };
const base = { account: 'checking', date: '2026-09-01', amount: -1000 };

function fixture(confidence = 0.95) {
    const updates: Array<{ id: string; fields: Partial<ActualTransaction> }> = [];
    const lines: string[] = [];
    const port: WorkflowPort = {
        accounts: [{ id: 'checking', name: 'Checking' }],
        transactions: [
            { ...base, id: 'ordinary', payee: 'shop' },
            { ...base, id: 'transfer', payee: 'transfer-payee', transfer_id: 'other-side' },
            {
                ...base,
                id: 'split',
                is_parent: true,
                amount: -3000,
                subtransactions: [
                    { ...base, id: 'child-1', parent_id: 'split', is_child: true, amount: -1000 },
                    { ...base, id: 'child-2', parent_id: 'split', is_child: true, amount: -2000, category: 'rent' },
                ],
            },
        ],
        transferPayeeAccountIds: new Map([['transfer-payee', 'checking']]),
        payeeNames: new Map([['shop', 'shop']]),
        categories: [category],
        classify() {
            return Promise.resolve({
                categoryId: category.id,
                confidence,
                candidates: [{ ...category, probability: 0.95 }],
                noMatchProbability: 0.05,
            });
        },
        updateTransaction(id, fields) {
            updates.push({ id, fields });
            return Promise.resolve();
        },
        print(line) {
            lines.push(line);
        },
    };
    return { port, updates, lines };
}

void test('automatic mode updates ordinary transactions and only eligible split children', async () => {
    const { port, updates, lines } = fixture();
    const summary = await runCategorization(port, { mode: 'auto', threshold: 0.9 });
    assert.equal(summary.applied, 2);
    assert.equal(summary.transfersSkipped, 1);
    assert.deepEqual(
        updates.map((update) => update.id),
        ['ordinary', 'child-1'],
    );
    assert.deepEqual(updates[0]?.fields, { category: 'groceries' });
    assert.deepEqual(updates[1]?.fields, { category: 'groceries' });
    assert.equal(lines.filter((line) => /Decision\s+Applied/.test(line)).length, 2);
});

void test('skips off-budget accounts before classifying ordinary or split transactions', async () => {
    const { port, updates, lines } = fixture();
    port.accounts = [...port.accounts, { id: 'tracking', name: 'Tracking', offbudget: true }];
    port.transactions = [
        ...port.transactions,
        { ...base, id: 'off-budget', account: 'tracking' },
        {
            ...base,
            id: 'off-budget-split',
            account: 'tracking',
            is_parent: true,
            subtransactions: [{ ...base, id: 'off-budget-child', account: 'tracking', is_child: true }],
        },
    ];
    const classified: string[] = [];
    const classify = port.classify.bind(port);
    port.classify = (transaction) => {
        classified.push(transaction.id);
        return classify(transaction);
    };

    const summary = await runCategorization(port, { mode: 'auto', threshold: 0.9 });
    assert.equal(summary.examined, 2);
    assert.deepEqual(classified, ['ordinary', 'child-1']);
    assert.deepEqual(
        updates.map((update) => update.id),
        ['ordinary', 'child-1'],
    );
    assert.equal(lines.length, 2);
});

void test('categorizes on-budget transfers to off-budget accounts but skips their off-budget sides', async () => {
    const { port, updates } = fixture();
    port.accounts = [...port.accounts, { id: 'tracking', name: 'Tracking', offbudget: true }];
    port.transferPayeeAccountIds = new Map([
        ['transfer-payee', 'checking'],
        ['tracking-payee', 'tracking'],
    ]);
    port.transactions = [
        ...port.transactions,
        { ...base, id: 'to-tracking', payee: 'tracking-payee', transfer_id: 'tracking-side' },
        { ...base, id: 'tracking-side', account: 'tracking', transfer_id: 'to-tracking' },
        { ...base, id: 'to-tracking-by-id', transfer_id: 'tracking-side-by-id' },
        { ...base, id: 'tracking-side-by-id', account: 'tracking', transfer_id: 'to-tracking-by-id' },
    ];

    const summary = await runCategorization(port, { mode: 'auto', threshold: 0.9 });
    assert.equal(summary.applied, 4);
    assert.equal(summary.transfersSkipped, 1);
    assert.deepEqual(
        updates.map((update) => update.id),
        ['ordinary', 'child-1', 'to-tracking', 'to-tracking-by-id'],
    );
});

void test('dry-run simulates auto without any writes', async () => {
    const { port, updates, lines } = fixture();
    const summary = await runCategorization(port, { mode: 'dry-run', threshold: 0.9 });
    assert.equal(summary.wouldApply, 2);
    assert.deepEqual(updates, []);
    assert.equal(lines.length, 2);
    assert.deepEqual((lines[0] ?? '').split('\n').slice(0, 4), ['', '  -10.00', '  shop', '  2026-09-01 · Checking']);
    assert.match(lines[0] ?? '', /Suggestion\s+Food \/ Groceries · 95% confidence/);
    assert.match(lines[0] ?? '', /Decision\s+Would apply/);
});

void test('weak suggestions are skipped automatically but can be chosen interactively', async () => {
    const { port, updates, lines } = fixture(0.4);
    const automatic = await runCategorization(port, { mode: 'auto', threshold: 0.9 });
    assert.equal(automatic.applied, 0);
    assert.equal(lines.filter((line) => line.includes('Skipped · below threshold')).length, 2);
    port.choose = (transaction) => Promise.resolve(transaction.id === 'ordinary' ? 'groceries' : null);
    const interactive = await runCategorization(port, { mode: 'interactive', threshold: 0.9 });
    assert.equal(interactive.applied, 1);
    assert.ok(lines.some((line) => /Decision\s+Applied Food \/ Groceries/.test(line)));
    assert.ok(lines.some((line) => /Decision\s+Skipped/.test(line)));
    assert.deepEqual(
        updates.map((update) => update.id),
        ['ordinary'],
    );
});

void test('no-match decisions are visible without making writes', async () => {
    const { port, updates, lines } = fixture();
    port.classify = () =>
        Promise.resolve({ categoryId: null, confidence: 0.8, candidates: [], noMatchProbability: 0.8 });
    const summary = await runCategorization(port, { mode: 'auto', threshold: 0.9 });
    assert.equal(summary.skipped, 2);
    assert.deepEqual(updates, []);
    assert.equal(lines.filter((line) => /Suggestion\s+no match · 80% confidence/.test(line)).length, 2);
    assert.equal(lines.filter((line) => /Decision\s+Skipped · no match/.test(line)).length, 2);
});

void test('presents the merchant from a verbose card description', async () => {
    const { port, lines } = fixture(0.53);
    port.transactions = [
        {
            ...base,
            id: 'card',
            date: '2026-09-23',
            amount: -660,
            imported_payee:
                'Operazione Mastercard Del 21/09/2026 Alle Ore 08:10 Con Carta Xxxxxxxxxxxx0230 Div=Eur Importo in Divisa=6.6 / Importo in Euro=6.6 Presso Pasticceria San Marone - Transazione C-Less',
        },
    ];
    const summary = await runCategorization(port, { mode: 'dry-run', threshold: 0.9 });
    assert.equal(summary.skipped, 1);
    assert.deepEqual((lines[0] ?? '').split('\n').slice(0, 4), [
        '',
        '  -6.60',
        '  Pasticceria San Marone',
        '  2026-09-23 · Checking',
    ]);
    assert.doesNotMatch(lines[0] ?? '', /Xxxxxxxxxxxx0230/);
});

void test('wraps long unrecognized payees without dropping their text', async () => {
    const { port, lines } = fixture();
    const description = 'A long imported description with no merchant marker '.repeat(3).trim();
    port.transactions = [{ ...base, id: 'long-payee', imported_payee: description }];
    await runCategorization(port, { mode: 'dry-run', threshold: 0.9 });
    assert.ok((lines[0] ?? '').includes('\n  A long imported description'));
    assert.match(lines[0] ?? '', /merchant marker$/m);
    assert.ok((lines[0] ?? '').split('\n').filter((line) => line.includes('merchant marker')).length > 1);
});

void test('uses emphasis only for terminal output', async () => {
    const { port, lines } = fixture();
    port.color = true;
    await runCategorization(port, { mode: 'dry-run', threshold: 0.9 });
    assert.ok((lines[0] ?? '').includes('\u001b[1;36m-10.00\u001b[0m'));
    assert.ok((lines[0] ?? '').includes('\u001b[1m  shop\u001b[0m'));
    assert.ok((lines[0] ?? '').includes('\u001b[36mFood / Groceries\u001b[0m'));
});
