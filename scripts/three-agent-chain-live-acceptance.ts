import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LoreClient,
  type ActivityItem,
} from "../packages/sdk/src/index.js";
import { DevinApiClient } from "../packages/cli/src/devin-client.js";
import {
  assertLearningSource,
  assertRepositoryScoped,
  boundedInteger,
  buildClaudePrintArgs,
  buildCodexExecArgs,
  matchingLearnings,
  milliseconds,
  parseDevinCliResult,
  positiveNumberString,
  runCommand,
  sleep,
  waitForLearning,
  type DevinCliResult,
} from "./live-agent-acceptance-helpers.js";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function progress(message: string): void {
  process.stdout.write(`[three-agent-chain-live] ${message}\n`);
}

async function runCustomerCli(
  command: "start" | "prompt",
  args: readonly string[],
  timeoutMs: number,
): Promise<DevinCliResult> {
  const result = await runCommand({
    label: `Customer-facing lore devin ${command}`,
    executable: process.execPath,
    args: [
      resolve(REPOSITORY_ROOT, "packages/cli/dist/cli.js"),
      "devin",
      command,
      ...args,
    ],
    cwd: REPOSITORY_ROOT,
    timeoutMs,
  });
  return parseDevinCliResult(result.stdout, command);
}

async function waitForActivity(input: {
  lore: LoreClient;
  connector: string;
  agent: string;
  from: string;
  timeoutMs: number;
  pollIntervalMs: number;
  label: string;
  predicate: (activity: ActivityItem) => boolean;
}): Promise<ActivityItem> {
  const deadline = Date.now() + input.timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await input.lore.listActivity({
        connector: input.connector,
        agent: input.agent,
        from: input.from,
        limit: 100,
      });
      const activity = result.activities.find(input.predicate);
      if (activity !== undefined) {
        return activity;
      }
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    await sleep(input.pollIntervalMs);
  }
  throw new Error(
    `${input.label} did not appear in audited Lore activity before timeout${
      lastError instanceof Error ? `; last query failed: ${lastError.message}` : ""
    }`,
    lastError === undefined ? undefined : { cause: lastError },
  );
}

function assertDeliveryActivity(
  activity: ActivityItem,
  input: {
    receiptId: string;
    marker: string;
    label: string;
    sessionId?: string;
  },
): void {
  if (
    activity.event.type !== "context_delivery" ||
    activity.receipt?.id !== input.receiptId ||
    (input.sessionId !== undefined &&
      activity.event.sessionId !== input.sessionId) ||
    !activity.deliveredMemories.some(({ content }) =>
      content.includes(input.marker),
    )
  ) {
    throw new Error(
      `${input.label} did not audit the expected receipt, session, and delivered learning`,
    );
  }
}

async function main(): Promise<void> {
  if (process.env.RUN_THREE_AGENT_CHAIN_LIVE_TESTS !== "RUN") {
    throw new Error(
      "Three-agent live acceptance is disabled. Set RUN_THREE_AGENT_CHAIN_LIVE_TESTS=RUN to acknowledge real Claude, Codex, and capped Devin usage.",
    );
  }

  const apiUrl = required("LORE_API_URL").replace(/\/+$/u, "");
  const token = required("LORE_WORKSPACE_TOKEN");
  const repository =
    process.env.THREE_AGENT_ACCEPTANCE_REPO?.trim() ||
    required("DEVIN_ACCEPTANCE_REPO");
  const organizationId = required("DEVIN_ORG_ID");
  const apiKey = required("DEVIN_API_KEY");
  const createAsUserId =
    process.env.DEVIN_CREATE_AS_USER_ID?.trim() || undefined;
  const commandTimeoutMs = milliseconds(
    process.env,
    "THREE_AGENT_COMMAND_TIMEOUT_MS",
    3 * 60_000,
  );
  const captureTimeoutMs = milliseconds(
    process.env,
    "THREE_AGENT_CAPTURE_TIMEOUT_MS",
    120_000,
  );
  const activityTimeoutMs = milliseconds(
    process.env,
    "THREE_AGENT_ACTIVITY_TIMEOUT_MS",
    120_000,
  );
  const devinTimeoutMs = milliseconds(
    process.env,
    "THREE_AGENT_DEVIN_TIMEOUT_MS",
    20 * 60_000,
  );
  const pollIntervalMs = milliseconds(
    process.env,
    "THREE_AGENT_POLL_INTERVAL_MS",
    5_000,
  );
  const claudeBudgetUsd = positiveNumberString(
    process.env,
    "THREE_AGENT_CLAUDE_MAX_BUDGET_USD",
    "0.50",
  );
  const maxAcu = boundedInteger(
    process.env,
    "THREE_AGENT_DEVIN_MAX_ACU",
    2,
    1,
    10,
  );
  const claudeModel =
    process.env.THREE_AGENT_CLAUDE_MODEL?.trim() || "haiku";
  const codexModel =
    process.env.THREE_AGENT_CODEX_MODEL?.trim() || undefined;
  const nonce =
    process.env.THREE_AGENT_ACCEPTANCE_NONCE?.trim() ||
    Date.now().toString(36).toUpperCase();
  const claudeMarker = `LORE_CHAIN_CLAUDE_${nonce}`;
  const devinMarker = `LORE_CHAIN_DEVIN_${nonce}`;
  const markers = [claudeMarker, devinMarker];
  const claudeSessionId = randomUUID();
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "lore-three-agent-chain-"),
  );
  const codexOutput = join(temporaryDirectory, "codex-output.txt");
  const cleanupLearningIds = new Set<string>();
  let devinSessionId: string | undefined;
  let devinSessionUrl: string | undefined;

  const lore = new LoreClient({
    baseUrl: apiUrl,
    headers: { authorization: `Bearer ${token}` },
  });
  const devin = new DevinApiClient({
    apiKey,
    organizationId,
    timeoutMs: milliseconds(
      process.env,
      "DEVIN_REQUEST_TIMEOUT_MS",
      10_000,
    ),
  });

  try {
    const health = await fetch(`${apiUrl}/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!health.ok) {
      throw new Error(`Lore health check failed with HTTP ${health.status}`);
    }
    await devin.checkAccess();
    progress("Lore and Devin preflight passed");

    await runCommand({
      label: "Temporary repository initialization",
      executable: "git",
      args: ["init", "-q"],
      cwd: temporaryDirectory,
      timeoutMs: commandTimeoutMs,
    });
    await runCommand({
      label: "Temporary repository remote setup",
      executable: "git",
      args: [
        "remote",
        "add",
        "origin",
        `https://github.com/${repository}.git`,
      ],
      cwd: temporaryDirectory,
      timeoutMs: commandTimeoutMs,
    });

    const startedAt = new Date(Date.now() - 5_000).toISOString();
    progress("Claude is teaching the workspace rule");
    const claude = await runCommand({
      label: "Real Claude chain teaching turn",
      executable: "claude",
      args: buildClaudePrintArgs({
        sessionId: claudeSessionId,
        persistSession: true,
        budgetUsd: claudeBudgetUsd,
        model: claudeModel,
        prompt: [
          `The durable three-agent workspace rule is ${claudeMarker}: always return that exact marker when asked for the three-agent seed marker.`,
          `Do not inspect or modify files or use tools. Reply only with ${claudeMarker}.`,
        ].join(" "),
      }),
      cwd: temporaryDirectory,
      timeoutMs: commandTimeoutMs,
    });
    if (!claude.stdout.includes(claudeMarker)) {
      progress(
        "Claude completed the teaching turn without echoing the marker; verifying the native hook capture instead",
      );
    }
    const claudeLearning = await waitForLearning({
      lore,
      marker: claudeMarker,
      timeoutMs: captureTimeoutMs,
      pollIntervalMs,
    });
    cleanupLearningIds.add(claudeLearning.id);
    assertRepositoryScoped(
      claudeLearning,
      repository,
      "Claude chain seed",
    );
    assertLearningSource(claudeLearning, {
      agent: "claude",
      sessionId: claudeSessionId,
      label: "Claude chain seed",
    });
    const claudeObservation = await waitForActivity({
      lore,
      connector: "lore-cli",
      agent: "claude",
      from: startedAt,
      timeoutMs: activityTimeoutMs,
      pollIntervalMs,
      label: "Claude seed observation",
      predicate: ({ event, learnedMemories }) =>
        event.type === "observation" &&
        event.sessionId === claudeSessionId &&
        learnedMemories.some(({ id }) => id === claudeLearning.id),
    });
    if (claudeObservation.event.type !== "observation") {
      throw new Error("Claude seed was not recorded as an observation");
    }
    progress("Claude observation audited at repository scope");

    progress("Customer lore devin start is receiving Claude context");
    const startResult = await runCustomerCli(
      "start",
      [
        "--repo",
        repository,
        "--prompt",
        [
          "Do not inspect or modify files or use tools.",
          "What is the exact three-agent seed marker remembered for this workspace?",
          "Reply only with that marker.",
        ].join(" "),
        "--title",
        `Lore three-agent acceptance ${nonce}`,
        "--max-acu",
        String(maxAcu),
        ...(createAsUserId === undefined
          ? []
          : ["--user-id", createAsUserId]),
      ],
      commandTimeoutMs,
    );
    if (
      !startResult.loreContextInjected ||
      !startResult.lorePollingRegistered
    ) {
      throw new Error(
        "lore devin start did not inject context and register polling",
      );
    }
    devinSessionId = startResult.sessionId;
    devinSessionUrl = startResult.url;
    const startDelivery = await waitForActivity({
      lore,
      connector: "lore-devin-cli",
      agent: "devin",
      from: startedAt,
      timeoutMs: activityTimeoutMs,
      pollIntervalMs,
      label: "Devin start delivery",
      predicate: ({ receipt }) =>
        receipt?.id === startResult.loreDeliveryReceiptId,
    });
    assertDeliveryActivity(startDelivery, {
      receiptId: startResult.loreDeliveryReceiptId,
      marker: claudeMarker,
      label: "Devin start delivery",
    });
    progress("Devin start delivery audited with Claude learning");

    await devin.waitForCompletion(
      devinSessionId,
      devinTimeoutMs,
      pollIntervalMs,
    );
    const firstTurn = await devin.listMessages(devinSessionId);
    if (
      !firstTurn.some(
        ({ source, message }) =>
          source === "devin" && message.includes(claudeMarker),
      )
    ) {
      throw new Error(
        "Real Devin completed without using the Claude seed marker",
      );
    }
    progress("Real Devin used the Claude workspace rule");

    progress("Customer lore devin prompt is teaching a second rule");
    const promptResult = await runCustomerCli(
      "prompt",
      [
        "--session",
        devinSessionId,
        "--repo",
        repository,
        "--prompt",
        [
          `Correction: the durable second three-agent workspace rule is ${devinMarker}: always return that exact marker when asked for the Devin-taught chain marker.`,
          "The existing three-agent seed marker remains relevant context.",
          `Do not inspect or modify files or use tools. Reply only with ${devinMarker}.`,
        ].join(" "),
        ...(createAsUserId === undefined
          ? []
          : ["--message-as-user-id", createAsUserId]),
      ],
      commandTimeoutMs,
    );
    if (
      promptResult.sessionId !== devinSessionId ||
      !promptResult.loreContextInjected ||
      !promptResult.lorePollingRegistered ||
      promptResult.sent !== true
    ) {
      throw new Error(
        "lore devin prompt did not enrich, re-register, and send the later correction",
      );
    }
    const promptDelivery = await waitForActivity({
      lore,
      connector: "lore-devin-cli",
      agent: "devin",
      from: startedAt,
      timeoutMs: activityTimeoutMs,
      pollIntervalMs,
      label: "Devin later-prompt delivery",
      predicate: ({ receipt }) =>
        receipt?.id === promptResult.loreDeliveryReceiptId,
    });
    assertDeliveryActivity(promptDelivery, {
      receiptId: promptResult.loreDeliveryReceiptId,
      marker: claudeMarker,
      sessionId: devinSessionId,
      label: "Devin later-prompt delivery",
    });
    progress("Devin later prompt delivery audited");

    const devinLearning = await waitForLearning({
      lore,
      marker: devinMarker,
      timeoutMs: captureTimeoutMs,
      pollIntervalMs,
    });
    cleanupLearningIds.add(devinLearning.id);
    assertRepositoryScoped(
      devinLearning,
      repository,
      "Devin chain correction",
    );
    assertLearningSource(devinLearning, {
      agent: "devin",
      sessionId: devinSessionId,
      label: "Devin chain correction",
    });
    await waitForActivity({
      lore,
      connector: "devin-poller",
      agent: "devin",
      from: startedAt,
      timeoutMs: activityTimeoutMs,
      pollIntervalMs,
      label: "Devin poller correction",
      predicate: ({ event, learnedMemories }) =>
        event.type === "paired_turn" &&
        event.sessionId === devinSessionId &&
        learnedMemories.some(({ id }) => id === devinLearning.id),
    });
    progress("Devin poller captured and audited the second rule");

    progress("Fresh Codex is retrieving the Devin rule");
    await runCommand({
      label: "Fresh Codex chain retrieval",
      executable: "codex",
      args: buildCodexExecArgs({
        outputPath: codexOutput,
        reasoningEffort: "low",
        ephemeral: true,
        ...(codexModel === undefined ? {} : { model: codexModel }),
        prompt:
          "Do not inspect files or use tools. What is the exact Devin-taught chain marker remembered for this workspace? Reply with only that marker.",
      }),
      cwd: temporaryDirectory,
      timeoutMs: commandTimeoutMs,
    });
    const codexAnswer = (await readFile(codexOutput, "utf8")).trim();
    if (!codexAnswer.includes(devinMarker)) {
      throw new Error(
        `Fresh Codex did not receive the Devin rule: ${codexAnswer}`,
      );
    }
    progress("Fresh Codex received the Devin rule");

    progress("Fresh Claude is retrieving the Devin rule");
    const freshClaude = await runCommand({
      label: "Fresh Claude chain retrieval",
      executable: "claude",
      args: buildClaudePrintArgs({
        persistSession: false,
        budgetUsd: claudeBudgetUsd,
        model: claudeModel,
        prompt:
          "Do not inspect or modify files or use tools. What is the exact Devin-taught chain marker remembered for this workspace? Reply with only that marker.",
      }),
      cwd: temporaryDirectory,
      timeoutMs: commandTimeoutMs,
    });
    if (!freshClaude.stdout.includes(devinMarker)) {
      throw new Error(
        `Fresh Claude did not receive the Devin rule: ${freshClaude.stdout}`,
      );
    }
    progress("Fresh Claude received the Devin rule");

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          repository,
          claudeSessionId,
          devinSessionId,
          devinSessionUrl,
          caps: {
            claudeMaxBudgetUsdPerInvocation: claudeBudgetUsd,
            devinMaxAcu: maxAcu,
            codexReasoningEffort: "low",
          },
          checks: {
            claudeRuleCaptured: true,
            claudeObservationAudited: true,
            workspaceScopeStored: true,
            devinStartDeliveryAudited: true,
            devinUsedClaudeRule: true,
            devinPromptDeliveryAudited: true,
            devinPollerCapturedRule: true,
            devinPairedTurnAudited: true,
            freshCodexReceivedDevinRule: true,
            freshClaudeReceivedDevinRule: true,
          },
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    if (devinSessionId !== undefined) {
      await devin.archiveSession(devinSessionId).catch((error: unknown) => {
        process.stderr.write(
          `Could not archive Devin session ${devinSessionId}: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      });
    }
    for (const marker of markers) {
      const learnings = await matchingLearnings(lore, marker).catch(() => []);
      learnings.forEach(({ id }) => cleanupLearningIds.add(id));
    }
    for (const learningId of cleanupLearningIds) {
      await lore.forgetLearning(learningId).catch((error: unknown) => {
        process.stderr.write(
          `Could not forget chain learning ${learningId}: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      });
    }
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(
      (error: unknown) => {
        process.stderr.write(
          `Could not remove ${temporaryDirectory}: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      },
    );
  }
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPath)).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `Three-agent chain acceptance failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
