import assert from "node:assert/strict";
import {
  closeDatabase,
  createDatabase,
} from "../packages/database/src/index.js";
import { ClaudeAdapter } from "../packages/adapters/claude/src/index.js";
import { CodexAdapter } from "../packages/adapters/codex/src/index.js";
import { DevinAdapter } from "../packages/adapters/devin/src/index.js";

const apiUrl =
  process.env.LORE_API_URL?.trim().replace(/\/+$/u, "") ||
  "http://localhost:3004";
const workspaceToken = process.env.LORE_WORKSPACE_TOKEN?.trim();
if (workspaceToken === undefined || workspaceToken === "") {
  throw new Error("LORE_WORKSPACE_TOKEN is required for the local simulator");
}
const adapterOptions = {
  baseUrl: apiUrl,
  headers: { authorization: `Bearer ${workspaceToken}` },
};

const STRIPE_TEACHING =
  "Never call Stripe directly from API handlers. Use BillingService.";
const STRIPE_MEMORY =
  "API handlers must use BillingService instead of accessing Stripe directly.";
const REPOSITORY_CORRECTION =
  "No, RepositoryFactory is deprecated. Use AccountStore instead.";
const REPOSITORY_MEMORY =
  "RepositoryFactory is deprecated. Use AccountStore instead.";
const DEMO_ORGANIZATION =
  process.env.LORE_WORKSPACE_ORGANIZATION?.trim() || "local";

interface LocalFinding {
  rule: string;
  message: string;
}

function deterministicStripeReview(
  prompt: string,
  diff: string,
): LocalFinding[] {
  const hasInjectedRule = prompt.includes(STRIPE_MEMORY);
  const callsStripeDirectly = /\bstripe\.customers\.update\s*\(/u.test(diff);
  return hasInjectedRule && callsStripeDirectly
    ? [
        {
          rule: "shared-memory/direct-stripe",
          message:
            "Direct Stripe call detected; route this update through BillingService.",
        },
      ]
    : [];
}

function evidence(label: string, value: unknown): void {
  console.log(`${label}: ${JSON.stringify(value)}`);
}

async function requireApi(): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/health`);
  } catch (error) {
    throw new Error(
      `Cannot reach the lore API at ${apiUrl}. Start PostgreSQL, migrate, and run pnpm dev first.`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error(
      `lore API health check failed with HTTP ${response.status}`,
    );
  }
}

async function resetDemoData(): Promise<void> {
  const connection = createDatabase();
  try {
    await connection.client`
      DELETE FROM memories
      WHERE organization = ${DEMO_ORGANIZATION}
        AND project = 'simulator'
    `;
  } finally {
    await closeDatabase(connection);
  }
}

async function stripeFlow(): Promise<void> {
  const scope = {
    organization: DEMO_ORGANIZATION,
    project: "simulator",
    repo: "payments",
  };
  const diff =
    "+ await stripe.customers.update(customerId, { email: input.email });";
  const task = {
    ...scope,
    review: true,
    task: "Review the customer update API handler",
    diff,
    files: ["src/api/customers.ts"],
    symbols: ["stripe.customers.update"],
  };

  console.log("\nDemonstration 1 — Claude teaching reaches fresh Codex context");
  const baseline = await new CodexAdapter(adapterOptions).prepareTask(task);
  const baselineHasFact = baseline.memories.some(
    (memory) => memory.content === STRIPE_MEMORY,
  );
  const baselineFindings = deterministicStripeReview(baseline.prompt, diff);
  assert.equal(baselineHasFact, false);
  assert.equal(baseline.prompt.includes(STRIPE_MEMORY), false);
  assert.deepEqual(baselineFindings, []);
  console.log("Baseline: fresh Codex adapter prompt has no Stripe rule.");

  const observation = await new ClaudeAdapter({
    ...adapterOptions,
  }).observe({
    ...scope,
    sessionId: "local-demo-claude-development",
    messages: [
      {
        role: "human",
        id: "local-demo-stripe-teaching",
        content: STRIPE_TEACHING,
      },
    ],
  });
  assert.equal(observation.memories.length, 1);
  assert.equal(observation.created + observation.duplicates, 1);
  assert.equal(observation.memories[0]?.content, STRIPE_MEMORY);
  assert.equal(observation.memories[0]?.source.agent, "claude");

  const learned = await new CodexAdapter(adapterOptions).prepareTask(task);
  const learnedMemory = learned.memories.find(
    (memory) => memory.content === STRIPE_MEMORY,
  );
  assert.ok(learnedMemory);
  assert.equal(learned.task.agent, "codex");
  assert.ok(learned.prompt.includes(STRIPE_MEMORY));
  const learnedFindings = deterministicStripeReview(learned.prompt, diff);
  assert.deepEqual(learnedFindings, [
    {
      rule: "shared-memory/direct-stripe",
      message:
        "Direct Stripe call detected; route this update through BillingService.",
    },
  ]);

  evidence("Stored", {
    id: learnedMemory.id,
    created: observation.created,
    duplicates: observation.duplicates,
    source: learnedMemory.source,
  });
  evidence("Injected into new Codex adapter", {
    targetAgent: learned.task.agent,
    memory: learnedMemory.content,
  });
  evidence("Deterministic local review", learnedFindings);
}

async function repositoryCorrectionFlow(): Promise<void> {
  const scope = {
    organization: DEMO_ORGANIZATION,
    project: "simulator",
    repo: "accounts",
  };
  const task = {
    ...scope,
    task: "Implement account persistence",
    files: ["src/accounts/persistence.ts"],
    symbols: ["RepositoryFactory", "AccountStore"],
  };

  console.log(
    "\nDemonstration 2 — Devin-session correction reaches fresh Claude context",
  );
  const baseline = await new ClaudeAdapter(adapterOptions).prepareTask(task);
  const baselineHasFact = baseline.memories.some(
    (memory) => memory.content === REPOSITORY_MEMORY,
  );
  assert.equal(baselineHasFact, false);
  assert.equal(baseline.prompt.includes(REPOSITORY_MEMORY), false);
  console.log("Baseline: fresh Claude adapter prompt has no correction.");

  const observation = await new DevinAdapter(adapterOptions).observe({
    ...scope,
    session_id: "local-demo-devin-review",
    messages: [
      {
        type: "devin_message",
        message: "Use RepositoryFactory for account persistence.",
        messageId: "local-demo-devin-review-message",
      },
      {
        type: "user_message",
        message: REPOSITORY_CORRECTION,
        messageId: "local-demo-human-correction",
      },
    ],
  });
  assert.equal(observation.memories.length, 1);
  assert.equal(observation.created + observation.duplicates, 1);
  assert.equal(observation.memories[0]?.content, REPOSITORY_MEMORY);
  assert.equal(observation.memories[0]?.category, "correction");
  assert.equal(observation.memories[0]?.source.agent, "devin");

  const corrected = await new ClaudeAdapter(adapterOptions).prepareTask(
    task,
  );
  const correctedMemory = corrected.memories.find(
    (memory) => memory.content === REPOSITORY_MEMORY,
  );
  assert.ok(correctedMemory);
  assert.equal(corrected.task.agent, "claude");
  assert.ok(corrected.prompt.includes(REPOSITORY_MEMORY));

  evidence("Stored correction", {
    id: correctedMemory.id,
    created: observation.created,
    duplicates: observation.duplicates,
    source: correctedMemory.source,
  });
  evidence("Injected into new Claude adapter", {
    targetAgent: corrected.task.agent,
    memory: correctedMemory.content,
  });
}

async function main(): Promise<void> {
  console.log("lore LOCAL SIMULATOR");
  console.log(
    "Uses adapter classes plus a deterministic local reviewer; no Claude, Codex, or Devin vendor agent is launched.",
  );
  console.log(`API: ${apiUrl}`);
  await requireApi();
  await resetDemoData();
  console.log(`Reset isolated demo scope: ${DEMO_ORGANIZATION}`);
  await stripeFlow();
  await repositoryCorrectionFlow();
  console.log("\nAll local simulator assertions passed.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
