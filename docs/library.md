# Library usage

Install `actual-jev`, `@actual-app/api`, and `@typesafe-ai/sdk` in your project. Initialize both clients in your script, then give them to `ActualJev`. Its first classification loads categories and relevant history from the open Actual budget; call `refresh()` after the budget changes.

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
