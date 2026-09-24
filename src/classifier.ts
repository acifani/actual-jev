import { choice, TypeSafeClient, type JsonValue } from '@typesafe-ai/sdk';

export interface CategoryCandidate {
    id: string;
    name: string;
    groupName: string;
    isIncome?: boolean;
    note?: string;
}

export interface TransactionDetails {
    id?: string;
    payeeName?: string;
    importedPayee?: string;
    notes?: string;
    amount?: number;
    date?: string;
    accountName?: string;
    payeeDefaultCategoryId?: string;
}

export interface CategorizedExample extends TransactionDetails {
    categoryId: string;
}

export interface RankedCategory extends CategoryCandidate {
    probability: number;
}

export interface Classification {
    categoryId: string | null;
    confidence: number;
    candidates: RankedCategory[];
    noMatchProbability: number;
    requiresReview?: boolean;
}

export interface JevChoiceClient {
    systemOne(request: {
        state: JsonValue;
        model: string;
        questions: { category: ReturnType<typeof choice> };
    }): Promise<{
        answers: {
            category: {
                choice: string;
                confidence: number;
                probabilities: Record<string, number>;
            };
        };
    }>;
}

export interface ClassifierOptions {
    client?: JevChoiceClient;
    model?: string;
    examples?: readonly CategorizedExample[];
    maxExamplesPerCategory?: number;
}

const NO_MATCH = 'none_of_the_above';

function exampleLimit(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
        throw new RangeError(`${name} must be an integer between 0 and 100`);
    }
    return value;
}

/** Parse the CLI's setting without reading process.env in library calls. */
export function examplesPerCategoryFromEnv(env: Record<string, string | undefined>): number {
    const name = 'ACTUAL_JEV_MAX_EXAMPLES_PER_CATEGORY';
    const raw = env[name];
    if (raw === undefined) return 3;
    if (!/^(0|[1-9]\d*)$/.test(raw)) throw new RangeError(`${name} must be an integer between 0 and 100`);
    return exampleLimit(Number(raw), name);
}

function normalized(value?: string): string {
    return (value ?? '')
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

function words(value?: string): Set<string> {
    return new Set(
        normalized(value)
            .split(' ')
            .filter((word) => word.length > 2),
    );
}

function relevantExamples(
    transaction: TransactionDetails,
    examples: readonly CategorizedExample[],
    categoryIds: ReadonlySet<string>,
    maxExamplesPerCategory: number,
): CategorizedExample[] {
    if (maxExamplesPerCategory === 0) return [];
    const payee = normalized(transaction.payeeName);
    const imported = normalized(transaction.importedPayee);
    const terms = words(`${transaction.payeeName ?? ''} ${transaction.importedPayee ?? ''} ${transaction.notes ?? ''}`);
    const ranked = examples.flatMap((example, index) => {
        if (!categoryIds.has(example.categoryId) || (transaction.id && example.id === transaction.id)) return [];
        const exactPayee = Boolean(payee && payee === normalized(example.payeeName));
        const exactImported = Boolean(imported && imported === normalized(example.importedPayee));
        const overlap = [
            ...words(`${example.payeeName ?? ''} ${example.importedPayee ?? ''} ${example.notes ?? ''}`),
        ].filter((word) => terms.has(word)).length;
        if (!exactPayee && !exactImported && overlap < 2) return [];
        const sameDirection =
            transaction.amount !== undefined &&
            example.amount !== undefined &&
            Math.sign(transaction.amount) === Math.sign(example.amount);
        const score = Number(exactPayee) * 100 + Number(exactImported) * 60 + overlap * 5 + Number(sameDirection);
        return [{ example, score, index }];
    });
    ranked.sort(
        (a, b) => b.score - a.score || (b.example.date ?? '').localeCompare(a.example.date ?? '') || a.index - b.index,
    );
    const counts = new Map<string, number>();
    const selected: CategorizedExample[] = [];
    for (const { example } of ranked) {
        const count = counts.get(example.categoryId) ?? 0;
        if (count >= maxExamplesPerCategory) continue;
        selected.push(example);
        counts.set(example.categoryId, count + 1);
    }
    return selected;
}

function probability(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`Jev returned an invalid ${label}`);
    }
    return value;
}

/** Ask Jev to choose among caller-supplied Actual category IDs. Never writes to Actual. */
export async function classifyTransaction(
    transaction: TransactionDetails,
    categories: readonly CategoryCandidate[],
    options: ClassifierOptions = {},
): Promise<Classification> {
    const maxExamplesPerCategory = exampleLimit(options.maxExamplesPerCategory ?? 3, 'maxExamplesPerCategory');
    if (categories.length === 0) {
        return { categoryId: null, confidence: 0, candidates: [], noMatchProbability: 1 };
    }
    if (categories.length > 254) {
        throw new RangeError('Jev Choice supports at most 254 categories plus the no-match option');
    }
    const seen = new Set<string>();
    const criteria: Record<string, string> = {};
    const byOption = new Map<string, CategoryCandidate>();
    const optionById = new Map<string, string>();
    categories.forEach((category, index) => {
        if (!category.id || !category.name || !category.groupName || seen.has(category.id)) {
            throw new TypeError('Categories must have unique nonempty IDs, names, and group names');
        }
        seen.add(category.id);
        const option = `category_${index}`;
        const note = category.note?.trim().slice(0, 400);
        criteria[option] =
            `${category.groupName} / ${category.name}${category.isIncome ? ' (income)' : ''}${note ? `. Category note: ${note}` : ''}`;
        byOption.set(option, category);
        optionById.set(category.id, option);
    });
    criteria[NO_MATCH] = 'No listed category reasonably describes this transaction';

    const examples = relevantExamples(transaction, options.examples ?? [], seen, maxExamplesPerCategory);
    const state: JsonValue = {
        transaction: {
            payee: transaction.payeeName ?? null,
            imported_payee: transaction.importedPayee ?? null,
            notes: transaction.notes ?? null,
            amount_minor_units: transaction.amount ?? null,
            date: transaction.date ?? null,
            account: transaction.accountName ?? null,
        },
        payee_default_category: optionById.get(transaction.payeeDefaultCategoryId ?? '') ?? null,
        relevant_examples: examples.map((example) => ({
            payee: example.payeeName ?? null,
            imported_payee: example.importedPayee ?? null,
            notes: example.notes ?? null,
            amount_minor_units: example.amount ?? null,
            category: optionById.get(example.categoryId)!,
        })),
    };
    const client = options.client ?? new TypeSafeClient();
    const response = await client.systemOne({
        model: options.model ?? 'jev-latest',
        state,
        questions: {
            category: choice(
                'Which available budget category best describes the transaction? Use its details, category notes, and relevant examples. Examples show past choices, not rules. Use none_of_the_above if none fits. Amounts are in minor currency units; negative amounts are expenses.',
                criteria,
            ),
        },
    });
    const answer = response.answers.category;
    const confidence = probability(answer.confidence, 'confidence');
    if (answer.choice !== NO_MATCH && !byOption.has(answer.choice)) {
        throw new Error(`Jev selected an unknown category option: ${answer.choice}`);
    }
    const candidates = [...byOption]
        .map(([option, category]) => ({
            ...category,
            probability: probability(answer.probabilities[option], `probability for ${option}`),
        }))
        .sort((a, b) => b.probability - a.probability);
    const noMatchProbability = probability(answer.probabilities[NO_MATCH], 'no-match probability');
    const selectedId = answer.choice === NO_MATCH ? null : byOption.get(answer.choice)!.id;
    const payee = normalized(transaction.payeeName);
    const importedPayee = normalized(transaction.importedPayee);
    const matchingPayee = (maxExamplesPerCategory ? (options.examples ?? []) : []).filter(
        (example) =>
            seen.has(example.categoryId) &&
            !(transaction.id && example.id === transaction.id) &&
            ((payee && payee === normalized(example.payeeName)) ||
                (!payee && importedPayee && importedPayee === normalized(example.importedPayee))),
    );
    const historicalCategories = new Set(matchingPayee.map((example) => example.categoryId));
    const requiresReview = Boolean(
        selectedId &&
        (historicalCategories.size > 1 ||
            (transaction.payeeDefaultCategoryId &&
                transaction.payeeDefaultCategoryId !== selectedId &&
                !historicalCategories.has(selectedId))),
    );
    return {
        categoryId: selectedId,
        confidence,
        candidates,
        noMatchProbability,
        requiresReview,
    };
}
