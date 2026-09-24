import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createActualClassifier, type ActualClient, type ActualTransaction } from './actual.js';
import type { JevChoiceClient } from './classifier.js';

void test('loads and refreshes the catalog and payees while preserving transaction mapping', async () => {
    let revision = 1;
    let loads = 0;
    const states: Array<{ transaction: { payee: string } }> = [];
    const actual: ActualClient = {
        getCategoryGroups(options) {
            assert.deepEqual(options, { hidden: false });
            loads++;
            return Promise.resolve([
                {
                    id: 'group',
                    name: 'Income',
                    is_income: true,
                    categories: [{ id: `category-${revision}`, name: 'Salary', group_id: 'group' }],
                },
            ]);
        },
        getPayees() {
            return Promise.resolve([{ id: 'employer', name: `Employer ${revision}` }]);
        },
        getNote() {
            return Promise.resolve(null);
        },
    };
    const client: JevChoiceClient = {
        systemOne(request) {
            assert.equal(request.model, 'custom-model');
            assert.equal(request.questions.category.criteria.category_0, 'Income / Salary (income)');
            states.push(request.state as { transaction: { payee: string } });
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
    const classifier = await createActualClassifier(actual, { client, model: 'custom-model' });
    const transaction = {
        payee: 'employer',
        imported_payee: 'Deposit',
        notes: 'Monthly',
        amount: 10000,
        date: '2026-09-01',
        accountName: 'Checking',
    };
    assert.equal((await classifier.classify(transaction)).categoryId, 'category-1');
    assert.deepEqual(states[0], {
        transaction: {
            payee: 'Employer 1',
            imported_payee: 'Deposit',
            notes: 'Monthly',
            amount_minor_units: 10000,
            date: '2026-09-01',
            account: 'Checking',
        },
        payee_default_category: null,
        relevant_examples: [],
    });
    await classifier.classify({ ...transaction, payee_name: 'Explicit name' });
    assert.equal(states[1]?.transaction.payee, 'Explicit name');
    assert.equal(loads, 1);
    revision = 2;
    await classifier.refresh();
    assert.equal(loads, 2);
    assert.equal(classifier.categories[0]?.id, 'category-2');
    assert.equal((await classifier.classify(transaction)).categoryId, 'category-2');
    assert.equal(states[2]?.transaction.payee, 'Employer 2');
});

void test('loads category notes and builds examples only from eligible categorized history', async () => {
    const notes: string[] = [];
    const actual: ActualClient = {
        getCategoryGroups: () =>
            Promise.resolve([
                {
                    id: 'food',
                    name: 'Food',
                    categories: [
                        { id: 'groceries', name: 'Groceries', group_id: 'food' },
                        { id: 'restaurants', name: 'Restaurants', group_id: 'food' },
                    ],
                },
            ]),
        getPayees: () =>
            Promise.resolve([
                { id: 'shop', name: 'Fresh Market' },
                { id: 'transfer', name: 'Transfer', transfer_acct: 'other' },
            ]),
        getNote(id) {
            notes.push(id);
            return Promise.resolve(
                id === 'restaurants' ? { id, note: '#template 250\nPrepared deli meals\n#goal 1000' } : null,
            );
        },
    };
    const base = { account: 'checking', date: '2026-09-01', amount: -1000 };
    const history = [
        {
            ...base,
            id: 'parent',
            payee: 'shop',
            subtransactions: [
                { ...base, id: 'grocery', category: 'groceries', is_child: true, notes: 'Produce' },
                { ...base, id: 'deli', category: 'restaurants', is_child: true, notes: 'Deli lunch' },
            ],
        },
        { ...base, id: 'transfer', payee: 'transfer', category: 'groceries' },
        { ...base, id: 'tracking', account: 'tracking', payee: 'shop', category: 'groceries' },
        { ...base, id: 'uncategorized', payee: 'shop' },
    ] as ActualTransaction[];
    const client: JevChoiceClient = {
        systemOne(request) {
            assert.equal(
                request.questions.category.criteria.category_1,
                'Food / Restaurants. Category note: Prepared deli meals',
            );
            const state = request.state as { relevant_examples: Array<{ notes: string; category: string }> };
            assert.deepEqual(
                state.relevant_examples.map((example) => [example.notes, example.category]),
                [
                    ['Produce', 'category_0'],
                    ['Deli lunch', 'category_1'],
                ],
            );
            return Promise.resolve({
                answers: {
                    category: {
                        choice: 'category_1',
                        confidence: 0.9,
                        probabilities: { category_0: 0.1, category_1: 0.9, none_of_the_above: 0 },
                    },
                },
            });
        },
    };
    const classifier = await createActualClassifier(actual, {
        client,
        history,
        eligibleAccountIds: new Set(['checking']),
    });
    assert.deepEqual(notes, ['groceries', 'restaurants']);
    assert.equal((await classifier.classify({ ...base, id: 'new', payee: 'shop' })).requiresReview, true);
});
