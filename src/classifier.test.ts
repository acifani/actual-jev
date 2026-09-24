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

void test('rejects malformed confidences and probabilities', async () => {
    for (const value of [NaN, Infinity, -0.1, 1.1, undefined, '0.5', null]) {
        for (const field of ['confidence', 'category_0', 'none_of_the_above']) {
            const client: JevChoiceClient = {
                async systemOne(request) {
                    const response = await mock('category_0').systemOne(request);
                    if (field === 'confidence') Object.assign(response.answers.category, { confidence: value });
                    else Object.assign(response.answers.category.probabilities, { [field]: value });
                    return response;
                },
            };
            const message =
                field === 'confidence'
                    ? 'confidence'
                    : field === 'category_0'
                      ? 'probability for category_0'
                      : 'no-match probability';
            await assert.rejects(classifyTransaction({ importedPayee: 'Fresh Market' }, categories, { client }), {
                message: `Jev returned an invalid ${message}`,
            });
        }
    }
});

void test('validates category IDs, labels, and limits before contacting Jev', async () => {
    const client: JevChoiceClient = {
        systemOne: () => {
            throw new Error('Unexpected request');
        },
    };
    for (const invalid of [
        [categories[0]!, categories[0]!],
        [{ id: '', name: 'Food', groupName: 'Living' }],
        [{ id: 'food', name: '', groupName: 'Living' }],
        [{ id: 'food', name: 'Food', groupName: '' }],
    ]) {
        await assert.rejects(classifyTransaction({}, invalid, { client }), TypeError);
    }
    const tooMany = Array.from({ length: 255 }, (_, i) => ({ id: `${i}`, name: 'Category', groupName: 'Group' }));
    await assert.rejects(classifyTransaction({}, tooMany, { client }), RangeError);
});

void test('accepts the category limit, forwards state and model, and ranks by probability', async () => {
    const catalog = Array.from({ length: 254 }, (_, i) => ({
        id: `${i}`,
        name: `Category ${i}`,
        groupName: 'Group',
        isIncome: i === 253,
    }));
    const client: JevChoiceClient = {
        systemOne(request) {
            assert.equal(request.model, 'custom-model');
            assert.deepEqual(request.state, {
                payee: 'Employer',
                imported_payee: null,
                notes: 'Salary',
                amount_minor_units: 10000,
                date: '2026-09-01',
                account: 'Checking',
            });
            assert.equal(Object.keys(request.questions.category.criteria).length, 255);
            assert.equal(request.questions.category.criteria.category_253, 'Group / Category 253 (income)');
            return Promise.resolve({
                answers: {
                    category: {
                        choice: 'category_253',
                        confidence: 1,
                        probabilities: {
                            ...Object.fromEntries(catalog.map((_, i) => [`category_${i}`, i === 253 ? 1 : 0])),
                            none_of_the_above: 0,
                        },
                    },
                },
            });
        },
    };
    const result = await classifyTransaction(
        { payeeName: 'Employer', notes: 'Salary', amount: 10000, date: '2026-09-01', accountName: 'Checking' },
        catalog,
        { client, model: 'custom-model' },
    );
    assert.equal(result.categoryId, '253');
    assert.equal(result.candidates[0]?.id, '253');
    assert.equal(result.confidence, 1);
});
