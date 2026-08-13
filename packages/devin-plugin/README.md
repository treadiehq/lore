# Lore for Devin

The supported production integration uses the `lore` CLI and server-side
transcript polling:

```sh
lore devin setup

lore devin start \
  --repo owner/repository \
  --prompt "Fix the failing tests"

lore devin prompt \
  --session devin-session-id \
  --repo owner/repository \
  --prompt "Apply the reviewer correction"
```

Set `DEVIN_API_KEY` and `DEVIN_ORG_ID` in the environment. Configure the Lore
API with the same credentials, enable polling, and add customer repositories to
`DEVIN_REPOSITORY_ALLOWLIST`.

## Internal prototype

`@lore-co/devin-plugin` is private and is not a published or installable Devin
plugin. Its executable is a fail-open bridge for a host wrapper that normalizes a
`UserPromptSubmit` event into Lore's current JSON contract. It can supply
relevant Lore context before Devin handles a prompt. It is not a transcript
collector; ambient capture is performed by the Lore Devin poller.

## Availability

This repository does not include a Devin plugin manifest or hook configuration,
so the package cannot be installed directly as a managed plugin. Its input also
requires a `cwd` field and supports prior-assistant fields that are wrapper
extensions rather than standard Devin event fields. Do not attach the
executable directly to an unmodified Devin hook event.

A compatible wrapper may invoke:

```sh
lore-devin-hook
```

The executable reads one JSON event from standard input and, when Lore returns
context, writes one JSON object to standard output:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "Relevant Lore context"
  }
}
```

On invalid input, missing configuration, timeout, or any Lore error, it exits
successfully without output or diagnostic noise so Devin can continue.

## Configuration

- `LORE_API_URL` — Lore API base URL, for example `https://lore.example.com`.
- `LORE_WORKSPACE_TOKEN` — workspace bearer token.
- `LORE_DEVIN_REPO` — optional repository fallback when the event has no
  repository scope.
- `LORE_DEVIN_TIMEOUT_MS` — optional request timeout. Values are bounded to
  100–5000 ms; the default is 2000 ms.

The normalized event must identify `hook_event_name` as `UserPromptSubmit` and
include non-empty `session_id`, `prompt_id`, `prompt`, and `cwd` strings.
Repository scope can be supplied as `repository` or `repo`; `scope` may contain
`repo`, `path`, `project`, and `component`. Explicit scope wins over top-level
fields, and `cwd` supplies the path when no explicit path is present.

For direct paired-correction capture, provide
the wrapper extensions `prior_assistant_message` and
`prior_assistant_message_id`. The bridge derives a stable idempotency key from
the session, prompt, and prior-message IDs and calls `POST /v1/turns`. Without
both fields it only calls the compatibility `POST /v1/context`; ordinary
transcript capture remains the poller's responsibility.

For deployment and implementation details, see the
[technical and development guide](../../docs/detailed.md#connect-devin).
