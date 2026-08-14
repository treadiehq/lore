# Lore

**Teach one agent once. The others learn too.**

Lore remembers engineering rules and corrections, then shares them with Claude,
Codex, Devin, and other agents when they are relevant.

## Connect

Go to [Lore](https://uselore.co) and sign up to get a workspace token.

Install the CLI with either option:

```sh
# Standalone binary for macOS or Linux
curl -fsSL https://raw.githubusercontent.com/treadiehq/lore/main/scripts/install.sh | bash

# pnpm (Node.js 22+)
pnpm add --global @lore-co/cli
```

Connect Claude and Codex:

```sh
lore connect \
  --url https://lore.example.com \
  --token "your_workspace_token" \
  --agent claude \
  --agent codex

lore doctor
```

The `--agent` flags are optional when Lore detects both clients. Then start
Claude or Codex normally; Lore adds relevant knowledge automatically and shares
clear human corrections across the workspace.

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

## Documentation

- [CLI guide](packages/cli/README.md)
- [TypeScript SDK](packages/sdk/README.md)
- [Generic agent adapter](packages/adapters/generic/README.md)
- [Technical and development guide](docs/detailed.md)

## License

[FSL-1.1-MIT](LICENSE)
