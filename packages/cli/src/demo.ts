import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LoreClient, type ActivityItem, type Learning } from "@lore-co/sdk";

const CLAUDE_HOOK_EVENTS = [
  "UserPromptSubmit",
  "Stop",
  "SessionEnd",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoreHook(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || typeof value.command !== "string") {
    return false;
  }
  return (
    value.command.includes("/.lore/bin/lore-hook.mjs") ||
    /(?:^|\s)--owner(?:=|\s+)lore(?:\s|$)/u.test(value.command)
  );
}

export function isolateLoreClaudeHooks(
  settings: unknown,
): Record<string, unknown> {
  if (!isRecord(settings) || !isRecord(settings.hooks)) {
    throw new Error("Claude Lore hooks are not installed");
  }
  const hooks: Record<string, unknown[]> = {};
  for (const event of CLAUDE_HOOK_EVENTS) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) {
      throw new Error(`Claude Lore ${event} hook is not installed`);
    }
    const isolatedGroups = groups.flatMap((group) => {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        return [];
      }
      const isolatedHooks = group.hooks.filter(isLoreHook);
      return isolatedHooks.length === 0
        ? []
        : [{ ...group, hooks: isolatedHooks }];
    });
    if (isolatedGroups.length === 0) {
      throw new Error(`Claude Lore ${event} hook is not installed`);
    }
    hooks[event] = isolatedGroups;
  }
  return { hooks };
}

async function installIsolatedClaudeHooks(directory: string): Promise<void> {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
  const claudeDirectory = join(directory, ".claude");
  await mkdir(claudeDirectory, { recursive: true });
  await writeFile(
    join(claudeDirectory, "settings.local.json"),
    `${JSON.stringify(isolateLoreClaudeHooks(settings), null, 2)}\n`,
    "utf8",
  );
}

export interface DemoConnectorConfig {
  apiUrl: string;
  token: string;
  agents: readonly ("claude" | "codex")[];
}

export interface DemoResult {
  ok: true;
  repository: string;
  learningId: string;
  receiptId: string;
  durationMs: number;
  loreOverheadMs: number;
  fixtureDirectory: string | null;
  checks: {
    correctionCaptured: true;
    pathScoped: true;
    relevantReceipt: true;
    codexFollowedRule: true;
    irrelevantPromptSilent: true;
  };
}

interface DemoArguments {
  json: boolean;
  keep: boolean;
  timeoutMs: number;
  claudeModel: string;
  codexModel?: string;
}

const DEMO_HELP = `lore demo
Run the live Claude-to-Codex proof loop in a temporary repository.

Usage:
  lore demo [options]

Options:
  --timeout-ms <ms>       Per-agent timeout, 10000-300000 (default: 120000)
  --claude-model <name>   Claude model (default: haiku)
  --codex-model <name>    Optional Codex model override
  --keep                   Keep the fixture repository for inspection
  --json                   Print machine-readable output
  --help                   Show this command's help

Examples:
  lore demo
  lore demo --json --keep
`;

function valueAfter(
  args: readonly string[],
  index: number,
  flag: string,
): [string, number] {
  const value = args[index + 1];
  if (value === undefined) {
    throw new Error(`Missing value for ${flag}`);
  }
  return [value, index + 1];
}

function parseArguments(args: readonly string[]): DemoArguments | null {
  const parsed: DemoArguments = {
    json: false,
    keep: false,
    timeoutMs: 120_000,
    claudeModel: "haiku",
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(DEMO_HELP);
      return null;
    }
    if (argument === "--json") {
      parsed.json = true;
      continue;
    }
    if (argument === "--keep") {
      parsed.keep = true;
      continue;
    }
    if (
      argument !== "--timeout-ms" &&
      argument !== "--claude-model" &&
      argument !== "--codex-model"
    ) {
      throw new Error(`Unknown demo option: ${argument ?? ""}`);
    }
    const [value, valueIndex] = valueAfter(args, index, argument);
    index = valueIndex;
    if (argument === "--timeout-ms") {
      const timeoutMs = Number(value);
      if (
        !Number.isInteger(timeoutMs) ||
        timeoutMs < 10_000 ||
        timeoutMs > 300_000
      ) {
        throw new Error("--timeout-ms must be between 10000 and 300000");
      }
      parsed.timeoutMs = timeoutMs;
    } else if (argument === "--claude-model") {
      parsed.claudeModel = value;
    } else {
      parsed.codexModel = value;
    }
  }
  return parsed;
}

async function run(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await new Promise<{ stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = execFileCallback(
          executable,
          [...args],
          {
            cwd,
            encoding: "utf8",
            env: { ...process.env, NO_COLOR: "1" },
            timeout: timeoutMs,
            killSignal: "SIGKILL",
            maxBuffer: 4 * 1024 * 1024,
          },
          (error, stdout, stderr) => {
            if (error !== null) {
              Object.assign(error, { stdout, stderr });
              reject(error);
              return;
            }
            resolve({ stdout, stderr });
          },
        );
        child.stdin?.end();
      },
    );
    return {
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  } catch (error) {
    const details =
      typeof error === "object" &&
      error !== null &&
      "stderr" in error &&
      typeof error.stderr === "string"
        ? error.stderr.trim()
        : "";
    throw new Error(
      `${executable} failed${details === "" ? "" : `:\n${details}`}`,
      { cause: error },
    );
  }
}

async function git(
  cwd: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<void> {
  await run("git", args, cwd, timeoutMs);
}

async function waitForLearning(
  client: LoreClient,
  marker: string,
  repository: string,
  timeoutMs: number,
): Promise<Learning> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await client.listLearnings({
      query: marker,
      repo: repository,
      status: "active",
      limit: 20,
    });
    const learning = response.memories.find((memory) =>
      memory.content.includes(marker),
    );
    if (learning !== undefined) {
      return learning;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Claude correction was not captured before the timeout");
}

function activityTask(activity: ActivityItem): string {
  const request = activity.event.payload.request;
  if (
    typeof request !== "object" ||
    request === null ||
    !("task" in request) ||
    typeof request.task !== "object" ||
    request.task === null ||
    !("task" in request.task) ||
    typeof request.task.task !== "string"
  ) {
    return "";
  }
  return request.task.task;
}

async function waitForDelivery(
  client: LoreClient,
  marker: string,
  timeoutMs: number,
): Promise<ActivityItem> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await client.listActivity({
      type: "context_delivery",
      agent: "codex",
      limit: 50,
    });
    const activity = response.activities.find((item) =>
      activityTask(item).includes(marker),
    );
    if (activity !== undefined) {
      return activity;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Codex delivery receipt was not recorded before the timeout");
}

function claudeArgs(input: {
  prompt: string;
  model: string;
  sessionId?: string;
  resumeSessionId?: string;
}): string[] {
  return [
    "-p",
    "--setting-sources",
    "project,local",
    ...(input.sessionId === undefined
      ? []
      : ["--session-id", input.sessionId]),
    ...(input.resumeSessionId === undefined
      ? []
      : ["--resume", input.resumeSessionId]),
    "--output-format",
    "text",
    "--max-budget-usd",
    "0.50",
    "--model",
    input.model,
    "--tools",
    "",
    "--permission-mode",
    "dontAsk",
    "--no-chrome",
    "--disable-slash-commands",
    input.prompt,
  ];
}

function codexArgs(input: {
  prompt: string;
  outputPath: string;
  model?: string;
  writable: boolean;
}): string[] {
  return [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-hook-trust",
    "--sandbox",
    input.writable ? "workspace-write" : "read-only",
    "-c",
    'model_reasoning_effort="low"',
    ...(input.model === undefined ? [] : ["--model", input.model]),
    "--ephemeral",
    "--output-last-message",
    input.outputPath,
    input.prompt,
  ];
}

export async function runDemoCommand(
  args: readonly string[],
  config: DemoConnectorConfig | null,
): Promise<void> {
  const options = parseArguments(args);
  if (options === null) {
    return;
  }
  if (config === null) {
    throw new Error("Lore is not connected. Run `lore connect` first.");
  }
  if (!config.agents.includes("claude") || !config.agents.includes("codex")) {
    throw new Error(
      "The proof loop requires both Claude and Codex hooks. Re-run `lore connect --agent claude --agent codex`.",
    );
  }

  const startedAt = Date.now();
  const directory = await mkdtemp(join(tmpdir(), "lore-proof-"));
  const sourceDirectory = join(directory, "src");
  const targetPath = join(sourceDirectory, "greeting.ts");
  const unrelatedPath = join(sourceDirectory, "unrelated.ts");
  const codexOutput = join(directory, "codex-output.txt");
  const nonce = Date.now().toString(36).toUpperCase();
  const marker = `LORE_GREETING_${nonce}`;
  const relevantPromptMarker = `LORE_RELEVANT_${nonce}`;
  const irrelevantPromptMarker = `LORE_IRRELEVANT_${nonce}`;
  const repository = `lore-demo/claude-to-codex-${nonce.toLocaleLowerCase()}`;
  const sessionId = randomUUID();
  const client = new LoreClient({
    baseUrl: config.apiUrl,
    headers: { authorization: `Bearer ${config.token}` },
  });
  let learning: Learning | undefined;
  let loreOverheadMs = 0;

  try {
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(
      targetPath,
      'export const greeting = "legacy-greeting";\n',
      "utf8",
    );
    await writeFile(unrelatedPath, "export const unrelated = true;\n", "utf8");
    await installIsolatedClaudeHooks(directory);
    await git(directory, ["init", "-q"], options.timeoutMs);
    await git(
      directory,
      ["config", "user.email", "lore-demo@example.invalid"],
      options.timeoutMs,
    );
    await git(
      directory,
      ["config", "user.name", "Lore Demo"],
      options.timeoutMs,
    );
    await git(
      directory,
      [
        "remote",
        "add",
        "origin",
        `https://github.com/${repository}.git`,
      ],
      options.timeoutMs,
    );
    await git(directory, ["add", "."], options.timeoutMs);
    await git(directory, ["commit", "-qm", "fixture"], options.timeoutMs);
    await writeFile(
      targetPath,
      '// TODO: replace the legacy value\nexport const greeting = "legacy-greeting";\n',
      "utf8",
    );

    const incorrectClaudeResult = await run(
      "claude",
      claudeArgs({
        sessionId,
        model: options.claudeModel,
        prompt:
          'Without reading files or using tools, write only a one-line TypeScript implementation for the greeting constant using the assumed legacy value "legacy-greeting".',
      }),
      directory,
      options.timeoutMs,
    );
    if (
      !incorrectClaudeResult.stdout.includes("legacy-greeting") ||
      incorrectClaudeResult.stdout.includes(marker)
    ) {
      throw new Error(
        "Claude did not produce the expected observable wrong implementation",
      );
    }
    await run(
      "claude",
      claudeArgs({
        resumeSessionId: sessionId,
        model: options.claudeModel,
        prompt: `No. The durable repository rule for src/greeting.ts is: set the greeting constant to the exact value ${marker}, never legacy-greeting.`,
      }),
      directory,
      options.timeoutMs,
    );

    const captureStartedAt = Date.now();
    learning = await waitForLearning(
      client,
      marker,
      repository,
      options.timeoutMs,
    );
    loreOverheadMs += Date.now() - captureStartedAt;
    if (learning.scope.path !== "src/greeting.ts") {
      throw new Error(
        `Expected a src/greeting.ts learning scope, received ${learning.scope.path ?? "repository-wide"}`,
      );
    }

    await run(
      "codex",
      codexArgs({
        outputPath: codexOutput,
        ...(options.codexModel === undefined
          ? {}
          : { model: options.codexModel }),
        writable: true,
        prompt: `${relevantPromptMarker}: Update src/greeting.ts so the greeting constant follows the remembered repository rule. Make the edit and briefly confirm.`,
      }),
      directory,
      options.timeoutMs,
    );
    const relevantReceiptStartedAt = Date.now();
    const relevantActivity = await waitForDelivery(
      client,
      relevantPromptMarker,
      options.timeoutMs,
    );
    loreOverheadMs += Date.now() - relevantReceiptStartedAt;
    if (
      relevantActivity.receipt === null ||
      relevantActivity.receipt.memoryIds.length !== 1 ||
      relevantActivity.receipt.memoryIds[0] !== learning.id
    ) {
      throw new Error(
        "The relevant Codex receipt did not contain exactly the intended learning",
      );
    }
    const receiptHit = relevantActivity.receipt.hits[0];
    if (
      receiptHit?.memoryId !== learning.id ||
      !receiptHit.content.includes(marker) ||
      !receiptHit.reasons.includes("path")
    ) {
      throw new Error(
        "The relevant Codex receipt did not preserve exact match evidence",
      );
    }
    const target = await readFile(targetPath, "utf8");
    if (!target.includes(marker) || target.includes("legacy-greeting")) {
      throw new Error("Codex received the turn but did not apply the learned rule");
    }

    await git(directory, ["add", targetPath], options.timeoutMs);
    await git(
      directory,
      ["commit", "-qm", "apply learned greeting"],
      options.timeoutMs,
    );
    await writeFile(
      unrelatedPath,
      "export const unrelated = false;\n",
      "utf8",
    );
    await run(
      "codex",
      codexArgs({
        outputPath: codexOutput,
        ...(options.codexModel === undefined
          ? {}
          : { model: options.codexModel }),
        writable: false,
        prompt: `${irrelevantPromptMarker}: Inspect only src/unrelated.ts and state its exported boolean. Do not modify files.`,
      }),
      directory,
      options.timeoutMs,
    );
    const irrelevantReceiptStartedAt = Date.now();
    const irrelevantActivity = await waitForDelivery(
      client,
      irrelevantPromptMarker,
      options.timeoutMs,
    );
    loreOverheadMs += Date.now() - irrelevantReceiptStartedAt;
    if (
      irrelevantActivity.receipt !== null &&
      irrelevantActivity.receipt.memoryIds.length > 0
    ) {
      throw new Error("Lore injected context into an unrelated file task");
    }

    const result: DemoResult = {
      ok: true,
      repository,
      learningId: learning.id,
      receiptId: relevantActivity.receipt.id,
      durationMs: Date.now() - startedAt,
      loreOverheadMs,
      fixtureDirectory: options.keep ? directory : null,
      checks: {
        correctionCaptured: true,
        pathScoped: true,
        relevantReceipt: true,
        codexFollowedRule: true,
        irrelevantPromptSilent: true,
      },
    };
    process.stdout.write(
      options.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : [
            "Claude → Codex proof passed.",
            `learning_id: ${result.learningId}`,
            `receipt_id: ${result.receiptId}`,
            `duration_ms: ${result.durationMs}`,
            `lore_overhead_ms: ${result.loreOverheadMs}`,
            ...(result.fixtureDirectory === null
              ? []
              : [`fixture: ${result.fixtureDirectory}`]),
            "",
          ].join("\n"),
    );
  } finally {
    if (learning !== undefined) {
      await client.forgetLearning(learning.id).catch(() => undefined);
    }
    if (!options.keep) {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
