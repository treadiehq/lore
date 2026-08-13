# `@lore-co/sdk`

The customer library for applications and integrations that call Lore
programmatically. It provides a typed client for learnings, activity, audited
context delivery, observations, and turns.

```sh
pnpm add @lore-co/sdk
```

```ts
import { LoreClient } from "@lore-co/sdk";

const lore = new LoreClient({
  baseUrl: process.env.LORE_API_URL!,
  headers: {
    authorization: `Bearer ${process.env.LORE_WORKSPACE_TOKEN!}`,
  },
});

const result = await lore.processTurn(turn, "incident-42:reply-3");
```

`observeEvent` calls `POST /v1/observations`; `processTurn` calls
`POST /v1/turns` and forwards the optional idempotency key. `observe` and
`getContext` remain available for compatibility.

Use `@lore-co/adapter-generic` instead when the customer owns an agent runtime and
wants a higher-level prepare/observe bridge. CLI users should install the
standalone `lore` binary; they do not need this package.

Node.js 22 or newer is required.
