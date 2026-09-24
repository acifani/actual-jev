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

Initialize both clients in your script, then give them to `ActualJev`. Its first classification loads categories and relevant history from the open Actual budget; call `refresh()` after the budget changes.

```ts
import * as actual from '@actual-app/api';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { ActualJev } from 'actual-jev';

await actual.init({
    serverURL: process.env.ACTUAL_SERVER_URL!,
    password: process.env.ACTUAL_PASSWORD!,
    dataDir: '.actual-data',
});
await actual.downloadBudget(process.env.ACTUAL_SYNC_ID!, {
    password: process.env.ACTUAL_ENCRYPTION_PASSWORD,
});
const jev = new TypeSafeClient();

try {
    const classifier = new ActualJev({ actual, jev });
    const result = await classifier.classify({ payee_name: 'Fresh Market', amount: -2350 });
    console.log(result.categoryId, result.confidence);
} finally {
    await actual.shutdown();
}
```

You can instead supply categories and examples without an Actual client:

```ts
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { ActualJev } from 'actual-jev';

const jev = new TypeSafeClient();
const classifier = new ActualJev({
    jev,
    categories: [{ id: 'groceries', name: 'Groceries', groupName: 'Food' }],
    examples: [{ categoryId: 'groceries', payeeName: 'Fresh Market' }],
});
const result = await classifier.classify({ importedPayee: 'Fresh Market', amount: -2350 });
```

Classification returns a suggestion and never updates Actual.
