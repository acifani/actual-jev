import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyTransaction, type JevChoiceClient } from './classifier.js';

const categories = [
    { id: 'food-id', name: 'Groceries', groupName: 'Food' },
    { id: 'travel-id', name: 'Train', groupName: 'Travel' },
];

function mock(choice: string, confidence = 0.8): JevChoiceClient {
    return {
        systemOne(request) {
            assert.equal(request.model, 'jev-latest');
            assert.equal(request.questions.category.criteria.category_0, 'Food / Groceries');
            assert.equal(request.state.imported_payee, 'Fresh Market');
            return Promise.resolve({
                answers: {
                    category: {
                        choice,
                        confidence,
                        probabilities: { category_0: 0.7, category_1: 0.2, none_of_the_above: 0.1 },
                    },
                },
            });
        },
    };
}

void test('maps Jev options back to category IDs and ranks alternatives', async () => {
    const result = await classifyTransaction({ importedPayee: 'Fresh Market', amount: -2300 }, categories, {
        client: mock('category_0'),
    });
    assert.equal(result.categoryId, 'food-id');
    assert.equal(result.confidence, 0.8);
    assert.deepEqual(
        result.candidates.map((candidate) => candidate.id),
        ['food-id', 'travel-id'],
    );
});

void test('returns no-match without inventing a category', async () => {
    const result = await classifyTransaction({ importedPayee: 'Fresh Market' }, categories, {
        client: mock('none_of_the_above'),
    });
    assert.equal(result.categoryId, null);
    assert.equal(result.noMatchProbability, 0.1);
});

void test('rejects selections that were not offered', async () => {
    await assert.rejects(
        classifyTransaction({ importedPayee: 'Fresh Market' }, categories, { client: mock('category_999') }),
        /unknown category option/,
    );
});

void test('does not call Jev when no categories are available', async () => {
    const result = await classifyTransaction({}, [], { client: mock('category_0') });
    assert.equal(result.categoryId, null);
});
