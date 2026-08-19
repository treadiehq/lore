# `@lore-co/adapter-generic`

Host-controlled bridge for services that own their agent runtime.

## Install

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

OpenCode users should use `@lore-co/opencode`; `lore connect` installs
its plugin entry without routing OpenCode through Claude or Codex command hooks.

## Production guidance

- Keep the workspace token in server-side secrets.
- Persist stable connector, event, and session IDs for safe retries.
- Call `prepareDelivery` before the model request and record observations after
  the model turn.
- Keep model-provider and MCP authorization decisions in the host application.

Node.js 22 or newer is required. See
[generic host integrations](../../../docs/detailed.md#generic-host-integrations) for
complete examples.
