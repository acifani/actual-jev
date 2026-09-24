import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createActualClassifier, type ActualClient } from './actual.js';
import type { JevChoiceClient } from './classifier.js';

void test('loads and refreshes the catalog and payees while preserving transaction mapping', async () => {
    let revision = 1;
    let loads = 0;
    const states: Array<Record<string, string | number | null>> = [];
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
    };
    const client: JevChoiceClient = {
        systemOne(request) {
            assert.equal(request.model, 'custom-model');
            assert.equal(request.questions.category.criteria.category_0, 'Income / Salary (income)');
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
        payee: 'Employer 1',
        imported_payee: 'Deposit',
        notes: 'Monthly',
        amount_minor_units: 10000,
        date: '2026-09-01',
        account: 'Checking',
    });
    await classifier.classify({ ...transaction, payee_name: 'Explicit name' });
    assert.equal(states[1]?.payee, 'Explicit name');
    assert.equal(loads, 1);
    revision = 2;
    await classifier.refresh();
    assert.equal(loads, 2);
    assert.equal(classifier.categories[0]?.id, 'category-2');
    assert.equal((await classifier.classify(transaction)).categoryId, 'category-2');
    assert.equal(states[2]?.payee, 'Employer 2');
});
