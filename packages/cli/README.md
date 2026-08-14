# Lore CLI

The Lore connector installs native Codex and Claude Code lifecycle hooks. For
each supported prompt, Lore attempts to retrieve relevant engineering context.
A first prompt is observed on its own; later prompts are paired with the
previous assistant response when valid pending state is available. Hook and
network failures fail open so they do not block the agent.

## Install and connect

```sh
pnpm install --global @lore-co/cli

lore connect \
  --url https://lore.example.com \
  --token "$LORE_WORKSPACE_TOKEN" \
  --agent claude \
  --agent codex

lore doctor
```

The package requires Node.js 22 or newer and installs the `lore` command.

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

The three commands above also support `--json`. `disconnect` removes only hook handlers
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
LORE_API_URL=https://lore.example.com \
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

The Lore API must also have Devin polling enabled with the same
`DEVIN_API_KEY` and `DEVIN_ORG_ID`, and the repository must appear in
`DEVIN_REPOSITORY_ALLOWLIST`. `lore devin setup` checks Devin access and Lore
reachability; `start` performs authenticated delivery and poller-registration
checks.

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

The command overwrites three fixed Lore workflow files and the Lore review
schema without committing them. Review or back up existing files first.
`--configure-secrets` requires authenticated `gh` access and updates the named
Actions secrets and variables in the target repository. Codex uses the
official Codex action. Devin uses a normal v3 session because the dedicated
Devin Review API cannot accept dynamic Lore context. Reviews run only for
same-repository, non-draft pull requests bearing the corresponding
`lore:codex-review` or `lore:devin-review` label.

Generated jobs require a published standalone binary release and default to
`treadiehq/lore` at `v0.1.3`. Set `LORE_CLI_REPOSITORY` to the publicly
readable `owner/repository` and `LORE_CLI_VERSION` to an existing release tag
when using another release source.

The workflows require secret `LORE_WORKSPACE_TOKEN` and variable
`LORE_API_URL`. Codex additionally requires secret `OPENAI_API_KEY`. Devin
additionally requires secret `DEVIN_API_KEY` and variable `DEVIN_ORG_ID`.
Codex separates a read-only review job from its `pull-requests: write` posting
job. The Devin review job uses `contents: read` and `pull-requests: write`.
The correction workflow has read-only GitHub permissions.
Native `/devin review` cannot accept dynamic Lore context; the generated Lore
workflow uses a normal capped Devin session instead. The private Devin hook
prototype is not currently an installable managed plugin.

An authorized maintainer can turn a false-positive bot comment into shared
knowledge with:

```text
/lore correct <Lore bot comment URL>

The correction and current behavior go here.
```

## Production guidance

- Use a dedicated workspace token for each person, machine, or integration.
- Connect only to an HTTPS Lore API outside local development.
- Run `lore doctor` after installation and configuration changes.
- Keep provider credentials in environment variables or GitHub Actions secrets.
- After standalone publication, pin `LORE_CLI_VERSION` in automated workflows
  and update it deliberately.

For source builds, self-hosting, tests, and release internals, see the
[technical and development guide](../../docs/detailed.md).
