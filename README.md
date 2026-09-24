# actual-jev

Suggest categories for uncategorized [Actual Budget](https://actualbudget.org/) transactions using [TypeSafe Jev](https://docs.typesafe.ai/sdk/javascript).

## Setup

Requires Node.js 24 (24.10 or newer), pnpm 12, an Actual Budget server, and a TypeSafe API key.

```sh
pnpm install
cp -n .env.example .env
```

Fill in `.env` with your Actual server URL and password, TypeSafe API key, and the budget's sync ID from **Actual → Settings → Show advanced settings → Sync ID**. Set `ACTUAL_ENCRYPTION_PASSWORD` if your budget uses end-to-end encryption.

## Usage

```sh
pnpm start --dry-run                    # Preview automatic suggestions
pnpm start                              # Choose a category or skip each transaction
pnpm start --auto                       # Apply high-confidence suggestions
```

Dry-run does not change transactions. Automatic mode applies suggestions with confidence of at least `0.9` by default; `--threshold` also controls dry-run previews. The tool considers uncategorized transactions in on-budget accounts, including uncategorized parts of split transactions, and skips internal transfers.

Each prediction sends TypeSafe the transaction's payee, notes, amount, date, and account name when available, plus visible category names and notes and relevant previously categorized transactions. Automatic mode skips suggestions when a payee's history conflicts; interactive mode lets you choose.

Set `ACTUAL_JEV_MAX_EXAMPLES_PER_CATEGORY=0` in `.env` to omit historical examples from predictions (default: `3` per relevant category).

Use `--account NAME_OR_ID`, `--from YYYY-MM-DD`, and `--to YYYY-MM-DD` to narrow the scan. Run `pnpm start --help` for all options.

## Use from code

The package also exports a classifier for transactions and allowed categories supplied by your own script:

```ts
import { classifyTransaction } from 'actual-jev';

const result = await classifyTransaction({ importedPayee: 'Fresh Market', amount: -2350 }, [
    { id: 'groceries', name: 'Groceries', groupName: 'Food' },
]);

console.log(result.categoryId, result.confidence);
```

Pass `examples` in the third argument to use your own categorized transactions. Each example needs a `categoryId` from the supplied catalog and can include `payeeName`, `importedPayee`, `notes`, and `amount`.

Set `TYPESAFE_API_KEY` in your script's environment; library calls do not load `.env` automatically. The classifier only returns a suggestion and does not update Actual.
