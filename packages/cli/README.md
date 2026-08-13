# Lore CLI

The Lore connector installs native Codex and Claude Code lifecycle hooks. Every
prompt retrieves relevant engineering context. A first prompt is observed on
its own; later prompts are paired with the previous assistant response so Lore
can capture explicit corrections.

## Connect

```sh
curl -fsSL https://raw.githubusercontent.com/treadiehq/lore/main/scripts/install.sh | bash
lore connect \
  --url https://lore.example.com \
  --token "$LORE_TOKEN"
```

The standalone binary supports macOS and Linux on x64 and arm64. Downloads are
verified against the release SHA-256 manifest and do not require a JavaScript
runtime. Use `lore update` to install a newer release.

The npm package remains available for JavaScript-based environments:

```sh
npx @lore-co/cli connect \
  --url https://lore.example.com \
  --token "$LORE_TOKEN"
```

Only the npm package scope is `@lore-co`; the installed executable and every
command remain `lore`.

`connect` auto-detects `codex` and `claude`. Use `--agent codex` or
`--agent claude` for an explicit headless install. Configuration is stored in
`~/.lore/config.json` with mode `0600`.

The command merges Lore-owned entries into `~/.codex/hooks.json` and
`~/.claude/settings.json`. Existing settings and hooks are retained, changed
files receive timestamped backups, and rerunning `connect` does not duplicate
entries.

## Inspect or remove

```sh
lore status
lore doctor
lore disconnect
```

All commands also support `--json`. `disconnect` removes only hook handlers
marked as Lore-owned, then deletes Lore's credential, legacy hook runtime,
pending state, and retry queue. It does not remove the installed `lore` binary
or restore a whole backup over newer agent settings.

## Runtime behavior

The hook handler:

- reads native hook JSON from standard input;
- observes and enriches the first prompt in a new session;
- uses `last_assistant_message`, not a potentially stale transcript;
- stores pending state and failed turn requests under `~/.lore`;
- retries one queued request on a later prompt;
- redacts common API keys, bearer tokens, passwords, and private keys;
- times out network calls and always fails open without writing hook errors.

First prompts use `POST /v1/observations` and audited
`POST /v1/context/deliveries`. Paired turns use `POST /v1/turns` with a
workspace bearer token and an `Idempotency-Key` header. Teachings default to
workspace scope so connected agents can share them; the inferred repository
still guides task retrieval. A correction made in one native repository is
therefore workspace-global by default; only an integration that supplies a
narrower learning scope changes that behavior. Observations, paired turns, and
deliveries are visible through Lore activity.

## External hosts

`lore host` gives local services and CI jobs a noninteractive bridge to the
strict audited endpoints:

```sh
LORE_API_URL=http://localhost:3004 \
LORE_WORKSPACE_TOKEN=... \
  lore host deliver --input delivery.json --output prompt

cat webhook-observation.json |
  lore host observe --input - --output json

lore host turn --input incident-turn.json \
  --idempotency-key incident-42:reply-3 \
  --output prompt
```

`deliver`, `observe`, and `turn` accept the exact JSON bodies for
`POST /v1/context/deliveries`, `POST /v1/observations`, and `POST /v1/turns`.
There is no interactive or implicit-stdin fallback: pass `--input <file|->`.
`json` output contains the complete audited response; `context` prints only
returned context; `prompt` safely places that context before the original task
or current user prompt. Standard output contains only the selected result.

Authentication comes from `LORE_API_URL` plus `LORE_WORKSPACE_TOKEN` (or
`LORE_TOKEN`), or `~/.lore/config.json`. Secret command-line flags are
intentionally unavailable. Requests have a bounded timeout. Run
`lore host --help` and `lore host turn --help` for endpoint-specific examples.
Use stable connector, event, and session IDs from the calling model service,
CI run, webhook, or incident; do not generate a new event ID when retrying.
This bridge is a one-time host integration: the host must call it before and
after model turns. `lore connect` cannot intercept an arbitrary external model
API or bot by itself. The Lore web/wiki service is optional; the bridge needs
only a reachable headless Lore API.

## Devin sessions

Create a Lore-enriched Devin session, then send later prompts through the same
audited context-delivery path:

```sh
DEVIN_API_KEY=... DEVIN_ORG_ID=... \
  lore devin start \
  --repo owner/repository \
  --prompt "Fix the failing tests"

DEVIN_API_KEY=... DEVIN_ORG_ID=... \
  lore devin prompt \
  --session devin-session-id \
  --repo owner/repository \
  --prompt "Apply the reviewer correction"
```

Both commands retrieve Lore context with a stable delivery event and receipt.
`devin start` registers the created session for transcript polling.
`devin prompt` re-registers the session before sending, so a paused poller can
capture the later correction. Prompts can also come from `--prompt-file` or
explicit `--stdin`; `--project` narrows retrieval and polling. Use
`--message-as-user-id` on `devin prompt` when Devin impersonation is configured.
Later prompts entered directly in Devin's UI do not pass through Lore delivery
and are not enriched. If the session was registered, transcript polling can
still capture a correction after the fact.

Lore credentials come from `LORE_API_URL` plus `LORE_WORKSPACE_TOKEN`, or from
the stored `~/.lore/config.json`. Devin credentials come from `DEVIN_API_KEY`
and `DEVIN_ORG_ID`. Credential flags are intentionally unavailable. Run
`lore devin start --help` or `lore devin prompt --help` for copy-pasteable
examples.

## GitHub reviews

Install Lore-owned Codex and Devin review workflows into the current
repository:

```sh
OPENAI_API_KEY=... DEVIN_API_KEY=... DEVIN_ORG_ID=org-... \
  lore connect github \
  --repo owner/repository \
  --configure-secrets
```

The installer copies trusted workflow and output-schema templates without
committing them. Codex uses the official Codex action. Devin uses a normal v3
session because the dedicated Devin Review API cannot accept dynamic Lore
context. Reviews run only for same-repository, non-draft pull requests bearing
the corresponding `lore:codex-review` or `lore:devin-review` label.

Generated jobs download a pinned standalone release. Set repository variable
`LORE_CLI_VERSION` to the release tag and, when using a fork, set
`LORE_CLI_REPOSITORY` to its `owner/repository` value. The installer verifies
the downloaded binary before each job invokes `lore` directly.

The workflows require secret `LORE_WORKSPACE_TOKEN` and variable
`LORE_API_URL`. Codex additionally requires secret `OPENAI_API_KEY`. Devin
additionally requires secret `DEVIN_API_KEY` and variable `DEVIN_ORG_ID`.
Review jobs use `contents: read` plus `pull-requests: write` so the workflow
token can inspect and publish PR comments; the correction workflow has
read-only GitHub permissions.
Native `/devin review` cannot accept dynamic Lore context; the generated Lore
workflow uses a normal capped Devin session instead. The optional managed
plugin remains a closed-beta path controlled by Devin availability.

An authorized maintainer can turn a false-positive bot comment into shared
knowledge with:

```text
/lore correct <Lore bot comment URL>

The correction and current behavior go here.
```

## Release acceptance

From the repository root, deterministic unit/integration checks, browser
acceptance, and package-consumer smoke are:

```sh
pnpm test
pnpm typecheck
pnpm build
pnpm test:browser
pnpm test:pack
pnpm build:binary
pnpm test:binary
```

Credential-gated live commands are explicit and separate:

```sh
RUN_NATIVE_AGENT_LIVE_TESTS=1 pnpm test:agents:live
RUN_DEVIN_LIVE_TESTS=1 pnpm test:devin:live
RUN_THREE_AGENT_CHAIN_LIVE_TESTS=RUN pnpm test:chain:live
RUN_GITHUB_PR_LIVE_TESTS=1 pnpm test:github:live
```

The native command covers first prompts and real resumed later turns in both
Claude and Codex. The chain command covers Claude → Devin → fresh Codex and
Claude. Both paths, plus standalone Devin acceptance, have passed with real
authenticated clients. Both GitHub review/correction paths passed target
preflight and exact-head acceptance with a packed current artifact on August
13, 2026. The current acceptance gate preflights a published standalone release.
Rerun all live gates with customer credentials before rollout.
Lore has no dream mode or company-wide search.
