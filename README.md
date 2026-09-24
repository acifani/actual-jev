# actual-jev

Categorize uncategorized [Actual Budget](https://actualbudget.org/) transactions with [TypeSafe Jev](https://docs.typesafe.ai/sdk/javascript).

## CLI

Requires Node.js 24 (24.10 or newer), an Actual server, and a TypeSafe API key.

```sh
actual-jev setup       # Connect to Actual, choose a budget, save credentials
actual-jev --dry-run   # Preview suggestions without changing transactions
actual-jev             # Review each suggestion and choose a category or skip
actual-jev --auto      # Apply suggestions with confidence of at least 0.9
```

Setup saves your settings locally, so the CLI works from any folder. Rerun `setup` to change them. `actual-jev config show` displays settings and storage paths with secrets hidden.

Use `--threshold` to change automatic confidence, `--account`, `--from`, and `--to` to narrow the scan, or `--max-examples-per-category 0` to omit historical examples. See `actual-jev --help` for all options.

The CLI handles on-budget transactions and uncategorized split items, skips internal transfers, and leaves conflicting payee history for manual review in automatic mode. Predictions send TypeSafe transaction details, category names and notes, and relevant categorized history (up to three examples per category by default).

## Automation

Supply the connection settings in [.env.example](.env.example) as exported environment variables or an explicit environment file:

```sh
actual-jev --auto                   # Use exported variables
actual-jev --env-file .env --auto    # Read variables from a file
```

Either uses environment configuration independently of saved setup. Supply all required connection settings; exported values override matching values in the file. Find your budget's sync ID under **Actual → Settings → Show advanced settings → Sync ID**.

## Library

Pass initialized Actual and TypeSafe clients to `ActualJev`:

```ts
const classifier = new ActualJev({ actual, jev });
const result = await classifier.classify({ payee_name: 'Fresh Market', amount: -2350 });
```

The library returns suggestions without updating Actual. See [library usage](docs/library.md) for complete examples, including supplying categories without an Actual server.
