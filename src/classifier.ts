import { choice, TypeSafeClient } from '@typesafe-ai/sdk';

export interface CategoryCandidate {
    id: string;
    name: string;
    groupName: string;
    isIncome?: boolean;
}

export interface TransactionDetails {
    payeeName?: string;
    importedPayee?: string;
    notes?: string;
    amount?: number;
    date?: string;
    accountName?: string;
}

export interface RankedCategory extends CategoryCandidate {
    probability: number;
}

export interface Classification {
    categoryId: string | null;
    confidence: number;
    candidates: RankedCategory[];
    noMatchProbability: number;
}

export interface JevChoiceClient {
    systemOne(request: {
        state: Record<string, string | number | null>;
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
}

const NO_MATCH = 'none_of_the_above';

/** Ask Jev to choose among caller-supplied Actual category IDs. Never writes to Actual. */
export async function classifyTransaction(
    transaction: TransactionDetails,
    categories: readonly CategoryCandidate[],
    options: ClassifierOptions = {},
): Promise<Classification> {
    if (categories.length === 0) {
        return { categoryId: null, confidence: 0, candidates: [], noMatchProbability: 1 };
    }
    if (categories.length > 254) {
        throw new RangeError('Jev Choice supports at most 254 categories plus the no-match option');
    }
    const seen = new Set<string>();
    const criteria: Record<string, string> = {};
    const byOption = new Map<string, CategoryCandidate>();
    categories.forEach((category, index) => {
        if (!category.id || !category.name || !category.groupName || seen.has(category.id)) {
            throw new TypeError('Categories must have unique nonempty IDs, names, and group names');
        }
        seen.add(category.id);
        const option = `category_${index}`;
        criteria[option] = `${category.groupName} / ${category.name}${category.isIncome ? ' (income)' : ''}`;
        byOption.set(option, category);
    });
    criteria[NO_MATCH] = 'No listed category reasonably describes this transaction';

    const client = options.client ?? new TypeSafeClient();
    const response = await client.systemOne({
        model: options.model ?? 'jev-latest',
        state: {
            payee: transaction.payeeName ?? null,
            imported_payee: transaction.importedPayee ?? null,
            notes: transaction.notes ?? null,
            amount_minor_units: transaction.amount ?? null,
            date: transaction.date ?? null,
            account: transaction.accountName ?? null,
        },
        questions: {
            category: choice(
                'Which available budget category best describes this transaction? Use none_of_the_above if none fits. The amount is in minor currency units; a negative amount is an expense.',
                criteria,
            ),
        },
    });
    const answer = response.answers.category;
    if (!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) {
        throw new Error('Jev returned an invalid confidence');
    }
    if (answer.choice !== NO_MATCH && !byOption.has(answer.choice)) {
        throw new Error(`Jev selected an unknown category option: ${answer.choice}`);
    }
    const candidates = [...byOption]
        .map(([option, category]) => {
            const probability = answer.probabilities[option];
            if (
                typeof probability !== 'number' ||
                !Number.isFinite(probability) ||
                probability < 0 ||
                probability > 1
            ) {
                throw new Error(`Jev returned an invalid probability for ${option}`);
            }
            return { ...category, probability };
        })
        .sort((a, b) => b.probability - a.probability);
    const noMatchProbability = answer.probabilities[NO_MATCH];
    if (
        typeof noMatchProbability !== 'number' ||
        !Number.isFinite(noMatchProbability) ||
        noMatchProbability < 0 ||
        noMatchProbability > 1
    ) {
        throw new Error('Jev returned an invalid no-match probability');
    }
    return {
        categoryId: answer.choice === NO_MATCH ? null : byOption.get(answer.choice)!.id,
        confidence: answer.confidence,
        candidates,
        noMatchProbability,
    };
}
