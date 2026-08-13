import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LoreClient } from "../packages/sdk/src/index.js";
import {
  assertLearningSource,
  assertWorkspaceScoped,
  buildClaudePrintArgs,
  buildCodexExecArgs,
  matchingLearnings,
  milliseconds,
  parseCodexThreadId,
  positiveNumberString,
  runCommand,
  waitForLearning,
} from "./live-agent-acceptance-helpers.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function progress(message: string): void {
  process.stdout.write(`[native-agents-live] ${message}\n`);
}

async function main(): Promise<void> {
  if (process.env.RUN_NATIVE_AGENT_LIVE_TESTS !== "1") {
    throw new Error(
      "Live native-agent acceptance is disabled. Set RUN_NATIVE_AGENT_LIVE_TESTS=1 to acknowledge real Claude and Codex usage.",
    );
  }

  const apiUrl = required("LORE_API_URL").replace(/\/+$/u, "");
  const token = required("LORE_WORKSPACE_TOKEN");
  const repository =
    process.env.NATIVE_AGENT_ACCEPTANCE_REPO?.trim() ||
    "treadiehq/retvrn-md";
  const nonce = Date.now().toString(36).toUpperCase();
  const claudeFirstMarker = `LORE_CLAUDE_TO_CODEX_${nonce}`;
  const codexFirstMarker = `LORE_CODEX_TO_CLAUDE_${nonce}`;
  const claudeLaterMarker = `LORE_CLAUDE_LATER_TO_CODEX_${nonce}`;
  const codexLaterMarker = `LORE_CODEX_LATER_TO_CLAUDE_${nonce}`;
  const markers = [
    claudeFirstMarker,
    codexFirstMarker,
    claudeLaterMarker,
    codexLaterMarker,
  ];
  const commandTimeoutMs = milliseconds(
    process.env,
    "NATIVE_AGENT_COMMAND_TIMEOUT_MS",
    3 * 60_000,
  );
  const captureTimeoutMs = milliseconds(
    process.env,
    "NATIVE_AGENT_CAPTURE_TIMEOUT_MS",
    120_000,
  );
  const pollIntervalMs = milliseconds(
    process.env,
    "NATIVE_AGENT_POLL_INTERVAL_MS",
    2_000,
  );
  const claudeBudgetUsd = positiveNumberString(
    process.env,
    "NATIVE_AGENT_CLAUDE_MAX_BUDGET_USD",
    "0.50",
  );
  const claudeModel =
    process.env.NATIVE_AGENT_CLAUDE_MODEL?.trim() || "haiku";
  const codexModel =
    process.env.NATIVE_AGENT_CODEX_MODEL?.trim() || undefined;
  const claudeSessionId = randomUUID();
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "lore-native-agents-"),
  );
  const codexOutput = join(temporaryDirectory, "codex-output.txt");
  const cleanupIds = new Set<string>();
  const lore = new LoreClient({
    baseUrl: apiUrl,
    headers: { authorization: `Bearer ${token}` },
  });

  try {
    const health = await fetch(`${apiUrl}/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!health.ok) {
      throw new Error(`Lore health check failed with HTTP ${health.status}`);
    }
    progress("Lore health check passed");

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

    progress("Starting persistent Codex teaching session");
    const codexInitial = await runCommand({
      label: "Initial Codex teaching turn",
      executable: "codex",
      args: buildCodexExecArgs({
        outputPath: codexOutput,
        reasoningEffort: "low",
        ...(codexModel === undefined ? {} : { model: codexModel }),
        prompt: [
          `Always use ${codexFirstMarker} as the secondary Lore acceptance marker for this workspace.`,
          "This is a durable engineering convention for every connected agent.",
          `Do not inspect files or use tools. Reply only with ${codexFirstMarker}.`,
        ].join(" "),
      }),
      cwd: temporaryDirectory,
      timeoutMs: commandTimeoutMs,
    });
    const codexThreadId = parseCodexThreadId(codexInitial.stdout);
    const codexFirstLearning = await waitForLearning({
      lore,
      marker: codexFirstMarker,
      timeoutMs: captureTimeoutMs,
      pollIntervalMs,
    });
    cleanupIds.add(codexFirstLearning.id);
    assertWorkspaceScoped(codexFirstLearning, "Codex first-prompt");
    assertLearningSource(codexFirstLearning, {
      agent: "codex",
      sessionId: codexThreadId,
      label: "Codex first-prompt",
    });
    progress(
      `Codex first prompt captured from persisted thread ${codexThreadId}`,
    );

    progress("Starting persistent Claude teaching session");
    const claudeInitial = await runCommand({
      label: "Initial Claude teaching turn",
      executable: "claude",
      args: buildClaudePrintArgs({
        sessionId: claudeSessionId,
        persistSession: true,
        budgetUsd: claudeBudgetUsd,
        model: claudeModel,
        prompt: [
          `Always use ${claudeFirstMarker} as the primary Lore acceptance marker for this workspace.`,
          "This is a durable engineering convention for every connected agent.",
          "What is the exact secondary Lore acceptance marker already remembered for this workspace?",
          "Do not inspect or modify files or use tools. Reply with only that secondary marker.",
        ].join(" "),
      }),
      cwd: temporaryDirectory,
      timeoutMs: commandTimeoutMs,
    });
    const claudeFirstLearning = await waitForLearning({
      lore,
      marker: claudeFirstMarker,
      timeoutMs: captureTimeoutMs,
      pollIntervalMs,
    });
    cleanupIds.add(claudeFirstLearning.id);
    assertWorkspaceScoped(claudeFirstLearning, "Claude first-prompt");
    assertLearningSource(claudeFirstLearning, {
      agent: "claude",
      sessionId: claudeSessionId,
      label: "Claude first-prompt",
    });
    if (!claudeInitial.stdout.includes(codexFirstMarker)) {
      throw new Error(
        `Fresh Claude did not receive Codex's first-prompt learning: ${claudeInitial.stdout}`,
      );
    }
    progress(
      `Claude first prompt captured from explicit session ${claudeSessionId}`,
    );
    progress("Fresh Claude received Codex first-prompt learning");

    await runCommand({
      label: "Fresh Codex first-prompt retrieval",
      executable: "codex",
      args: buildCodexExecArgs({
        outputPath: codexOutput,
        reasoningEffort: "low",
        ephemeral: true,
        ...(codexModel === undefined ? {} : { model: codexModel }),
        prompt:
          "Do not inspect files or use tools. What is the exact primary Lore acceptance marker remembered for this workspace? Reply with only the marker.",
      }),
      cwd: temporaryDirectory,
      timeoutMs: commandTimeoutMs,
    });
    const firstCodexAnswer = (await readFile(codexOutput, "utf8")).trim();
    if (!firstCodexAnswer.includes(claudeFirstMarker)) {
      throw new Error(
        `Fresh Codex did not receive Claude's first-prompt learning: ${firstCodexAnswer}`,
      );
    }
    progress("Fresh Codex received Claude first-prompt learning");

    progress("Resuming Claude for real later-turn correction");
    await runCommand({
      label: "Later Claude correction turn",
      executable: "claude",
      args: buildClaudePrintArgs({
        resumeSessionId: claudeSessionId,
        persistSession: true,
        budgetUsd: claudeBudgetUsd,
        model: claudeModel,
        prompt: [
          "Correction: that response only covered the secondary marker.",
          `The durable corrected primary convention for this workspace is ${claudeLaterMarker}: always return that exact marker when asked for the corrected Claude later-turn marker.`,
          `Do not inspect or modify files or use tools. Reply only with ${claudeLaterMarker}.`,
        ].join(" "),
      }),
      cwd: temporaryDirectory,
      timeoutMs: commandTimeoutMs,
    });
    const claudeLaterLearning = await waitForLearning({
      lore,
      marker: claudeLaterMarker,
      timeoutMs: captureTimeoutMs,
      pollIntervalMs,
    });
    cleanupIds.add(claudeLaterLearning.id);
    assertWorkspaceScoped(claudeLaterLearning, "Claude later-turn");
    assertLearningSource(claudeLaterLearning, {
      agent: "claude",
      sessionId: claudeSessionId,
      label: "Claude later-turn",
    });
    progress("Claude later-turn correction captured from the resumed session");

    await runCommand({
      label: "Fresh Codex later-turn retrieval",
      executable: "codex",
      args: buildCodexExecArgs({
        outputPath: codexOutput,
        reasoningEffort: "low",
        ephemeral: true,
        ...(codexModel === undefined ? {} : { model: codexModel }),
        prompt:
          "Do not inspect files or use tools. What is the exact corrected Claude later-turn marker remembered for this workspace? Reply with only the marker.",
      }),
      cwd: temporaryDirectory,
      timeoutMs: commandTimeoutMs,
    });
    const laterCodexAnswer = (await readFile(codexOutput, "utf8")).trim();
    if (!laterCodexAnswer.includes(claudeLaterMarker)) {
      throw new Error(
        `Fresh Codex did not receive Claude's later-turn correction: ${laterCodexAnswer}`,
      );
    }
    progress("Fresh Codex received Claude later-turn correction");

    progress("Resuming Codex for real later-turn correction");
    await runCommand({
      label: "Later Codex correction turn",
      executable: "codex",
      args: buildCodexExecArgs({
        outputPath: codexOutput,
        reasoningEffort: "low",
        resumeThreadId: codexThreadId,
        ...(codexModel === undefined ? {} : { model: codexModel }),
        prompt: [
          "Correction: the previous response used only the original secondary marker.",
          `The durable corrected secondary convention for this workspace is ${codexLaterMarker}: always return that exact marker when asked for the corrected Codex later-turn marker.`,
          `Do not inspect files or use tools. Reply only with ${codexLaterMarker}.`,
        ].join(" "),
      }),
      cwd: temporaryDirectory,
      timeoutMs: commandTimeoutMs,
    });
    const codexLaterLearning = await waitForLearning({
      lore,
      marker: codexLaterMarker,
      timeoutMs: captureTimeoutMs,
      pollIntervalMs,
    });
    cleanupIds.add(codexLaterLearning.id);
    assertWorkspaceScoped(codexLaterLearning, "Codex later-turn");
    assertLearningSource(codexLaterLearning, {
      agent: "codex",
      sessionId: codexThreadId,
      label: "Codex later-turn",
    });
    progress("Codex later-turn correction captured from the resumed thread");

    const freshClaude = await runCommand({
      label: "Fresh Claude later-turn retrieval",
      executable: "claude",
      args: buildClaudePrintArgs({
        persistSession: false,
        budgetUsd: claudeBudgetUsd,
        model: claudeModel,
        prompt:
          "Do not inspect or modify files or use tools. What is the exact corrected Codex later-turn marker remembered for this workspace? Reply with only the marker.",
      }),
      cwd: temporaryDirectory,
      timeoutMs: commandTimeoutMs,
    });
    if (!freshClaude.stdout.includes(codexLaterMarker)) {
      throw new Error(
        `Fresh Claude did not receive Codex's later-turn correction: ${freshClaude.stdout}`,
      );
    }
    progress("Fresh Claude received Codex later-turn correction");

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          repository,
          claudeSessionId,
          codexThreadId,
          checks: {
            claudeFirstPromptCaptured: true,
            workspaceScopeStored: true,
            freshCodexReceivedClaudeLearning: true,
            codexFirstPromptCaptured: true,
            freshClaudeReceivedCodexLearning: true,
            claudeLaterTurnCapturedFromResumedSession: true,
            freshCodexReceivedClaudeLaterTurn: true,
            codexLaterTurnCapturedFromResumedThread: true,
            freshClaudeReceivedCodexLaterTurn: true,
          },
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    for (const marker of markers) {
      const learnings = await matchingLearnings(lore, marker).catch(() => []);
      learnings.forEach(({ id }) => cleanupIds.add(id));
    }
    const cleanupErrors: string[] = [];
    for (const id of cleanupIds) {
      await lore.forgetLearning(id).catch((error: unknown) => {
        cleanupErrors.push(
          `Could not forget learning ${id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(
      (error: unknown) => {
        cleanupErrors.push(
          `Could not remove ${temporaryDirectory}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    );
    if (cleanupErrors.length > 0) {
      process.stderr.write(
        `Native acceptance cleanup warnings:\n${cleanupErrors
          .map((error) => `- ${error}`)
          .join("\n")}\n`,
      );
    }
  }
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPath)).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `Native agent acceptance failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
