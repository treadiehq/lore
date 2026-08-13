import { execFile } from "node:child_process";
import type { LoreClient, Learning } from "../packages/sdk/src/index.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface RunCommandInput {
  label: string;
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
}

export interface ClaudePrintArgsInput {
  prompt: string;
  budgetUsd: string;
  model: string;
  sessionId?: string;
  resumeSessionId?: string;
  persistSession?: boolean;
}

export interface CodexExecArgsInput {
  prompt: string;
  outputPath: string;
  reasoningEffort: "low" | "medium" | "high";
  model?: string;
  resumeThreadId?: string;
  ephemeral?: boolean;
}

export interface DevinCliResult {
  sessionId: string;
  loreContextInjected: boolean;
  lorePollingRegistered: boolean;
  loreDeliveryReceiptId: string;
  sent?: boolean;
  url?: string;
}

function commandFailureDetail(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  return [
    "stderr" in error && typeof error.stderr === "string"
      ? error.stderr.trim()
      : "",
    "stdout" in error && typeof error.stdout === "string"
      ? error.stdout.trim()
      : "",
  ].find((value) => value !== "");
}

export async function runCommand(
  input: RunCommandInput,
): Promise<CommandResult> {
  try {
    const result = await new Promise<CommandResult>((resolve, reject) => {
      const child = execFile(
        input.executable,
        [...input.args],
        {
          cwd: input.cwd,
          encoding: "utf8",
          env: { ...process.env, NO_COLOR: "1" },
          killSignal: "SIGKILL",
          maxBuffer: 4 * 1024 * 1024,
          timeout: input.timeoutMs,
        },
        (error, stdout, stderr) => {
          if (error !== null) {
            reject(Object.assign(error, { stdout, stderr }));
            return;
          }
          resolve({ stdout, stderr });
        },
      );
      child.stdin?.end();
    });
    return {
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  } catch (error) {
    const detail = commandFailureDetail(error);
    throw new Error(
      `${input.label} failed${
        detail === undefined ? "" : `:\n${detail}`
      }`,
      { cause: error },
    );
  }
}

export function milliseconds(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = environment[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1_000) {
    throw new Error(`${name} must be an integer of at least 1000`);
  }
  return value;
}

export function positiveNumberString(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
): string {
  const value = environment[name]?.trim() || fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

export function boundedInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${name} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return value;
}

export function buildClaudePrintArgs(
  input: ClaudePrintArgsInput,
): string[] {
  if (
    input.sessionId !== undefined &&
    input.resumeSessionId !== undefined
  ) {
    throw new Error("Claude cannot start and resume a session simultaneously");
  }
  if (input.persistSession === false && input.resumeSessionId !== undefined) {
    throw new Error("A resumed Claude session must remain persistent");
  }
  return [
    "-p",
    ...(input.sessionId === undefined
      ? []
      : ["--session-id", input.sessionId]),
    ...(input.resumeSessionId === undefined
      ? []
      : ["--resume", input.resumeSessionId]),
    ...(input.persistSession === false ? ["--no-session-persistence"] : []),
    "--output-format",
    "text",
    "--max-budget-usd",
    input.budgetUsd,
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

export function buildCodexExecArgs(input: CodexExecArgsInput): string[] {
  if (input.resumeThreadId !== undefined && input.ephemeral === true) {
    throw new Error("A resumed Codex thread cannot be ephemeral");
  }
  const configuration = [
    "-c",
    `model_reasoning_effort="${input.reasoningEffort}"`,
  ];
  const model =
    input.model === undefined || input.model.trim() === ""
      ? []
      : ["--model", input.model.trim()];
  if (input.resumeThreadId !== undefined) {
    return [
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-hook-trust",
      "-c",
      'sandbox_mode="read-only"',
      ...configuration,
      ...model,
      "--output-last-message",
      input.outputPath,
      input.resumeThreadId,
      input.prompt,
    ];
  }
  return [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-hook-trust",
    "--sandbox",
    "read-only",
    ...configuration,
    ...model,
    ...(input.ephemeral === true ? ["--ephemeral"] : []),
    "--output-last-message",
    input.outputPath,
    input.prompt,
  ];
}

export function parseCodexThreadId(output: string): string {
  const threadIds = new Set<string>();
  for (const [index, rawLine] of output.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (line === "") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`Codex JSONL line ${index + 1} is invalid JSON`, {
        cause: error,
      });
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as Record<string, unknown>).type === "thread.started" &&
      typeof (parsed as Record<string, unknown>).thread_id === "string"
    ) {
      const threadId = String(
        (parsed as Record<string, unknown>).thread_id,
      ).trim();
      if (threadId !== "") {
        threadIds.add(threadId);
      }
    }
  }
  if (threadIds.size === 0) {
    throw new Error("Codex JSONL did not contain a thread.started thread_id");
  }
  if (threadIds.size > 1) {
    throw new Error("Codex JSONL contained multiple thread IDs");
  }
  return [...threadIds][0] as string;
}

export function parseDevinCliResult(
  output: string,
  command: "start" | "prompt",
): DevinCliResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`lore devin ${command} returned invalid JSON`, {
      cause: error,
    });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).sessionId !== "string" ||
    typeof (parsed as Record<string, unknown>).loreContextInjected !==
      "boolean" ||
    typeof (parsed as Record<string, unknown>).lorePollingRegistered !==
      "boolean" ||
    typeof (parsed as Record<string, unknown>).loreDeliveryReceiptId !==
      "string" ||
    (command === "prompt" &&
      (parsed as Record<string, unknown>).sent !== true)
  ) {
    throw new Error(`lore devin ${command} returned an invalid result`);
  }
  return parsed as DevinCliResult;
}

export async function sleep(durationMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, durationMs));
}

export async function matchingLearnings(
  lore: LoreClient,
  marker: string,
): Promise<Learning[]> {
  const result = await lore.listLearnings({
    query: marker,
    status: "active",
    limit: 20,
  });
  return result.memories.filter(({ content }) => content.includes(marker));
}

export async function waitForLearning(input: {
  lore: LoreClient;
  marker: string;
  timeoutMs: number;
  pollIntervalMs: number;
}): Promise<Learning> {
  const deadline = Date.now() + input.timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const learning = (
        await matchingLearnings(input.lore, input.marker)
      )[0];
      if (learning !== undefined) {
        return learning;
      }
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    await sleep(input.pollIntervalMs);
  }
  throw new Error(
    `Lore did not capture ${input.marker} before timeout${
      lastError instanceof Error ? `; last query failed: ${lastError.message}` : ""
    }`,
    lastError === undefined ? undefined : { cause: lastError },
  );
}

export function assertWorkspaceScoped(
  learning: Learning,
  label: string,
): void {
  if (
    learning.scope.organization === undefined ||
    learning.scope.project !== undefined ||
    learning.scope.repo !== undefined ||
    learning.scope.path !== undefined ||
    learning.scope.component !== undefined
  ) {
    throw new Error(
      `${label} learning ${learning.id} was not stored at workspace scope`,
    );
  }
}

export function assertLearningSource(
  learning: Learning,
  input: { agent: string; sessionId: string; label: string },
): void {
  if (
    learning.source.agent !== input.agent ||
    learning.source.sessionId !== input.sessionId
  ) {
    throw new Error(
      `${input.label} learning ${learning.id} came from ${learning.source.agent}/${
        learning.source.sessionId ?? "unknown-session"
      }, expected ${input.agent}/${input.sessionId}`,
    );
  }
}
