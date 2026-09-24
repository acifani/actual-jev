import assert from 'node:assert/strict';
import { test } from 'node:test';
import { q } from '@actual-app/api';
import { ActualJev, type ActualDataClient, type ActualTransaction } from './actual.js';
import type { JevChoiceClient } from './classifier.js';

function jev(states: unknown[]): JevChoiceClient {
    return {
        systemOne(request) {
            states.push(request.state);
            return Promise.resolve({
                answers: {
                    category: {
                        choice: 'category_0',
                        confidence: 0.9,
                        probabilities: { category_0: 0.9, none_of_the_above: 0.1 },
                    },
                },
            });
        },
    };
}

void test('loads Actual data once on concurrent first calls and refreshes the snapshot', async () => {
    let revision = 1;
    let queries = 0;
    const states: unknown[] = [];
    const actual: ActualDataClient = {
        q,
        aqlQuery(query) {
            assert.equal(query.state.table, 'transactions');
            queries++;
            return Promise.resolve({
                data: [
                    {
                        id: 'old',
                        account: 'checking',
                        date: '2026-09-01',
                        amount: -1000,
                        payee: 'shop',
                        category: `category-${revision}`,
                    },
                    {
                        id: 'tracking',
                        account: 'tracking',
                        date: '2026-09-01',
                        amount: -1000,
                        payee: 'shop',
                        category: `category-${revision}`,
                    },
                ] as ActualTransaction[],
            });
        },
        getAccounts: () =>
            Promise.resolve([
                { id: 'checking', name: 'Checking', offbudget: false },
                { id: 'tracking', name: 'Tracking', offbudget: true },
            ] as Awaited<ReturnType<ActualDataClient['getAccounts']>>),
        getCategoryGroups: () =>
            Promise.resolve([
                {
                    id: 'food',
                    name: 'Food',
                    categories: [{ id: `category-${revision}`, name: 'Groceries', group_id: 'food' }],
                },
            ]),
        getPayees: () => Promise.resolve([{ id: 'shop', name: 'Fresh Market' }]),
        getNote: () => Promise.resolve(null),
    };
    const classifier = new ActualJev({ actual, jev: jev(states) });
    assert.deepEqual(classifier.categories, []);
    const input = { id: 'new', account: 'checking', payee: 'shop', amount: -2350 };
    const results = await Promise.all([classifier.classify(input), classifier.classify(input)]);
    assert.equal(queries, 1);
    assert.deepEqual(
        results.map((result) => result.categoryId),
        ['category-1', 'category-1'],
    );
    const state = states[0] as { transaction: { account: string; payee: string }; relevant_examples: unknown[] };
    assert.equal(state.transaction.account, 'Checking');
    assert.equal(state.transaction.payee, 'Fresh Market');
    assert.equal(state.relevant_examples.length, 1);
    revision = 2;
    await classifier.refresh();
    assert.equal(queries, 2);
    assert.equal((await classifier.classify(input)).categoryId, 'category-2');
});

void test('retries a failed Actual load', async () => {
    let queries = 0;
    const actual: ActualDataClient = {
        q,
        aqlQuery() {
            queries++;
            if (queries === 1) return Promise.reject(new Error('query failed'));
            return Promise.resolve({ data: [] });
        },
        getAccounts: () => Promise.resolve([]),
        getCategoryGroups: () => Promise.resolve([]),
        getPayees: () => Promise.resolve([]),
        getNote: () => Promise.resolve(null),
    };
    const classifier = new ActualJev({ actual, jev: jev([]) });
    await assert.rejects(classifier.classify({}), /query failed/);
    assert.equal((await classifier.classify({})).categoryId, null);
    assert.equal(queries, 2);
});

void test('uses manual constructor data without an Actual client', async () => {
    const states: unknown[] = [];
    const classifier = new ActualJev({
        jev: jev(states),
        categories: [{ id: 'groceries', name: 'Groceries', groupName: 'Food' }],
        examples: [{ categoryId: 'groceries', payeeName: 'Fresh Market' }],
    });
    await classifier.refresh();
    const result = await classifier.classify({ payeeName: 'Fresh Market', amount: -2350 });
    assert.equal(result.categoryId, 'groceries');
    assert.equal((states[0] as { relevant_examples: unknown[] }).relevant_examples.length, 1);
});
