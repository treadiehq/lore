# `@lore-co/adapter-generic`

Host-controlled bridge for services that own their agent runtime.

```sh
pnpm add @lore-co/adapter-generic
```

```ts
import { GenericAgentAdapter } from "@lore-co/adapter-generic";

const lore = new GenericAgentAdapter({
  id: "incident-bot",
  baseUrl: process.env.LORE_API_URL!,
  headers: {
    authorization: `Bearer ${process.env.LORE_WORKSPACE_TOKEN!}`,
  },
});

const prepared = await lore.prepareDelivery({
  connector: "pager-webhook",
  eventId: incident.id,
  sessionId: incident.id,
  task: incident.summary,
  repo: "acme/service",
});
```

The adapter forces the configured agent ID and requires the host to supply
stable connector, event, and session identities. `observeEvent`,
`prepareDelivery`, and `processTurn` expose audited events, receipts, and
delivered memories. `prepareTask` remains as a legacy compatibility path.
Model and MCP policy stays with the host application.

Node.js 22 or newer is required.
