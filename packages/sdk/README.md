# `@lore-co/sdk`

The customer library for applications and integrations that call Lore
programmatically. It provides a typed client for learnings, activity, audited
context delivery, observations, and turns.

## Install

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

const result = await lore.processTurn({
  connector: "incident-bot",
  eventId: "incident-42:reply-3",
  agent: "incident-bot",
  sessionId: "incident-42",
  previousAssistant: { content: "Restart the service." },
  currentUser: { content: "No, fail over first." },
}, "incident-42:reply-3");
```

`observeEvent` calls `POST /v1/observations`; `deliverContext` calls audited
`POST /v1/context/deliveries`; and `processTurn` calls `POST /v1/turns` and
forwards the optional idempotency key. The client also exposes learning
inspection and lifecycle methods, activity listing, workspace-token
management, and Devin session registration. `observe`, `getContext`, and the
memory-named methods remain available for compatibility.

Use `@lore-co/adapter-generic` instead when the customer owns an agent runtime and
wants a higher-level prepare/observe bridge. CLI users should install
`@lore-co/cli` globally; they do not need this package.

## Production guidance

- Use an HTTPS API URL and keep workspace tokens in server-side secrets.
- Reuse stable connector, event, and session IDs when retrying requests.
- Handle `LoreApiError` for non-2xx responses and log its status without
  exposing credentials.

Node.js 22 or newer is required. See the
[technical guide](../../docs/detailed.md#typescript-sdk) for the complete API
surface.
