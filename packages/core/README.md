# `@lore-co/core`

Runtime schemas and shared types for Lore's engineering-memory APIs.

Install it when building a custom Lore integration that needs the public request
and response schemas:

```sh
pnpm add @lore-co/core
```

```ts
import { PairedTurnRequestSchema } from "@lore-co/core";

const turn = PairedTurnRequestSchema.parse(input);
```

Most applications should use [`@lore-co/sdk`](../sdk/README.md) instead of
calling these schemas directly. Node.js 22 or newer is required.
