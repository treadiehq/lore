# Lore

**Teach one agent once. The others learn too.**

Lore remembers engineering rules and corrections, then shares them with Claude,
Codex, OpenCode, Devin, and other agents when they are relevant.

## Connect

Go to [Lore](https://uselore.co) and sign up to get a workspace token.

Install the CLI with either option:

```sh
# Standalone binary for macOS or Linux
curl -fsSL https://raw.githubusercontent.com/treadiehq/lore/main/scripts/install.sh | bash

# pnpm (Node.js 22+)
pnpm add --global @lore-co/cli
```

Connect Claude, Codex, and OpenCode:

```sh
lore connect \
  --url https://lore.example.com \
  --token "your_workspace_token" \
  --agent claude \
  --agent codex \
  --agent opencode

lore doctor
```

The `--agent` flags are optional when Lore detects installed clients or an
existing OpenCode config. Then start Claude, Codex, or OpenCode normally; Lore
adds active relevant knowledge automatically. Automatic captures follow the
workspace learning policy; in `proposal_only` mode, a reviewer must activate a
proposal before any agent can retrieve it.

```text
No, use AccountStore for account writes. RepositoryFactory is deprecated.
```

## Devin

```sh
lore devin start \
  --repo owner/repository \
  --prompt "Fix the failing tests"
```

Use `lore devin prompt` for later messages that need Lore context.

## GitHub reviews

```sh
lore connect github --repo owner/repository
```

Add `lore:codex-review` or `lore:devin-review` to a pull request. See the
[GitHub setup guide](packages/cli/README.md#github-reviews) for credentials.

## Other agents

Lore includes a TypeScript SDK, a generic adapter, `lore host` commands, and an
optional MCP server.

## Self-hosted dashboard

No Lore Cloud account or email provider is required:

```sh
npx @lore-co/cli self-host up
```

The command generates independent secrets, starts pinned PostgreSQL/API/web
images, waits for readiness, and prints the one-time `/setup` details. Railway,
Coolify, Dokploy, and Fly assets plus backup/upgrade instructions are in the
[self-host guide](docs/detailed.md#self-host-deployment). Source development can
still use `pnpm project:start`.

## Documentation

- [CLI guide](packages/cli/README.md)
- [OpenCode personal-vault pilot](docs/opencode-pilot.md)
- [TypeScript SDK](packages/sdk/README.md)
- [Generic agent adapter](packages/adapters/generic/README.md)
- [Technical and development guide](docs/detailed.md)

## License

[FSL-1.1-MIT](LICENSE)
