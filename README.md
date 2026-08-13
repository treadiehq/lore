# Lore

**Teach one agent once. The others learn too.**

Lore remembers engineering rules and human corrections, then gives them to
Claude, Codex, Devin, and other connected agents when they are relevant.

> **Pre-release:** Lore works, but its public CLI release and npm packages have
> not been published yet. Until then, your Lore administrator must provide the
> CLI or build it from this repository.

## 1. Get your Lore connection

Your Lore administrator gives you:

- a Lore API URL, such as `https://lore.example.com`;
- a workspace token, shown once when it is created.

Use a separate token for each person, machine, or integration so it can be
revoked without affecting anyone else.

Self-hosting? See the [deployment guide](detailed.md#deploy-to-railway).

## 2. Install the CLI

After a public release is available:

```sh
curl -fsSL https://raw.githubusercontent.com/treadiehq/lore/main/scripts/install.sh | bash
```

The installer selects the correct macOS or Linux binary and verifies its
checksum.

## 3. Connect Claude and Codex

```sh
lore connect \
  --url https://lore.example.com \
  --token "your_workspace_token"

lore doctor
```

Now use Claude or Codex normally. Relevant Lore knowledge is added
automatically. When you clearly teach or correct an agent, Lore can share that
learning with other agents in the workspace.

Example:

```text
No, use AccountStore for account writes. RepositoryFactory is deprecated.
```

## Use Lore with Devin

Set `DEVIN_API_KEY` and `DEVIN_ORG_ID`, then start a Lore-enabled session:

```sh
lore devin setup

lore devin start \
  --repo owner/repository \
  --prompt "Fix the failing tests"
```

Send later prompts through Lore so context is added before Devin receives them:

```sh
lore devin prompt \
  --session devin-session-id \
  --repo owner/repository \
  --prompt "Apply the reviewer correction"
```

Prompts typed directly in Devin's UI are not enriched first.

## Use Lore in GitHub reviews

Install the Codex and Devin review workflows:

```sh
lore connect github --repo owner/repository
```

Configure the repository with your Lore URL and token, plus the provider
credentials you use. Then add `lore:codex-review` or `lore:devin-review` to a
pull request.

An authorized maintainer can teach Lore from a review correction:

```text
/lore correct <Lore review comment URL>

Use AccountStore instead.
```

See [GitHub review setup](packages/cli/README.md#github-reviews) for the required
secrets and repository variables.

## Use Lore from another application

Lore includes:

- a TypeScript SDK;
- a generic agent adapter;
- non-interactive `lore host` commands for services, CI, and incident bots;
- an optional MCP server.

External agents need a one-time host integration. See
[generic host integrations](detailed.md#generic-host-integrations).

## What customers get

- Shared learning across agents and sessions.
- Context filtered to the current task, repository, path, or component.
- Provenance and history for every stored learning.
- Auditable context delivery.
- An optional dashboard for browsing and correcting knowledge.

## Current limits

- Public binaries and npm packages still need to be published.
- Native `/devin review` cannot receive Lore context; use Lore's GitHub workflow.
- Direct Devin UI prompts bypass Lore's pre-send enrichment.
- Company-wide chat search and “dream mode” are not included.

## Learn more

- [CLI guide](packages/cli/README.md)
- [Detailed guide](detailed.md)

## License

[FSL-1.1-MIT](LICENSE)
# Lore

**Teach one agent once. The others learn too.**

Lore remembers useful engineering rules and corrections, then gives them to
Claude, Codex, Devin, and other connected agents when they are relevant.

## What Lore does

- Remembers explicit rules and corrections.
- Shares them across agents and sessions.
- Retrieves only knowledge relevant to the current task.
- Keeps a history of where each learning came from.
- Runs with or without the optional web dashboard.

## Start Lore locally

You need Node.js 22+, pnpm, Docker, and Bash.

From this repository:

```sh
corepack enable
pnpm install
pnpm project:start
```

Open <http://localhost:3002/signup>. Enter your organization and email, then
open the sign-in link printed by:

```sh
docker compose logs -f api
```

Lore's API runs at <http://localhost:3004>.

## Connect Claude and Codex

Build the local CLI and load the workspace token created during startup:

```sh
pnpm build:packages
set -a; . ./.env; set +a

node packages/cli/dist/cli.js connect \
  --url http://localhost:3004 \
  --token "$LORE_WORKSPACE_TOKEN"

node packages/cli/dist/cli.js doctor
```

That is it. New prompts receive relevant knowledge, and later human corrections
can become shared learnings.

## Use Devin

Set `DEVIN_API_KEY` and `DEVIN_ORG_ID`, then run:

```sh
node packages/cli/dist/cli.js devin setup

node packages/cli/dist/cli.js devin start \
  --repo owner/repository \
  --prompt "Fix the failing tests"
```

For an existing session, use `lore devin prompt` through the local CLI so Lore
can add context before the message is sent. Prompts typed directly in Devin's
UI are not enriched first.

## Useful commands

```sh
pnpm project:status          # Show running services
pnpm project:logs            # Follow logs
pnpm project:restart         # Restart everything
pnpm project:stop            # Stop everything
pnpm project:headless:start  # Run without the web dashboard
pnpm demo                    # Try a local cross-agent example
```

## Other integrations

Lore also includes:

- GitHub review workflows for Codex and Devin.
- A TypeScript SDK and generic agent adapter.
- Non-interactive `lore host` commands for services, CI, and incident bots.
- An optional MCP server.

These integrations need a one-time host or repository setup. See the
[CLI guide](packages/cli/README.md) and [detailed guide](detailed.md).

## Current limits

- The public CLI release and npm packages still need to be published.
- Native `/devin review` cannot receive Lore context; use Lore's GitHub workflow.
- Arbitrary external agents need a host integration.
- Company-wide chat search and “dream mode” are not included.

## Development

```sh
pnpm test
pnpm typecheck
pnpm build
pnpm test:browser
pnpm test:db:compose
pnpm test:pack
pnpm test:binary
```

## License

[FSL-1.1-MIT](LICENSE)
