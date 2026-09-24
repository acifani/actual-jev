import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Separator } from '@inquirer/search';
import { categoryChoices } from './choices.js';

const categories = [
    { id: 'groceries', name: 'Groceries', groupName: 'Food' },
    { id: 'bus', name: 'Bus', groupName: 'Transport' },
    { id: 'restaurants', name: 'Restaurants', groupName: 'Food' },
];

function labels(term?: string): string[] {
    return categoryChoices(categories, term).map((choice) =>
        choice instanceof Separator ? choice.separator : choice.name,
    );
}

void test('shows every category under its group with Skip first', () => {
    assert.deepEqual(labels(), [
        'Skip this transaction',
        '── Food ──',
        'Groceries',
        'Restaurants',
        '── Transport ──',
        'Bus',
    ]);
    const choices = categoryChoices(categories);
    assert.deepEqual(
        choices.flatMap((choice) => ('value' in choice ? [choice.value] : [])),
        [null, 'groceries', 'restaurants', 'bus'],
    );
});

void test('searches names and group names without empty group headings', () => {
    assert.deepEqual(labels('gRoC'), ['Skip this transaction', '── Food ──', 'Groceries']);
    assert.deepEqual(labels('food'), ['Skip this transaction', '── Food ──', 'Groceries', 'Restaurants']);
    assert.deepEqual(labels('absent'), ['Skip this transaction']);
});
