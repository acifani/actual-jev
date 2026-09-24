# actual-jev

Suggest categories for uncategorized [Actual Budget](https://actualbudget.org/) transactions with [TypeSafe Jev](https://docs.typesafe.ai/sdk/javascript). Review suggestions one by one, preview what would be applied, or apply suggestions above a confidence threshold.

## Get started

You need Node.js 24 LTS (24.10 or newer), pnpm 12, a running Actual Budget server, and a TypeSafe API key.

```sh
pnpm install
cp -n .env.example .env
```

Fill in `.env` using [`.env.example`](.env.example). Set your Actual server URL and password, your TypeSafe API key, and your budget's sync ID from **Actual → Settings → Show advanced settings → Sync ID**. Set `ACTUAL_ENCRYPTION_PASSWORD` only if your budget uses end-to-end encryption.

Preview suggestions before making changes:

```sh
pnpm start --dry-run
```

This downloads the budget into a local `.actual-data` cache and shows which categories automatic mode would apply. It does not change your transactions.

## Review or apply categories

| Command                             | What happens                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| `pnpm start`                        | Review each suggestion in your terminal. Accept it, choose another category, or skip. |
| `pnpm start --dry-run`              | Preview automatic mode without changing categories.                                   |
| `pnpm start --auto --threshold 0.9` | Apply suggestions with confidence of at least `0.9`.                                  |

The threshold ranges from `0` to `1` and defaults to `0.9`. It applies to dry-run and automatic modes. Try a dry run before using automatic mode to choose a threshold that fits your budget.

The CLI scans all accounts and dates unless you narrow the scan. For example:

```sh
pnpm start --dry-run --account "Checking" --from 2026-09-01 --to 2026-09-30
```

`--account` accepts an account name or ID. `--from` and `--to` include the dates you specify. Use `--data-dir PATH` to change where the local budget cache is stored.

Only uncategorized transactions are considered. Transfers are skipped, and split transactions are handled one child at a time. Existing categories are never replaced. Accepted changes are synced to Actual before the CLI exits.

## Use it from code

The package also exports a classifier for scripts that supply their own transactions and allowed categories:

```ts
import { classifyTransaction } from "actual-jev";

const result = await classifyTransaction(
  { importedPayee: "Fresh Market", amount: -2350 },
  [{ id: "groceries", name: "Groceries", groupName: "Food" }]
);

console.log(result.categoryId, result.confidence);
```

The classifier returns a suggestion and does not change Actual. Your script decides whether to use the returned category ID. Supply `TYPESAFE_API_KEY` through the environment; library calls do not load `.env` automatically. If your script already has an initialized Actual client, `createActualClassifier(actual)` can read its visible categories and payees for you.
