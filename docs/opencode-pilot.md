# OpenCode personal-vault pilot

This runbook tests Lore with normal OpenCode usage in a personal knowledge
vault or component-catalog repository. It starts with every automatic capture
as a proposal, so nothing learned from OpenCode becomes retrievable or
injectable until a person reviews it.

## Pilot shape

Use one repository and one person for the first pilot. Good candidates include:

- a personal engineering vault with durable notes and conventions;
- a component catalog with naming, story, accessibility, and release rules;
- a small documentation repository with frequent, explicit corrections.

Do not start with generated files, secrets, customer data, or a large
multi-repository workspace. Lore stores retained source and provenance for
captured learnings.

The pilot needs:

- a Lore workspace with dashboard access;
- a separate workspace token for the pilot machine;
- OpenCode installed and authenticated with the model provider you normally
  use;
- Node.js 22 or newer when installing the CLI from npm.

## Start in proposal-only mode

In the Lore dashboard, open **Settings**. Under **Automatic learning mode**,
select **Proposal only**, then save.

In `proposal_only` mode:

- manual learnings are active immediately;
- every automatic OpenCode capture has `proposed` status;
- proposed learnings are excluded from retrieval and prompt injection;
- a dashboard reviewer must activate or reject each proposal.

Leave optional LLM conflict analysis off for the first pilot unless the
deployment already has a configured analysis provider. Deterministic,
lexical, and semantic conflict evidence still runs. Model-assisted analysis is
advisory, fails open, never activates a proposal, and is never the sole
blocker.

## Install and connect

Create a named workspace token from the dashboard's **Connect** page. Use a
dedicated token so the pilot can be revoked without affecting another
connector.

Install the Lore CLI:

```sh
# Standalone binary on macOS or Linux
curl -fsSL https://raw.githubusercontent.com/treadiehq/lore/main/scripts/install.sh | bash

# Or install from npm with pnpm
pnpm add --global @lore-co/cli
```

Connect only OpenCode on the pilot machine:

```sh
lore connect \
  --url https://lore.example.com \
  --token "your_workspace_token" \
  --agent opencode

lore doctor
```

`lore connect` adds `@lore-co/opencode` to the existing
`~/.config/opencode/opencode.json` plugin array. It preserves unrelated keys
and plugins, writes a timestamped backup when the file changes, and does not
duplicate the Lore entry when rerun.

## Use OpenCode normally

Start OpenCode as usual from the pilot repository:

```sh
opencode
```

There is no Lore wrapper command. The plugin uses OpenCode's native lifecycle:

1. The first user prompt is observed and receives scoped active context.
2. When OpenCode becomes idle, the plugin stages the latest completed
   assistant response.
3. The next user prompt is paired with that staged response.
4. Lore captures a durable teaching as a proposal and retrieves only active,
   relevant knowledge for the next model request.

Use ordinary work prompts. When OpenCode is wrong, make the correction explicit
and state the durable rule:

```text
No, every new catalog component needs a story file before merge. Keep that as
the repository convention.
```

For a personal vault, a useful correction might be:

```text
Correction: architecture decisions belong under decisions/, not notes/. This
applies to this repository.
```

Avoid asking OpenCode to "remember everything." Capture only stable knowledge
that should affect future work.

## Review proposals

Open **Learnings**, then **Proposal queue**. Open each proposal and check:

- the retained statement says one durable thing;
- the source is the expected OpenCode session and repository;
- repository, path, and component scope are no broader than intended;
- conflict evidence and linked existing learnings support the decision;
- the statement does not contain secrets, temporary task state, or personal
  data.

Add a review reason, then choose:

- **Use proposal** — activates an unblocked proposal. When a blocking
  deterministic replacement target exists, it activates the proposal and
  supersedes that existing learning.
- **Keep existing** — rejects the proposal. Its status becomes `deleted`, and
  it remains unavailable for retrieval and injection.
- **Keep both** — activates the proposal without superseding the related
  learning. Use this only when both statements are valid in distinct contexts,
  and narrow their scopes first when needed.

Warnings are evidence to inspect, not automatic blockers. An unresolved
blocking conflict requires choosing the proposal's deterministic target or
keeping the existing learning; a plain approval cannot bypass it.

After activation, start a fresh OpenCode session and ask a relevant question
without repeating the rule. Open **Activity** in Lore and inspect the
`lore-opencode-plugin` context delivery. Its receipt should include the active
learning. A delivery receipt proves Lore supplied the context; it does not
prove the model followed it.

## Pilot success criteria

Run the pilot for at least five normal OpenCode sessions or one working week.
Call it successful only when all of these are true:

- first prompts and paired turns appear under `lore-opencode-plugin` activity;
- at least three useful proposals are reviewed, with source and scope intact;
- no proposed, rejected, suppressed, superseded, or deleted learning appears
  in a delivery receipt;
- a fresh session retrieves at least one activated repository rule with a
  receipt;
- irrelevant prompts receive no unrelated catalog or vault learning;
- reviewers can resolve every conflict without editing raw storage;
- OpenCode continues normally during a Lore outage or timeout.

Record false captures, missed corrections, wrong scopes, irrelevant
deliveries, and review time. Do not switch to `trust_tiered` until the useful
captures clearly outweigh that review cost.

## Roll back or disconnect

To pause automatic activation while investigating, keep or restore
**Proposal only** in **Settings**. Reject queued proposals that should never be
used. Use **Forget** on an active learning to stop future retrieval while
retaining history.

To disconnect Lore from the machine:

```sh
lore disconnect
lore status --json
```

`lore disconnect` removes Lore-owned Claude/Codex hooks and the Lore OpenCode
plugin entry, then deletes the local Lore credential and runtime state. It does
not uninstall OpenCode or Lore, remove unrelated OpenCode plugins, or delete
server-side learnings and receipts.

The disconnect is machine-wide. If the machine also used Lore with Claude or
Codex, reconnect only the agents that should remain:

```sh
lore connect \
  --url https://lore.example.com \
  --token "your_workspace_token" \
  --agent claude \
  --agent codex
```

Finally, revoke the pilot machine's workspace token from the dashboard. Keep
the workspace in `proposal_only` until the proposal queue and active pilot
learnings have been reviewed.
