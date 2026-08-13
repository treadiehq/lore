# `@lore-co/devin-plugin`

Fail-open bridge from Devin's managed `UserPromptSubmit` hook to Lore.

The bridge supplies relevant Lore context before Devin handles a prompt. It is
not a transcript collector: ambient Devin transcript capture is performed by
the Lore Devin poller. When a hook event includes both
`prior_assistant_message` and `prior_assistant_message_id`, the bridge can send
that paired correction to Lore directly.

## Availability

Cloud installation requires access to Devin's managed-plugin closed beta.
Contact Devin for managed-plugin access before attempting a cloud install.

This repository does not contain an authoritative Devin managed-plugin manifest
format, so it deliberately does not provide a speculative manifest. Configure
the managed `UserPromptSubmit` hook to invoke:

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

The event must identify `hook_event_name` as `UserPromptSubmit` and include
non-empty `session_id`, `prompt_id`, `prompt`, and `cwd` strings. Repository
scope can be supplied as `repository` or `repo`; `scope` may contain `repo`,
`path`, `project`, and `component`. Explicit scope wins over top-level fields,
and `cwd` supplies the path when no explicit path is present.

For direct paired-correction capture, provide
`prior_assistant_message` and `prior_assistant_message_id`. The bridge derives a
stable idempotency key from the session, prompt, and prior-message IDs and calls
`POST /v1/turns`. Without both fields it only calls `POST /v1/context`; ordinary
transcript capture remains the poller's responsibility.

## Development

```sh
pnpm --filter @lore-co/devin-plugin typecheck
pnpm --filter @lore-co/devin-plugin test
pnpm --filter @lore-co/devin-plugin build
```
