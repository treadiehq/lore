# lore: detailed guide

[README](README.md)

## How it works

Write flow:

1. A first Codex or Claude prompt is recorded as an authenticated, audited
   `POST /v1/observations` event. Later prompts pair the last agent claim with
   the human response through `POST /v1/turns`. Devin poller and GitHub
   corrections use the same paired-turn path.
2. lore redacts the pair, detects explicit teaching, and reconciles it with active scoped knowledge.
3. PostgreSQL stores the event, provenance, learning, idempotency result, and superseded knowledge.
4. The same request retrieves current knowledge and records a delivery receipt.

Read flow:

1. A native prompt hook or host sends the task, diff, files, components, and
   symbols to audited `POST /v1/context/deliveries`; compatibility adapters may
   still use `POST /v1/context`.
2. Retrieval filters by organization, project, repository, path, component, and active status.
3. Hybrid retrieval combines lexical ranking with tenant-filtered pgvector similarity. Provider failures fall back to lexical results.
4. lore packs complete learnings within character and estimated token budgets. The adapter injects that context.

`observation → extraction → PostgreSQL → scoped retrieval → prompt injection`

The API is the boundary. Adapters share no in-process state. A new adapter can read knowledge stored by another agent or session.

Delivery proves context was supplied. It does not prove an LLM followed it.

## Repository map

- `apps/api` — NestJS REST API.
- `apps/web` — Nuxt learning browser.
- `packages/core` — schemas, engine, repository ports, and in-memory storage.
- `packages/database` — Drizzle schema, migration, and PostgreSQL storage.
- `packages/extractor` — heuristic and OpenAI-compatible extraction.
- `packages/retrieval` — scoped retrieval, embeddings, and context packing.
- `packages/sdk` — typed HTTP client.
- `packages/cli` — `lore` connector, hooks, and GitHub/Devin review workflows.
- `packages/devin-plugin` — optional fail-open bridge for Devin's managed-plugin beta.
- `packages/adapters/generic` — generic message mapping and prompt injection.
- `packages/adapters/claude` — Claude development-session wrapper.
- `packages/adapters/codex` — Codex wrapper and `lore-codex` CLI.
- `packages/adapters/devin` — Devin session and event wrapper.
- `packages/mcp` — stdio MCP server backed by the HTTP SDK.
- `scripts/demo.ts` — API and PostgreSQL simulator.
- `tests` — Vitest, adapter, SDK, and gated database tests.

## Run locally

The packaged stack needs Docker Compose and Bash. Source work also needs Node.js 22+ and pnpm 10.34.5+.

```sh
pnpm project:start
```

The script creates `.env` if needed. It generates `LORE_WORKSPACE_TOKEN`, then builds and starts PostgreSQL, migrations, the API, and the web app through Compose.

The dashboard/learning browser (the optional Lore wiki) is not required by any
connector. For complete API-only or unattended operation, use
`pnpm project:headless:start`. This starts only PostgreSQL, migrations, and the
API, skips the web-port preflight, and uses the Docker API build stage that does
not build Nuxt.

Use that token for local connectors and Railway. Compose binds the database,
API, and UI ports to loopback. Dashboard users authenticate separately with
single-use passwordless links.

If port 5432 is busy, set the same alternate port in `POSTGRES_PORT` and `DATABASE_URL` in `.env`.

Volumes created before the lore rename may not contain the `lore` database. Create it to keep existing data. Use `docker compose down -v` only if it is safe to discard the old local database.

The start command prints the active UI and API URLs. Their ports come from
`NUXT_PORT` and `API_PORT` in `.env`. The defaults are:

- UI: <http://localhost:3002>
- API: <http://localhost:3004>
- Liveness: <http://localhost:3004/health>
- Readiness: <http://localhost:3004/health/ready>

```sh
pnpm project:stop
pnpm project:restart
pnpm project:restart -- --no-build
pnpm project:status
pnpm project:logs
pnpm project:headless:start
pnpm project:headless:restart
pnpm project:headless:status
pnpm project:headless:logs
```

Headless status and logs select only `postgres`, `migrate`, and `api`. Stop is
intentionally stack-wide so `pnpm project:stop` has one predictable teardown
behavior. PostgreSQL data remains in the Compose volume.

These commands wrap `./scripts/project.sh`. Run it directly if pnpm is
unavailable. Logs follows output from every service. Stop and restart preserve
PostgreSQL data.

Use `./scripts/project.sh --help` for examples. Use `--dry-run` to preview an operation.

## Sign up and sign in

The first dashboard user opens <http://localhost:3002/signup> and provides an
organization name and email. Later sign-ins need only the email at
<http://localhost:3002/login>. In local mode, follow the magic link printed in
the API logs:

```sh
docker compose logs -f api
```

When the preconfigured `LORE_WORKSPACE_ORGANIZATION` has no dashboard user, the
first signup claims that workspace and updates its display name. Existing
connector tokens and learned memories therefore remain in the same tenant as
the new dashboard session. Later independent signups create separate
workspaces.

Magic links are stored as SHA-256 hashes, can be used once, and expire after 15
minutes. Browser sessions are opaque, hashed in PostgreSQL, held in a host-only
HttpOnly `SameSite=Lax` cookie by the Nuxt server, and expire after 30 days.
Connector workspace bearer tokens continue to authenticate agent and CLI
traffic; they are not exposed to dashboard browsers.

Production email delivery uses Resend:

```dotenv
AUTH_EMAIL_MODE=resend
AUTH_WEB_ORIGIN=https://lore.example.com
AUTH_EMAIL_FROM=Lore <auth@example.com>
RESEND_API_KEY=re_...
NUXT_AUTH_COOKIE_SECURE=true
```

## Connect agents

Sign in to the dashboard, open **Connect**, and create a named workspace token.
The raw secret is shown once and only its hash is stored. Create a separate
token for each machine or integration so it can be audited and revoked without
interrupting other connectors.

Run the command shown in the dashboard to connect installed Codex and Claude
Code clients:

```sh
curl -fsSL https://raw.githubusercontent.com/treadiehq/lore/main/scripts/install.sh | bash
lore connect \
  --url http://localhost:3004 \
  --token "lore_your_generated_token"
lore doctor
```

Every Codex and Claude prompt now receives scoped context, including the first
prompt in a new session. A first-prompt teaching is observed immediately. After
an agent response, the next human prompt is paired with that response so explicit
corrections are captured. Native-agent teachings default to workspace scope while
the prompt's repository remains part of retrieval relevance. Sessions do not
need `remember()` or an MCP call.
That also makes native corrections workspace-global by default: a correction
captured in one repository can reach another connected repository when its task
is relevant. Explicit integrations may choose project, repository, path, or
component learning scope instead.
The bootstrap `LORE_WORKSPACE_TOKEN` generated in `.env` remains useful for
unattended local provisioning.

## Connect Devin

Lore supports customer Devin usage through the Devin v3 API. Create a Devin service user with `ManageOrgSessions`, `ViewOrgSessions`, and `ManageOrgSessionMessages`. Add `ImpersonateOrgSessions` only when using `DEVIN_CREATE_AS_USER_ID`.

Configure the Lore API with:

```dotenv
DEVIN_POLLING_ENABLED=true
DEVIN_API_KEY=cog_...
DEVIN_ORG_ID=org-...
DEVIN_REPOSITORY_ALLOWLIST=owner/repository
```

Then verify both services and start a bounded session:

```sh
set -a; . ./.env; set +a
lore devin setup
lore devin start \
  --repo owner/repository \
  --prompt "Fix the failing tests" \
  --max-acu 2
```

`devin start` retrieves scoped Lore context, injects it into the prompt, creates the session with approval bypass disabled and a hard ACU limit, and registers the transcript poller. The poller stores durable assistant-to-user corrections through the same idempotent `/v1/turns` path used by other connectors.

Customer support:

- API-created development sessions: supported. Use `lore devin start`.
- Sessions created elsewhere: supported after registering their organization, session, and canonical `owner/repository` scope with `POST /v1/connectors/devin/sessions`.
- Lore-controlled GitHub Devin reviews: supported through the generated `lore:devin-review` workflow.
- Devin managed-plugin prompt hooks: optional closed-beta support through `@lore-co/devin-plugin`; managed-plugin access must come from Devin.
- Native `/devin review`: cannot receive Lore context. Use Lore's review workflow instead.

The poller requires only outbound HTTPS access to Devin. A public Lore API URL is needed for GitHub Actions and managed cloud hooks.
Prompts entered directly in Devin's UI bypass Lore's pre-send context delivery.
Use `lore devin prompt` for enriched later prompts. A directly entered prompt
in an already registered session may still be observed by the poller afterward;
observation is not enrichment.

Run the credential-gated live acceptance suite only when one billable, capped session is intended:

```sh
RUN_DEVIN_LIVE_TESTS=1 pnpm test:devin:live
```

It verifies a deterministically seeded Claude-attributed correction is
extracted, retrieved through an audited delivery, injected into a real Devin
session, followed by Devin, and that a new human correction in that Devin
transcript is captured by Lore. Test learnings are forgotten and the session is
archived in cleanup. The manual workflow
`.github/workflows/devin-live-acceptance.yml` should use a protected
`devin-live-acceptance` environment.

For the real three-agent chain, authenticate the Claude and Codex CLIs, build
the customer CLI, configure the same Devin credentials, and explicitly run:

```sh
RUN_THREE_AGENT_CHAIN_LIVE_TESTS=RUN pnpm test:chain:live
```

This command makes real Claude teach a workspace rule, proves an audited
`lore devin start` delivery and real Devin response, sends a second rule through
audited `lore devin prompt`, waits for the `devin-poller` paired turn, and asks
fresh Codex and Claude sessions for the Devin rule. Claude spend is capped per
invocation, Codex uses low reasoning effort in read-only mode, and Devin has a
hard ACU cap. Cleanup archives the Devin session and forgets test learnings.
This chain has passed with real authenticated Claude, Devin, Codex, and Claude
clients. Customers should rerun it with their own credentials and Lore
deployment before rollout.

## Set up GitHub reviews

```sh
OPENAI_API_KEY=... \
DEVIN_API_KEY=... \
DEVIN_ORG_ID=org-... \
  lore connect github \
  --repo owner/repository \
  --configure-secrets
```

Commit the generated `.github` files. Add `lore:codex-review` or `lore:devin-review` to a pull request.

Set target repository variable `LORE_CLI_VERSION` to a released tag, such as
`v0.1.0`. When using a fork, set `LORE_CLI_REPOSITORY` to its
`owner/repository` value. Generated jobs download and verify that standalone
binary before invoking `lore`. The target also needs:

- secrets: `LORE_WORKSPACE_TOKEN`, plus `OPENAI_API_KEY` for Codex and
  `DEVIN_API_KEY` for Devin;
- variables: `LORE_API_URL`, `LORE_CLI_VERSION`, optionally
  `LORE_CLI_REPOSITORY`, plus `DEVIN_ORG_ID` for Devin;
- labels: `lore:codex-review` and/or `lore:devin-review`.

Review jobs grant the workflow token `contents: read` and
`pull-requests: write`, the scope GitHub requires to inspect and publish PR
comments. The correction workflow is read-only in GitHub and grants
`contents`, `issues`, and `pull-requests` read access.

Authorized maintainers can teach lore from a false positive:

```text
/lore correct https://github.com/owner/repo/pull/123#issuecomment-456

No, RepositoryFactory is deprecated. Use AccountStore instead.
```

### GitHub review live acceptance

The manual `.github/workflows/github-pr-live-acceptance.yml` workflow uses the
protected `github-pr-live-acceptance` environment and runs only when
`confirm_billable_reviews` is exactly `RUN`. Configure that environment with:

- secret `GITHUB_PR_LIVE_TOKEN`: a fine-grained token that can read Actions
  metadata and repository configuration names, push/delete branches, manage
  pull requests, labels, and issue comments in the target repository;
- secret `LORE_WORKSPACE_TOKEN`;
- variable `LORE_API_URL`, reachable from GitHub-hosted runners.

Target repository provider credentials remain in the target repository; the
acceptance runner checks only their names and never reads their values. It also
requires the exact Lore workflows and labels above. Preflight reports every
missing prerequisite and does not create configuration implicitly.

For a local run, export the same values, set
`RUN_GITHUB_PR_LIVE_TESTS=1`, and run `pnpm test:github:live`. Optional controls
include `GITHUB_PR_LIVE_REPO`, `GITHUB_PR_LIVE_BASE_BRANCH`,
`GITHUB_PR_LIVE_PROVIDERS`, `GITHUB_PR_LIVE_CLI_REPOSITORY`,
`GITHUB_PR_LIVE_CLI_VERSION`,
`GITHUB_PR_LIVE_CLEANUP`, `GITHUB_PR_LIVE_BRANCH_PREFIX`,
`GITHUB_PR_LIVE_DOC_DIRECTORY`, and
`GITHUB_PR_LIVE_COMMAND_TIMEOUT_MS`, `GITHUB_PR_LIVE_REVIEW_TIMEOUT_MS`,
`GITHUB_PR_LIVE_CORRECTION_TIMEOUT_MS`,
`GITHUB_PR_LIVE_LEARNING_TIMEOUT_MS`, `GITHUB_PR_LIVE_HEALTH_TIMEOUT_MS`, and
`GITHUB_PR_LIVE_POLL_INTERVAL_MS`. The manual workflow preflights the selected
published binary release before making any target-repository changes. Real
acceptance is intentionally not part of the normal test suite. On August 13,
2026, both Codex and Devin review paths
passed against a prepared target repository with exact-head bot comments,
authorized `/lore correct` capture, workspace-scoped learning, provenance,
delivery receipts, and cleanup. That proof installed a packed current CLI
artifact; the current harness instead preflights a published standalone release.
Customers must rerun this gate with their own target repository and credentials
before rollout.

## Deploy to Railway

Create one Railway project with PostgreSQL and API services. Add the web service
only when the optional dashboard/wiki is wanted.

1. Set the API config-as-code path to `/deploy/railway-api.json`.
2. Set `DATABASE_URL`, a random `LORE_WORKSPACE_TOKEN` of at least 24 characters,
   `LORE_WORKSPACE_ORGANIZATION`, and the extractor and embedding variables.
   Add auth/Resend variables only when deploying the web sign-in path.
3. Allow `CREATE EXTENSION vector` on PostgreSQL. Railway supplies `PORT`. Migrations run before deployment. Readiness waits for PostgreSQL.
4. For a headless deployment, stop here, expose the API over HTTPS, and use its
   public URL for connectors, external hosts, and GitHub Actions. Do not create
   a web service.
5. For the optional dashboard/wiki, create a web service with config path
   `/deploy/railway-web.json` and set `NUXT_LORE_API_URL` to the private API URL,
   `NUXT_AUTH_COOKIE_NAME=lore_session`, and
   `NUXT_AUTH_COOKIE_SECURE=true`.
6. Expose only the API and optional web services. Do not expose PostgreSQL.

The web service forwards only a signed-in user's opaque session to the private
API. Connector workspace credentials remain on the API and are never placed in
public Nuxt runtime configuration. Omitting the web service removes the
learning browser and passwordless UI, not capture, retrieval, activity,
delivery receipts, or connector support.

## Run the simulator

Keep the API running, then start:

```sh
pnpm demo
```

The demo uses the real `ClaudeAdapter`, `CodexAdapter`, and `DevinAdapter` classes with the local API and PostgreSQL. It makes no vendor API calls. It does not claim that vendor agents were launched.

Demo 1:

1. A fresh Codex review has no Stripe teaching.
2. A Claude observation teaches: “Never call Stripe directly from API handlers. Use BillingService.”
3. A new Codex adapter retrieves that learning for a `stripe.customers.update` diff.
4. A deterministic local reviewer flags the call only when the learning exists.

Demo 2:

1. A Devin review recommends `RepositoryFactory`.
2. A human says it is deprecated and requires `AccountStore`.
3. A new Claude adapter gets the correction for a relevant task.

The script deletes only rows in its `simulator` project scope. It checks each cold start. It prints the stored ID, agent/session/message provenance, and injected result. Active demo learnings stay in the UI.

## REST API

Lore APIs accept `Authorization: Bearer <credential>`. Connectors use workspace
tokens; the Nuxt BFF uses passwordless browser-session tokens. Either credential
sets the server-owned workspace organization scope. `/health`,
`/health/ready`, signup, login, and magic-link verification are public.

Passwordless endpoints:

- `POST /v1/auth/signup` — strict `{ organizationName, email }`; always returns
  the generic check-email response.
- `POST /v1/auth/login` — strict `{ email }`; unknown and known users receive
  the same HTTP response.
- `POST /v1/auth/verify` — atomically exchanges a single-use magic token for an
  opaque session token.
- `GET /v1/auth/session` — returns the signed-in user and workspace profile.
- `POST /v1/auth/logout` — revokes the current browser session.

### Process a paired turn

`POST /v1/turns` stores the redacted event, extracts and reconciles knowledge, retrieves context, and records a delivery receipt in one transaction. `connector` plus `eventId` is idempotent.

```sh
curl -sS http://localhost:3004/v1/turns \
  -H "authorization: Bearer $LORE_WORKSPACE_TOKEN" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: codex:session-1:prompt-2' \
  -d '{
    "connector": "lore-cli",
    "eventId": "codex:session-1:prompt-2",
    "agent": "codex",
    "sessionId": "session-1",
    "previousAssistant": { "content": "Call RepositoryFactory from this handler." },
    "currentUser": { "content": "No, RepositoryFactory is deprecated. Use AccountStore instead." },
    "repo": "owner/accounts",
    "task": "Fix account persistence"
  }'
```

### Observe an interaction

```sh
curl -sS http://localhost:3004/v1/interactions \
  -H "authorization: Bearer $LORE_WORKSPACE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "agent": "claude",
    "repo": "payments",
    "sessionId": "dev-123",
    "messages": [{
      "id": "message-9",
      "role": "user",
      "content": "Never call Stripe directly from API handlers. Use BillingService."
    }]
  }'
```

The response has `memories`, `created`, and `duplicates`. Each learning has `id`, `content`, `scope`, `category`, `status`, `source`, `fingerprint`, `supersedesMemoryId`, `createdAt`, `updatedAt`, and `deletedAt`. `source` may have `agent`, `sessionId`, `messageId`, and `rawText`.

### Retrieve context

```sh
curl -sS http://localhost:3004/v1/context \
  -H "authorization: Bearer $LORE_WORKSPACE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "agent": "codex",
    "repo": "payments",
    "task": "Review the customer update",
    "diff": "+ await stripe.customers.update(customerId, params)",
    "files": ["src/api/customers.ts"],
    "symbols": ["stripe.customers.update"],
    "limit": 3
  }'
```

The response is `{ "memories": Learning[], "context": string, "packing": ContextPacking }`. `context` is readable text. Adapters apply their own delimiters to `memories`.

### Manage learnings

- `POST /v1/learnings` — create from `content`, scope fields, optional `category`, and `source`; returns `{ memory, inserted }`.
- `GET /v1/learnings` — list with `query`, `category`, `status`, `organization`, `project`, `repo`, `path`, `component`, `limit`, and `offset`; returns `{ memories, total, limit, offset }`.
- `GET /v1/learnings/:id` — returns `{ memory }`.
- `PATCH /v1/learnings/:id` — edit active `content`, `scope`, or `category`; returns `{ memory }`.
- `POST /v1/learnings/:id/corrections` — create a linked replacement and supersede the old learning; returns `{ memory, supersededMemory }`.
- `DELETE /v1/learnings/:id` — soft-delete; returns `{ memory }`.

The older `/v1/memories` paths remain aliases.

## TypeScript SDK

Use `@lore-co/sdk` when an application needs direct, typed access to Lore's
learnings, observations, audited context deliveries, and turns.

```sh
pnpm add @lore-co/sdk
```

```ts
import { LoreClient } from "@lore-co/sdk";

const lore = new LoreClient({
  baseUrl: process.env.LORE_API_URL ?? "http://localhost:3004",
  headers: {
    authorization: `Bearer ${process.env.LORE_WORKSPACE_TOKEN!}`,
  },
});

const observed = await lore.observe({
  agent: "claude",
  repo: "payments",
  sessionId: "dev-123",
  messages: [{
    id: "message-9",
    role: "user",
    content: "Never call Stripe directly. Use BillingService.",
  }],
});
// observed: { memories: Learning[], created: number, duplicates: number }

const preparedContext = await lore.getContext({
  agent: "codex",
  repo: "payments",
  task: "Review the customer update",
  diff: "+ await stripe.customers.update(customerId, params)",
});
// preparedContext: { memories: Learning[], context: string }

const audited = await lore.processTurn({
  connector: "incident-webhook",
  eventId: "incident-42:reply-3",
  agent: "incident-bot",
  sessionId: "incident-42",
  previousAssistant: { content: "Restart the service." },
  currentUser: { content: "No, fail over first." },
  scope: { repo: "acme/service" },
}, "incident-42:reply-3");
// audited: { event, observation, context, receipt, replayed }
```

`observeEvent` sends typed `ObservationRequest` JSON to `/v1/observations`.
`processTurn` sends typed `PairedTurnRequest` JSON to `/v1/turns` and forwards
an optional idempotency key. The request and response types are exported. The
legacy `observe` and `getContext` methods remain compatible.

The client also has `createLearning`, `getLearning`, `listLearnings`, `updateLearning`, `correctLearning`, and `forgetLearning`. Older memory-named methods remain aliases.

Pass `fetch` to inject HTTP. Pass `headers` for gateway headers. Non-2xx responses throw `LoreApiError`/`SharedMemoryApiError` with `status`, `method`, `url`, and parsed `details`.

## Configure extraction

`EXTRACTOR_PROVIDER=heuristic` is the default. It needs no API key.

It reads only human or user messages. It detects durable terms such as “never,” “always,” deprecations, corrections with “instead,” and stable statements such as “maps to” or “returns.”

It ignores questions, normal conversation, temporary requests, and assistant claims. It drops candidates below the default `0.8` confidence threshold. Ambient observations need at least one scope field to prevent accidental global knowledge.

Use an OpenAI-compatible chat-completions endpoint for structured extraction:

```dotenv
EXTRACTOR_PROVIDER=hybrid
EXTRACTOR_BASE_URL=https://provider.example/v1
EXTRACTOR_API_KEY=replace-me
EXTRACTOR_MODEL=model-name
```

`hybrid` keeps high-confidence heuristic results. It calls the model once only when the heuristic result is uncertain or empty. Model failures do not block the agent turn.

The provider must support `POST /chat/completions` and JSON-object responses. Use `openai-compatible` to send every interaction to the model. Normal use, tests, and the demo work without model credentials.

## Configure retrieval

```dotenv
RETRIEVAL_MODE=hybrid
EMBEDDING_BASE_URL=https://api.openai.com/v1
EMBEDDING_API_KEY=replace-me
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536
SEMANTIC_MIN_SIMILARITY=0.65
```

This config uses a 1536-dimension OpenAI-compatible embedding endpoint.

`RETRIEVAL_MODE=auto` is the default. It uses hybrid retrieval when `EMBEDDING_API_KEY` exists. Otherwise it uses lexical retrieval. Embedding errors, timeouts, invalid dimensions, and missing stored embeddings also fall back to lexical retrieval.

Context contains only complete items that fit `CONTEXT_MAX_ITEMS`, `CONTEXT_MAX_CHARACTERS`, and `CONTEXT_MAX_ESTIMATED_TOKENS`. Token counts are conservative UTF-8-byte estimates, not vendor tokenizer results.

## Adapter behavior

1. After a legacy interaction, call the adapter's `observe`.
2. Before a legacy task or review, call `prepareTask` or `getContext`.
3. Pass the enriched prompt or instruction to the real vendor tool.

`ClaudeAdapter.observe` accepts a Claude transcript. A new adapter's `prepareTask` returns `prompt` with scoped context.

Codex CLI:

```sh
pnpm build:packages
pnpm --filter @lore-co/adapter-codex run start -- \
  context --base-url http://localhost:3004 \
  --repo payments --task "Review customer updates" \
  --diff-file patch.diff

pnpm --filter @lore-co/adapter-codex run start -- \
  prompt --base-url http://localhost:3004 \
  --review --repo payments --diff-file patch.diff

pnpm --filter @lore-co/adapter-codex run start -- \
  exec --base-url http://localhost:3004 \
  --review --repo payments --diff-file patch.diff
```

`context` prints learnings. `prompt` prints the task with delimited knowledge. `exec` retrieves context, then starts a new non-interactive `codex exec` process. A surrounding hook or wrapper must still observe human corrections.

For Devin, send webhook or session messages to `DevinAdapter.observe`. Call a new adapter's `prepareTask` before the next Devin instruction. `prepareTask` is a compatibility path; new generic hosts should use the audited APIs below.

Adapters are HTTP bridges and do not claim behavior that a vendor does not
expose. Native Claude/Codex resumed sessions, API-created Devin sessions, and
the real three-agent chain have been exercised successfully with authenticated
vendor clients. Both GitHub provider review/correction paths have also passed
after target-repository preflight. The release path now uses verified standalone
CLI assets. Devin's
closed-beta managed-plugin path remains availability-dependent; every live gate
must still be rerun in the customer's environment.

## Generic host integrations

`GenericAgentAdapter` is for model API services, CI orchestrators, and
incident/webhook bots where the application controls the conversation. The
host chooses and persists connector, event, and session identity. The adapter
forces its configured agent ID, normalizes task and scope, injects returned
context, and exposes the event, receipt, and memories. Agent-generated content
does not choose MCP or override host identity.
An external host needs this one-time bridge integration around its model call;
native connector installation cannot intercept an arbitrary API service, CI
orchestrator, or bot.

Install the higher-level adapter instead of the SDK when the host owns the
agent runtime and wants Lore to prepare prompts and normalize observations:

```sh
pnpm add @lore-co/adapter-generic
```

An API-backed model service can prepare audited delivery before calling its
model provider:

```ts
import { GenericAgentAdapter } from "@lore-co/adapter-generic";

const lore = new GenericAgentAdapter({
  id: "support-model",
  baseUrl: process.env.LORE_API_URL!,
  headers: {
    authorization: `Bearer ${process.env.LORE_WORKSPACE_TOKEN!}`,
  },
});

const prepared = await lore.prepareDelivery({
  connector: "support-api",
  eventId: request.id,
  sessionId: conversation.id,
  task: request.prompt,
  repo: "acme/support",
});

const modelResult = await model.generate({ prompt: prepared.prompt });
console.log(prepared.event.id, prepared.receipt.id);
```

An incident bot processes a correction and gets context for the current reply
in one idempotent call:

```ts
const turn = await lore.processTurn({
  connector: "pager-webhook",
  eventId: `${incident.id}:${webhook.deliveryId}`,
  sessionId: incident.id,
  previousAssistant: { id: prior.id, content: prior.text },
  currentUser: { id: message.id, content: message.text },
  repo: incident.repository,
}, `${incident.id}:${webhook.deliveryId}`);

await incidentModel.reply(turn.prompt);
```

For local scripts and CI, use exact endpoint JSON without embedding credentials
in arguments:

```sh
export LORE_API_URL=https://lore.example.com
export LORE_WORKSPACE_TOKEN=...

lore host deliver --input delivery.json --output prompt
cat observation.json | lore host observe --input -
lore host turn --input turn.json \
  --idempotency-key ci-run-2048:step-3 \
  --output json
```

`observeEvent` records an auditable observation. `prepareDelivery` always
records a delivery receipt. `processTurn` returns observation and delivery in a
single response. Reuse the same event ID and payload on retries; changing the
payload under an existing connector/event identity returns a conflict.

## MCP

```sh
pnpm build:packages
pnpm mcp
```

Stdio client config:

```json
{
  "mcpServers": {
    "lore": {
      "command": "node",
      "args": ["/absolute/path/to/lore/packages/mcp/dist/index.js"],
      "env": {
        "LORE_API_URL": "http://localhost:3004",
        "LORE_WORKSPACE_TOKEN": "the-same-workspace-token"
      }
    }
  }
}
```

- `search_learnings` — search by task, diff, files, components, and symbols.
- `get_learning` — get one learning by UUID.
- `remember_learning` — store durable knowledge idempotently.
- `correct_learning` — supersede an active learning.
- `forget_learning` — soft-delete a learning.

MCP calls the running HTTP API. It is not another database service.

`search_learnings` accepts a limit up to 20. The v0 retriever returns at most 10 learnings. MCP cannot observe vendor transcripts. A host or wrapper must call an observation adapter or REST endpoint.

## Learning lifecycle

A learning stores:

- A UUID, normalized content, category, and status.
- Optional organization, project, repository, path, and component scope.
- A source agent and optional session ID, message ID, and raw text.
- A SHA-256 fingerprint for idempotency.
- An optional `supersedesMemoryId`.
- Created, updated, and soft-deleted timestamps.

Categories are `architecture`, `convention`, `correction`, `gotcha`, `deprecated`, `behavior`, `review_feedback`, and `other`. `known_gotcha` remains an alias. Statuses are `active`, `superseded`, and `deleted`.

Manual broad learnings can apply to narrow tasks. Native Codex and Claude
teachings default to the authenticated workspace so other connected repositories
can retrieve them; integrations may provide a narrower learning scope.
Repository-scoped knowledge stays in that repository. Path scope applies only
below that path.

Retrieval uses only active learnings in the authenticated workspace and requested scope. It ranks task, diff, path, component, and symbol overlap. Category and scope add boosts. When configured, reciprocal-rank fusion combines that rank with cosine-similar pgvector candidates.

Only complete learnings that fit the item, character, and estimated token budgets are returned and recorded in the delivery receipt.

Corrections preserve history. The old row becomes `superseded`. The active replacement links to it with `supersedesMemoryId`. Retrieval excludes the old row.

Forgetting is a soft delete. An exact active duplicate with the same content, category, scope, and supersedes link returns the existing row. It reports `inserted: false` or increments `duplicates`. A forgotten learning can become a new active row later.

## Tests

Normal checks need no PostgreSQL or external credentials:

```sh
pnpm test
pnpm typecheck
pnpm build
pnpm test:browser
pnpm test:pack
pnpm build:binary
pnpm test:binary
```

Vitest covers paired-turn extraction and reconciliation, redaction, connector retry and idempotency, safe hook installation, GitHub authorization and prompt enrichment, mocked Devin orchestration, adapter scope, retrieval, and SDK requests and errors.
The pack smoke builds `@lore-co/core`, `@lore-co/sdk`,
`@lore-co/adapter-generic`, and `@lore-co/cli`, packs them with pnpm, installs
the tarballs into a temporary non-workspace npm fixture, imports the public
library APIs, and executes the npm-installed `lore` command. The separate
binary smoke compiles and executes the standalone release, installs native
hooks, copies embedded GitHub assets, runs a hook, and disconnects. Neither
command publishes.

Run the PostgreSQL suite:

```sh
pnpm test:db:compose
```

This starts `postgres-test` on port 5433 with an ephemeral `lore_test` database. It refuses non-loopback hosts and database names that do not end in `_test`. It covers migrations, bearer authentication, replay and conflict handling, redaction, correction extraction, cross-agent retrieval, receipts, and the activity API.

Remove only that test service:

```sh
docker compose --profile test rm -sf postgres-test
```

Use an existing safe local test database:

```sh
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/lore_test \
  pnpm test:db
```

`pnpm test` does not connect to PostgreSQL unless `RUN_DATABASE_TESTS=1` or `TEST_DATABASE_URL` is set.

Credential-gated smoke checks never run by default:

```sh
RUN_REAL_AGENT_TESTS=1 \
DEVIN_API_KEY=... \
DEVIN_ORG_ID=... \
  pnpm test
```

They check installed Codex and Claude CLIs and Devin organization authentication. Full vendor-agent quality needs customer credentials. Deterministic tests prove capture and delivery, not LLM compliance.

Run the real native-agent acceptance separately after authenticating both
`claude` and `codex` CLIs and connecting their Lore hooks:

```sh
RUN_NATIVE_AGENT_LIVE_TESTS=1 pnpm test:agents:live
```

This launches fresh real sessions in a temporary repository. Claude teaches a
workspace learning that Codex must retrieve, then Codex teaches one that Claude
must retrieve. Each vendor is resumed for a real later correction in the same
explicit session/thread, and a fresh opposite agent must retrieve the new
learning. Source-session IDs, workspace scope, timeouts, Claude spend, Codex
read-only/low-effort execution, and cleanup are checked. This expanded
acceptance has passed with real authenticated Claude and Codex clients. Run it
again with customer credentials and the target Lore deployment before rollout.

The complete release command set is:

```sh
pnpm test:browser
pnpm test:pack
RUN_NATIVE_AGENT_LIVE_TESTS=1 pnpm test:agents:live
RUN_DEVIN_LIVE_TESTS=1 pnpm test:devin:live
RUN_THREE_AGENT_CHAIN_LIVE_TESTS=RUN pnpm test:chain:live
RUN_GITHUB_PR_LIVE_TESTS=1 pnpm test:github:live
```

Only browser and package smoke are non-credentialed. The four live commands are
explicit gates and are not invoked by `pnpm test`.

## v0 limitations

- Hybrid retrieval needs an embedding provider. lore does not learn ranking weights from delivery outcomes or relevance feedback.
- Hybrid extraction can improve correction recall. Provider quality and customer correction results still need measurement.
- Passwordless dashboard sessions and workspace bearer checks are tenant scoped.
  Team invitations, multi-workspace membership, RBAC, billing, connector-token
  administration, and encryption-at-rest policy remain deployment work.
- Common credential patterns are redacted before event and provenance storage. No heuristic redactor can find every secret.
- Reconciliation handles duplicates and clear contradictions. It does not build a general knowledge graph.
- Token use is estimated from UTF-8 bytes. Exact tokenization and reserved windows depend on the adapter and model.
- Codex and Claude Code use mandatory native-hook paths after connection.
- Dynamic Devin context requires lore-controlled normal sessions. Native
  `/devin review` cannot accept per-review Lore context.
- Direct Devin UI later prompts bypass Lore enrichment; use
  `lore devin prompt`. Registered-session polling is observation after the
  prompt, not pre-send enrichment.
- Devin managed-plugin support remains a closed beta controlled by Devin.
- External model hosts need one-time host-bridge integration.
- Delivery receipts prove context delivery, not that an LLM obeyed it.
- Real-agent smoke suites require customer vendor credentials.
- Lore does not provide dream mode or company-wide search.
