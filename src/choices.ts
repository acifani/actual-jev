import { Separator } from '@inquirer/search';
import type { CategoryCandidate } from './classifier.js';

export const SKIP_LABEL = 'Skip this transaction';

export function categoryChoices(categories: readonly CategoryCandidate[], term?: string) {
    const query = term?.trim().toLocaleLowerCase() ?? '';
    const choices: Array<Separator | { name: string; value: string | null; short: string }> = [
        { name: SKIP_LABEL, value: null, short: 'Skipped' },
    ];
    const groups = new Map<string, CategoryCandidate[]>();
    for (const category of categories) {
        if (
            query &&
            !category.name.toLocaleLowerCase().includes(query) &&
            !category.groupName.toLocaleLowerCase().includes(query)
        ) {
            continue;
        }
        const group = groups.get(category.groupName) ?? [];
        group.push(category);
        groups.set(category.groupName, group);
    }
    for (const [groupName, group] of groups) {
        choices.push(new Separator(`── ${groupName} ──`));
        for (const category of group) {
            choices.push({ name: category.name, value: category.id, short: `${groupName} / ${category.name}` });
        }
    }
    return choices;
}
