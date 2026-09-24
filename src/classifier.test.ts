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
            assert.equal(
                (request.state as { transaction: { imported_payee: string } }).transaction.imported_payee,
                'Fresh Market',
            );
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
                transaction: {
                    payee: 'Employer',
                    imported_payee: null,
                    notes: 'Salary',
                    amount_minor_units: 10000,
                    date: '2026-09-01',
                    account: 'Checking',
                },
                payee_default_category: null,
                relevant_examples: [],
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

void test('uses contrasting history and notes, but requires review for a mixed-payee history', async () => {
    const catalog = [
        { id: 'groceries', name: 'Groceries', groupName: 'Food', note: 'Food to prepare at home' },
        { id: 'restaurants', name: 'Restaurants', groupName: 'Food', note: 'Prepared meals and deli lunches' },
    ];
    const examples = [
        {
            id: 'old-grocery',
            categoryId: 'groceries',
            payeeName: 'Fresh Market',
            notes: 'Weekly groceries',
            amount: -6200,
        },
        { id: 'old-lunch', categoryId: 'restaurants', payeeName: 'Fresh Market', notes: 'Deli lunch', amount: -1300 },
        { id: 'self', categoryId: 'groceries', payeeName: 'Fresh Market', notes: 'Self' },
        { id: 'hidden', categoryId: 'hidden', payeeName: 'Fresh Market', notes: 'Hidden' },
    ];
    const client: JevChoiceClient = {
        systemOne(request) {
            const description = request.questions.category.criteria.category_1;
            assert.equal(typeof description, 'string');
            assert.match(description as string, /Prepared meals and deli lunches/);
            const state = request.state as {
                payee_default_category: string;
                relevant_examples: Array<{ notes: string; category: string }>;
            };
            assert.equal(state.payee_default_category, 'category_0');
            assert.deepEqual(
                state.relevant_examples.map((example) => [example.notes, example.category]),
                [
                    ['Deli lunch', 'category_1'],
                    ['Weekly groceries', 'category_0'],
                ],
            );
            return Promise.resolve({
                answers: {
                    category: {
                        choice: 'category_1',
                        confidence: 0.99,
                        probabilities: { category_0: 0.01, category_1: 0.99, none_of_the_above: 0 },
                    },
                },
            });
        },
    };
    const result = await classifyTransaction(
        {
            id: 'self',
            payeeName: 'Fresh Market',
            notes: 'Lunch sandwich',
            amount: -1450,
            payeeDefaultCategoryId: 'groceries',
        },
        catalog,
        { client, examples },
    );
    assert.equal(result.categoryId, 'restaurants');
    assert.equal(result.requiresReview, true);
});

void test('keeps history bounded and ignores irrelevant examples', async () => {
    const examples = Array.from({ length: 30 }, (_, i) => ({
        categoryId: i % 2 ? 'travel-id' : 'food-id',
        payeeName: 'Fresh Market',
        notes: `Visit ${i}`,
    }));
    examples.push({ categoryId: 'travel-id', payeeName: 'Other Store', notes: 'Unrelated' });
    const client: JevChoiceClient = {
        systemOne(request) {
            const state = request.state as { relevant_examples: Array<{ payee: string }> };
            assert.equal(state.relevant_examples.length, 6);
            assert.ok(state.relevant_examples.every((example) => example.payee === 'Fresh Market'));
            return mock('category_0').systemOne(request);
        },
    };
    await classifyTransaction({ payeeName: 'Fresh Market', importedPayee: 'Fresh Market' }, categories, {
        client,
        examples,
    });
});

void test('honors the per-category limit, including zero', async () => {
    const examples = Array.from({ length: 8 }, (_, i) => ({
        id: `example-${i}`,
        categoryId: i % 2 ? 'travel-id' : 'food-id',
        payeeName: 'Fresh Market',
    }));
    const lengths: number[] = [];
    const client: JevChoiceClient = {
        systemOne(request) {
            const state = request.state as { relevant_examples: unknown[] };
            lengths.push(state.relevant_examples.length);
            return Promise.resolve({
                answers: {
                    category: {
                        choice: 'category_0',
                        confidence: 0.8,
                        probabilities: { category_0: 0.8, category_1: 0.1, none_of_the_above: 0.1 },
                    },
                },
            });
        },
    };
    const transaction = { importedPayee: 'Fresh Market' };
    await classifyTransaction(transaction, categories, { client, examples, maxExamplesPerCategory: 2 });
    await classifyTransaction(transaction, categories, { client, examples, maxExamplesPerCategory: 0 });
    assert.deepEqual(lengths, [4, 0]);
    await assert.rejects(
        classifyTransaction(transaction, categories, { client, maxExamplesPerCategory: -1 }),
        RangeError,
    );
});

void test('includes relevant examples from all 20 categories without a total cap', async () => {
    const catalog = Array.from({ length: 20 }, (_, index) => ({
        id: `category-id-${index}`,
        name: `Category ${index}`,
        groupName: 'Group',
    }));
    const examples = catalog.map((category) => ({ categoryId: category.id, payeeName: 'Shared Shop' }));
    const client: JevChoiceClient = {
        systemOne(request) {
            const state = request.state as { relevant_examples: Array<{ category: string }> };
            assert.equal(state.relevant_examples.length, 20);
            assert.equal(new Set(state.relevant_examples.map((example) => example.category)).size, 20);
            assert.equal(Object.keys(request.questions.category.criteria).length, 21);
            return Promise.resolve({
                answers: {
                    category: {
                        choice: 'category_0',
                        confidence: 1,
                        probabilities: {
                            ...Object.fromEntries(
                                catalog.map((_, index) => [`category_${index}`, index === 0 ? 1 : 0]),
                            ),
                            none_of_the_above: 0,
                        },
                    },
                },
            });
        },
    };
    await classifyTransaction({ payeeName: 'Shared Shop' }, catalog, { client, examples });
});
