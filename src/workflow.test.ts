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
        transferPayeeIds: new Set(['transfer-payee']),
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
    const { port, updates } = fixture();
    const summary = await runCategorization(port, { mode: 'auto', threshold: 0.9 });
    assert.equal(summary.applied, 2);
    assert.equal(summary.transfersSkipped, 1);
    assert.deepEqual(
        updates.map((update) => update.id),
        ['ordinary', 'child-1'],
    );
    assert.deepEqual(updates[0]?.fields, { category: 'groceries' });
    assert.deepEqual(updates[1]?.fields, { category: 'groceries' });
});

void test('dry-run simulates auto without any writes', async () => {
    const { port, updates } = fixture();
    const summary = await runCategorization(port, { mode: 'dry-run', threshold: 0.9 });
    assert.equal(summary.wouldApply, 2);
    assert.deepEqual(updates, []);
});

void test('weak suggestions are skipped automatically but can be chosen interactively', async () => {
    const { port, updates } = fixture(0.4);
    const automatic = await runCategorization(port, { mode: 'auto', threshold: 0.9 });
    assert.equal(automatic.applied, 0);
    port.choose = (transaction) => Promise.resolve(transaction.id === 'ordinary' ? 'groceries' : null);
    const interactive = await runCategorization(port, { mode: 'interactive', threshold: 0.9 });
    assert.equal(interactive.applied, 1);
    assert.deepEqual(
        updates.map((update) => update.id),
        ['ordinary'],
    );
});
