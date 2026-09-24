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
pnpm start --auto --threshold 0.9       # Apply high-confidence suggestions
```

Dry-run does not change transactions. The confidence threshold defaults to `0.9` and can be set from `0` to `1` for dry-run and automatic mode. Only uncategorized transactions are considered; transfers are skipped.

By default, on-budget accounts and all dates are scanned. Use `--account NAME_OR_ID`, `--from YYYY-MM-DD`, and `--to YYYY-MM-DD` to narrow the scan. Use `--data-dir PATH` to change the local Actual cache directory. Run `pnpm start --help` for all options.

## Use from code

The package also exports a classifier for transactions and allowed categories supplied by your own script:

```ts
import { classifyTransaction } from 'actual-jev';

const result = await classifyTransaction({ importedPayee: 'Fresh Market', amount: -2350 }, [
    { id: 'groceries', name: 'Groceries', groupName: 'Food' },
]);

console.log(result.categoryId, result.confidence);
```

Set `TYPESAFE_API_KEY` in your script's environment; library calls do not load `.env` automatically. The classifier only returns a suggestion and does not update Actual.
