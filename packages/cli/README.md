# Lore CLI

The Lore connector installs native Codex and Claude Code lifecycle hooks and
the Lore OpenCode plugin. For each supported prompt, Lore attempts to retrieve
relevant engineering context. A first prompt is observed on its own; later
prompts are paired with the previous assistant response when valid pending
state is available. Integration and network failures fail open so they do not
block the agent.

## Install and connect

```sh
pnpm install --global @lore-co/cli

lore connect \
  --url https://lore.example.com \
  --token "$LORE_WORKSPACE_TOKEN" \
  --agent claude \
  --agent codex \
  --agent opencode

lore doctor
```

The package requires Node.js 22 or newer and installs the `lore` command.

`connect` auto-detects the `codex`, `claude`, and `opencode` executables and an
existing `~/.config/opencode/opencode.json`. Repeat `--agent claude`,
`--agent codex`, or `--agent opencode` for an explicit headless install.
Configuration is stored in `~/.lore/config.json` with mode `0600`.
Before writing that file or any agent integration, `connect` calls the
authenticated workspace identity endpoint and validates the strict response
and server version. Revoked credentials, unreachable servers, timeouts, and
incompatible servers leave local configuration untouched. Either
`LORE_WORKSPACE_TOKEN` or the legacy `LORE_TOKEN` can provide the token; if
both are set, they must match.
For a review-first rollout in a personal vault or component catalog, follow the
[OpenCode pilot runbook](../../docs/opencode-pilot.md).

The command merges Lore-owned entries into `~/.codex/hooks.json` and
`~/.claude/settings.json`, and merges `@lore-co/opencode` into the
`plugin` array in `~/.config/opencode/opencode.json`. Existing settings, hooks,
keys, and plugins are retained. Changed agent config files receive timestamped
backups, and rerunning `connect` does not duplicate entries or backups.

## Inspect or remove

```sh
lore status
lore doctor
lore disconnect
```

The three commands above also support `--json`. `doctor` checks public
`/health/ready` separately from authenticated workspace identity so unreachable,
unready, and unauthorized states remain distinct. `disconnect` removes only hook
handlers marked as Lore-owned and Lore's OpenCode plugin entry, then deletes
Lore's credential, legacy hook runtime, pending state, and retry queue. It does
not remove the installed `lore` binary or restore a whole backup over newer
agent settings.

## One-command self-hosting

The published CLI embeds the canonical production Compose asset, so no
repository clone is needed:

```sh
lore self-host up
lore self-host status --json
lore self-host reset-owner-password --email owner@example.com
lore self-host down
```

`up` creates `~/.lore/self-host` with mode `0700` and stores its Compose,
environment, and state files with mode `0600`. It generates independent
PostgreSQL, workspace, and owner-bootstrap secrets, starts semver-pinned images,
waits for `/health/ready`, and prints the setup URL and owner bootstrap token.
The bootstrap token is printed only by the first successful `up`; retries reuse
all state and secrets. Use `--headless`, `--state-dir`, `--image-tag`,
`--api-port`, `--dashboard-port`, `--origin`, `--organization`, and `--name`
for automated deployments. Every command has subcommand-specific `--help`, and
`up`, `down`, and `status` support `--json`.

`down` preserves the PostgreSQL volume. Destructive removal requires both
`--volumes --yes`. Password reset links are printed once or can be written to a
new mode-`0600` file with `--output`.

## Runtime behavior

The Claude/Codex command-hook handler:

- reads native hook JSON from standard input;
- observes and enriches the first prompt in a new session;
- uses `last_assistant_message`, not a potentially stale transcript;
- stores pending state and failed turn requests under `~/.lore`;
- retries one queued request on a later prompt;
- redacts common API keys, bearer tokens, passwords, and private keys;
- times out network calls and always fails open without writing hook errors.

First prompts use `POST /v1/observations` and audited
`POST /v1/context/deliveries`. Paired turns use `POST /v1/turns` with a
workspace bearer token and an `Idempotency-Key` header. Automatic teachings
default to repository scope and follow the workspace learning policy. In
`proposal_only` mode, every automatic capture remains proposed and cannot be
retrieved or injected until dashboard review activates it. Rejected,
suppressed, superseded, and deleted learnings are also excluded. Dirty files
and the current directory remain task relevance evidence and do not narrow
every learning. A reconciled correction inherits its target's scope. Only an
explicit correction with clear team-, company-, organization-, or
all-repositories evidence may become organization-only and apply across
repositories. Native retrieval still requires a strong lexical, structural,
symbol, or semantic match. Observations, paired turns, OpenCode plugin events,
and deliveries are visible through Lore activity. OpenCode uses its plugin
lifecycle and never runs through the Claude/Codex command-hook parser.

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
`treadiehq/lore` at `v0.1.5`. Set `LORE_CLI_REPOSITORY` to the publicly
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
