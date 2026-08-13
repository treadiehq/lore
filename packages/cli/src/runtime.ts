import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, parse, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { repositoryScopeFromGitRoot } from "./repository.js";

declare const __LORE_VERSION__: string | undefined;
declare const __LORE_STANDALONE__: boolean | undefined;

const RUNTIME_VERSION =
  typeof __LORE_VERSION__ === "string" && __LORE_VERSION__ !== ""
    ? __LORE_VERSION__
    : "0.1.0";
const IS_STANDALONE_RUNTIME =
  typeof __LORE_STANDALONE__ === "boolean" && __LORE_STANDALONE__;

export type AgentName = "codex" | "claude";

interface RuntimeConfig {
  version: 1;
  apiUrl: string;
  token: string;
  agents: AgentName[];
  timeoutMs?: number;
}

interface PendingAssistantMessage {
  agent: AgentName;
  sessionId: string;
  assistantMessage: string;
  cwd?: string;
  turnId?: string;
  capturedAt: string;
}

export interface TurnRequest {
  idempotencyKey: string;
  connector: "lore-cli";
  eventId: string;
  agent: AgentName;
  sessionId: string;
  previousAssistant: {
    content: string;
    id?: string;
    timestamp?: string;
  };
  currentUser: {
    content: string;
    id?: string;
    timestamp?: string;
  };
  occurredAt: string;
  scope?: {
    repo?: string;
    path?: string;
  };
  learningScope: Record<string, never>;
  metadata?: {
    cwd?: string;
    previousTurnId?: string;
    promptId?: string;
  };
}

interface PromptObservationRequest {
  idempotencyKey: string;
  connector?: "lore-cli";
  agent: AgentName;
  sessionId: string;
  eventId: string;
  prompt: string;
  promptId?: string;
  timestamp: string;
  scope?: TurnRequest["scope"];
  learningScope: Record<string, never>;
  metadata?: {
    cwd?: string;
    promptId?: string;
  };
}

type QueuedRequest =
  | { kind: "turn"; request: TurnRequest }
  | { kind: "prompt"; request: PromptObservationRequest };

interface HookInput {
  session_id?: unknown;
  hook_event_name?: unknown;
  cwd?: unknown;
  turn_id?: unknown;
  prompt_id?: unknown;
  prompt?: unknown;
  last_assistant_message?: unknown;
}

export interface HookRuntimeOptions {
  home?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface HookResult {
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit";
    additionalContext: string;
  };
}

const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_CONTEXT_CHARS = 12_000;
const PENDING_ASSISTANT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_QUEUE_ITEMS = 100;

function homeDirectory(override?: string): string {
  return override ?? process.env.HOME ?? homedir();
}

function loreDirectory(home?: string): string {
  return resolve(homeDirectory(home), ".lore");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value
    : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deterministicUuid(value: string): string {
  const hex = sha256(value).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const joined = hex.join("");
  return [
    joined.slice(0, 8),
    joined.slice(8, 12),
    joined.slice(12, 16),
    joined.slice(16, 20),
    joined.slice(20, 32),
  ].join("-");
}

export function redactSecrets(text: string): string {
  return text
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED_API_KEY]")
    .replace(
      /\b(?:github_pat_[A-Za-z0-9_]{16,}|gh[oprsu]_[A-Za-z0-9]{16,})\b/gu,
      "[REDACTED_GITHUB_TOKEN]",
    )
    .replace(
      /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu,
      "[REDACTED_SLACK_TOKEN]",
    )
    .replace(/\bAKIA[A-Z0-9]{16}\b/gu, "[REDACTED_AWS_KEY]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret)\s*[:=]\s*)(["']?)[^\s"',;]{8,}\2/giu,
      "$1[REDACTED]",
    )
    .replace(
      /(authorization\s*:\s*bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu,
      "$1[REDACTED]",
    );
}

async function atomicWriteJson(
  path: string,
  value: unknown,
  mode = 0o600,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode,
    flag: "wx",
  });
  await rename(temporaryPath, path);
  await chmod(path, mode);
}

async function readRuntimeConfig(home?: string): Promise<RuntimeConfig | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(resolve(loreDirectory(home), "config.json"), "utf8"),
    );
    if (
      !isObject(parsed) ||
      parsed.version !== 1 ||
      typeof parsed.apiUrl !== "string" ||
      typeof parsed.token !== "string" ||
      !Array.isArray(parsed.agents)
    ) {
      return null;
    }
    const agents = parsed.agents.filter(
      (agent): agent is AgentName => agent === "codex" || agent === "claude",
    );
    const timeoutMs =
      typeof parsed.timeoutMs === "number" &&
      Number.isInteger(parsed.timeoutMs) &&
      parsed.timeoutMs >= 250 &&
      parsed.timeoutMs <= 10_000
        ? parsed.timeoutMs
        : undefined;
    return {
      version: 1,
      apiUrl: parsed.apiUrl,
      token: parsed.token,
      agents,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
  } catch {
    return null;
  }
}

function pendingPath(
  agent: AgentName,
  sessionId: string,
  home?: string,
): string {
  return resolve(
    loreDirectory(home),
    "state",
    "pending",
    `${sha256(`${agent}\0${sessionId}`)}.json`,
  );
}

async function savePending(
  input: HookInput,
  agent: AgentName,
  sessionId: string,
  now: Date,
  home?: string,
): Promise<void> {
  const assistantMessage = stringField(input.last_assistant_message);
  if (assistantMessage === undefined) {
    return;
  }
  const cwd = stringField(input.cwd);
  const turnId = stringField(input.turn_id);
  await atomicWriteJson(pendingPath(agent, sessionId, home), {
    agent,
    sessionId,
    assistantMessage: redactSecrets(assistantMessage),
    ...(cwd === undefined ? {} : { cwd }),
    ...(turnId === undefined ? {} : { turnId }),
    capturedAt: now.toISOString(),
  } satisfies PendingAssistantMessage);
}

async function consumePending(
  agent: AgentName,
  sessionId: string,
  home?: string,
): Promise<PendingAssistantMessage | null> {
  const path = pendingPath(agent, sessionId, home);
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    await rm(path, { force: true });
    if (
      !isObject(parsed) ||
      parsed.agent !== agent ||
      parsed.sessionId !== sessionId ||
      typeof parsed.assistantMessage !== "string" ||
      typeof parsed.capturedAt !== "string"
    ) {
      return null;
    }
    const capturedAt = Date.parse(parsed.capturedAt);
    if (
      !Number.isFinite(capturedAt) ||
      Date.now() - capturedAt > PENDING_ASSISTANT_MAX_AGE_MS
    ) {
      return null;
    }
    const cwd = stringField(parsed.cwd);
    const turnId = stringField(parsed.turnId);
    return {
      agent,
      sessionId,
      assistantMessage: parsed.assistantMessage,
      ...(cwd === undefined ? {} : { cwd }),
      ...(turnId === undefined ? {} : { turnId }),
      capturedAt: parsed.capturedAt,
    };
  } catch {
    return null;
  }
}

async function repositoryScope(
  cwd: string | undefined,
): Promise<TurnRequest["scope"]> {
  if (cwd === undefined) {
    return undefined;
  }
  let current = resolve(cwd);
  const root = parse(current).root;
  while (true) {
    try {
      await access(resolve(current, ".git"), fsConstants.F_OK);
      const scopedPath = relative(current, resolve(cwd));
      return {
        repo: await repositoryScopeFromGitRoot(current),
        ...(scopedPath === "" ? {} : { path: scopedPath }),
      };
    } catch {
      if (current === root) {
        return {
          repo: await repositoryScopeFromGitRoot(resolve(cwd)),
        };
      }
      current = dirname(current);
    }
  }
}

export async function createTurnRequest(
  input: HookInput,
  agent: AgentName,
  pending: PendingAssistantMessage,
  now: Date,
): Promise<TurnRequest | null> {
  const prompt = stringField(input.prompt);
  if (prompt === undefined) {
    return null;
  }
  const promptId = stringField(input.prompt_id) ?? stringField(input.turn_id);
  const cwd = stringField(input.cwd) ?? pending.cwd;
  const previousAssistantMessage = redactSecrets(pending.assistantMessage);
  const userPrompt = redactSecrets(prompt);
  const idempotencyKey = sha256(
    JSON.stringify({
      agent,
      sessionId: pending.sessionId,
      previousTurnId: pending.turnId,
      promptId,
      previousAssistantMessage,
      userPrompt,
    }),
  );
  const scope = await repositoryScope(cwd);
  return {
    idempotencyKey,
    connector: "lore-cli",
    eventId:
      pending.turnId === undefined && promptId === undefined
        ? deterministicUuid(`lore-turn\0${idempotencyKey}`)
        : deterministicUuid(
            `lore-turn\0${agent}\0${pending.sessionId}\0${pending.turnId ?? ""}\0${promptId ?? ""}`,
          ),
    agent,
    sessionId: pending.sessionId,
    previousAssistant: {
      content: previousAssistantMessage,
      ...(pending.turnId === undefined ? {} : { id: pending.turnId }),
      timestamp: pending.capturedAt,
    },
    currentUser: {
      content: userPrompt,
      ...(promptId === undefined ? {} : { id: promptId }),
      timestamp: now.toISOString(),
    },
    occurredAt: now.toISOString(),
    ...(scope === undefined ? {} : { scope }),
    learningScope: {},
    ...(cwd === undefined &&
    pending.turnId === undefined &&
    promptId === undefined
      ? {}
      : {
          metadata: {
            ...(cwd === undefined ? {} : { cwd }),
            ...(pending.turnId === undefined
              ? {}
              : { previousTurnId: pending.turnId }),
            ...(promptId === undefined ? {} : { promptId }),
          },
        }),
  };
}

function createPromptObservationRequest(
  input: HookInput,
  agent: AgentName,
  sessionId: string,
  now: Date,
  scope?: TurnRequest["scope"],
): PromptObservationRequest | null {
  const prompt = stringField(input.prompt);
  if (prompt === undefined) {
    return null;
  }
  const promptId = stringField(input.prompt_id) ?? stringField(input.turn_id);
  const cwd = stringField(input.cwd);
  const idempotencyKey = sha256(
    JSON.stringify({
      agent,
      sessionId,
      promptId,
      prompt: redactSecrets(prompt),
    }),
  );
  return {
    idempotencyKey,
    connector: "lore-cli",
    agent,
    sessionId,
    eventId: deterministicUuid(
      `lore-prompt\0${agent}\0${sessionId}\0${promptId ?? "first"}`,
    ),
    prompt: redactSecrets(prompt),
    ...(promptId === undefined ? {} : { promptId }),
    timestamp: now.toISOString(),
    ...(scope === undefined ? {} : { scope }),
    learningScope: {},
    ...(cwd === undefined && promptId === undefined
      ? {}
      : {
          metadata: {
            ...(cwd === undefined ? {} : { cwd }),
            ...(promptId === undefined ? {} : { promptId }),
          },
        }),
  };
}

function turnsUrl(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/u, "")}/v1/turns`;
}

function observationsUrl(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/u, "")}/v1/observations`;
}

function contextDeliveriesUrl(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/u, "")}/v1/context/deliveries`;
}

function boundedContext(value: string): string {
  return Array.from(value.trim()).slice(0, MAX_CONTEXT_CHARS).join("");
}

function contextFromResponse(value: unknown): string {
  if (!isObject(value)) {
    return "";
  }
  for (const candidate of [value.context, value.additionalContext]) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return boundedContext(candidate);
    }
  }
  if (isObject(value.hookSpecificOutput)) {
    const candidate = value.hookSpecificOutput.additionalContext;
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return boundedContext(candidate);
    }
  }
  if (isObject(value.context)) {
    const candidate = value.context.text;
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return boundedContext(candidate);
    }
  }
  return "";
}

async function postTurn(
  config: RuntimeConfig,
  request: TurnRequest,
  fetchImplementation: typeof fetch,
): Promise<string> {
  const { idempotencyKey, ...body } = request;
  const response = await fetchImplementation(turnsUrl(config.apiUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      "user-agent": `lore-cli/${RUNTIME_VERSION}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs ?? 2_500),
  });
  if (!response.ok) {
    throw new Error(`Lore turn request failed with HTTP ${response.status}`);
  }
  const text = await response.text();
  if (text.trim() === "") {
    return "";
  }
  return contextFromResponse(JSON.parse(text) as unknown);
}

async function postPromptObservation(
  config: RuntimeConfig,
  request: PromptObservationRequest,
  fetchImplementation: typeof fetch,
): Promise<void> {
  const response = await fetchImplementation(observationsUrl(config.apiUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
      "idempotency-key": request.idempotencyKey,
      "user-agent": `lore-cli/${RUNTIME_VERSION}`,
    },
    body: JSON.stringify({
      connector: request.connector ?? "lore-cli",
      eventId: request.eventId,
      agent: request.agent,
      sessionId: request.sessionId,
      ...(request.scope === undefined ? {} : { scope: request.scope }),
      learningScope: request.learningScope,
      ...(request.prompt === "" ? {} : { task: request.prompt }),
      messages: [
        {
          role: "user",
          content: request.prompt,
          ...(request.promptId === undefined ? {} : { id: request.promptId }),
          timestamp: request.timestamp,
        },
      ],
      occurredAt: request.timestamp,
      ...(request.metadata === undefined
        ? {}
        : { metadata: request.metadata }),
    }),
    signal: AbortSignal.timeout(config.timeoutMs ?? 2_500),
  });
  if (!response.ok) {
    throw new Error(
      `Lore prompt observation failed with HTTP ${response.status}`,
    );
  }
  await response.body?.cancel();
}

async function getPromptContext(
  config: RuntimeConfig,
  agent: AgentName,
  sessionId: string,
  sourceEventId: string,
  prompt: string,
  scope: TurnRequest["scope"],
  fetchImplementation: typeof fetch,
): Promise<string> {
  const response = await fetchImplementation(
    contextDeliveriesUrl(config.apiUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
        "user-agent": `lore-cli/${RUNTIME_VERSION}`,
      },
      body: JSON.stringify({
        connector: "lore-cli",
        eventId: deterministicUuid(`lore-context\0${sourceEventId}`),
        sessionId,
        task: {
          agent,
          task: redactSecrets(prompt),
          ...(scope === undefined ? {} : { scope }),
        },
      }),
      signal: AbortSignal.timeout(config.timeoutMs ?? 2_500),
    },
  );
  if (!response.ok) {
    throw new Error(`Lore context request failed with HTTP ${response.status}`);
  }
  const text = await response.text();
  if (text.trim() === "") {
    return "";
  }
  return contextFromResponse(JSON.parse(text) as unknown);
}

function queueDirectory(home?: string): string {
  return resolve(loreDirectory(home), "queue");
}

async function trimQueue(home?: string): Promise<void> {
  const directory = queueDirectory(home);
  let entries: string[];
  try {
    entries = (await readdir(directory))
      .filter((entry) => entry.endsWith(".json"))
      .sort();
  } catch {
    return;
  }
  const excess = entries.length - MAX_QUEUE_ITEMS + 1;
  if (excess <= 0) {
    return;
  }
  await Promise.all(
    entries
      .slice(0, excess)
      .map(async (entry) => rm(resolve(directory, entry), { force: true })),
  );
}

async function enqueue(request: QueuedRequest, home?: string): Promise<void> {
  await trimQueue(home);
  const path = resolve(
    queueDirectory(home),
    `${request.request.idempotencyKey}.json`,
  );
  await atomicWriteJson(path, request);
}

function isTurnRequest(value: unknown): value is TurnRequest {
  return (
    isObject(value) &&
    typeof value.idempotencyKey === "string" &&
    value.connector === "lore-cli" &&
    typeof value.eventId === "string" &&
    (value.agent === "codex" || value.agent === "claude") &&
    typeof value.sessionId === "string" &&
    isObject(value.previousAssistant) &&
    typeof value.previousAssistant.content === "string" &&
    isObject(value.currentUser) &&
    typeof value.currentUser.content === "string" &&
    typeof value.occurredAt === "string"
  );
}

function isPromptObservationRequest(
  value: unknown,
): value is PromptObservationRequest {
  return (
    isObject(value) &&
    typeof value.idempotencyKey === "string" &&
    (value.agent === "codex" || value.agent === "claude") &&
    typeof value.sessionId === "string" &&
    typeof value.eventId === "string" &&
    typeof value.prompt === "string" &&
    typeof value.timestamp === "string"
  );
}

function queuedRequest(value: unknown): QueuedRequest | null {
  if (isTurnRequest(value)) {
    return { kind: "turn", request: value };
  }
  if (!isObject(value) || !isObject(value.request)) {
    return null;
  }
  if (value.kind === "turn" && isTurnRequest(value.request)) {
    return { kind: "turn", request: value.request };
  }
  if (
    value.kind === "prompt" &&
    isPromptObservationRequest(value.request)
  ) {
    return { kind: "prompt", request: value.request };
  }
  return null;
}

async function retryOne(
  config: RuntimeConfig,
  fetchImplementation: typeof fetch,
  home?: string,
): Promise<void> {
  const directory = queueDirectory(home);
  let first: string | undefined;
  try {
    first = (await readdir(directory))
      .filter((entry) => entry.endsWith(".json"))
      .sort()[0];
  } catch {
    return;
  }
  if (first === undefined) {
    return;
  }
  const path = resolve(directory, first);
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const queued = queuedRequest(parsed);
    if (queued === null) {
      await rm(path, { force: true });
      return;
    }
    if (queued.kind === "turn") {
      await postTurn(config, queued.request, fetchImplementation);
    } else {
      await postPromptObservation(config, queued.request, fetchImplementation);
    }
    await rm(path, { force: true });
  } catch {
    // Retry on a later prompt. Hook failures are deliberately invisible.
  }
}

export async function handleHookEvent(
  value: unknown,
  agent: AgentName,
  options: HookRuntimeOptions = {},
): Promise<HookResult | undefined> {
  if (!isObject(value)) {
    return undefined;
  }
  const input: HookInput = value;
  const eventName = stringField(input.hook_event_name);
  const sessionId = stringField(input.session_id);
  if (eventName === undefined || sessionId === undefined) {
    return undefined;
  }
  const config = await readRuntimeConfig(options.home);
  if (config === null || !config.agents.includes(agent)) {
    return undefined;
  }
  const now = (options.now ?? (() => new Date()))();
  if (eventName === "Stop") {
    await savePending(input, agent, sessionId, now, options.home);
    return undefined;
  }
  if (eventName === "SessionEnd") {
    // Non-interactive Claude and Codex invocations emit SessionEnd even when
    // their persisted session can be resumed. Keep the bounded pending turn so
    // the next invocation can still capture a correction.
    return undefined;
  }
  if (eventName !== "UserPromptSubmit") {
    return undefined;
  }

  const fetchImplementation = options.fetch ?? globalThis.fetch;
  await retryOne(config, fetchImplementation, options.home);
  const pending = await consumePending(agent, sessionId, options.home);
  const prompt = stringField(input.prompt);
  if (prompt === undefined) {
    return undefined;
  }
  let context = "";
  if (pending !== null) {
    const request = await createTurnRequest(input, agent, pending, now);
    if (request === null) {
      return undefined;
    }
    try {
      context = await postTurn(config, request, fetchImplementation);
    } catch {
      try {
        await enqueue({ kind: "turn", request }, options.home);
      } catch {
        // The connector must fail open even when its local queue is unavailable.
      }
      try {
        context = await getPromptContext(
          config,
          agent,
          sessionId,
          request.eventId,
          prompt,
          request.scope,
          fetchImplementation,
        );
      } catch {
        return undefined;
      }
    }
  } else {
    const scope = await repositoryScope(stringField(input.cwd));
    const observation = createPromptObservationRequest(
      input,
      agent,
      sessionId,
      now,
      scope,
    );
    if (observation === null) {
      return undefined;
    }
    try {
      await postPromptObservation(config, observation, fetchImplementation);
    } catch {
      try {
        await enqueue({ kind: "prompt", request: observation }, options.home);
      } catch {
        // The connector must fail open even when its local queue is unavailable.
      }
    }
    try {
      context = await getPromptContext(
        config,
        agent,
        sessionId,
        observation.eventId,
        prompt,
        scope,
        fetchImplementation,
      );
    } catch {
      return undefined;
    }
  }
  if (context === "") {
    return undefined;
  }
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
    },
  };
}

async function readStdin(): Promise<unknown> {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input, "utf8") > MAX_STDIN_BYTES) {
      throw new Error("Hook input is too large");
    }
  }
  return JSON.parse(input) as unknown;
}

function parseAgent(args: readonly string[]): AgentName | null {
  const index = args.indexOf("--agent");
  const value = index < 0 ? undefined : args[index + 1];
  return value === "codex" || value === "claude" ? value : null;
}

export async function runHook(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const agent = parseAgent(args);
  if (agent === null) {
    return;
  }
  try {
    const result = await handleHookEvent(await readStdin(), agent);
    if (result !== undefined) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } catch {
    // Native hooks must never block or add error noise to an agent session.
  }
}

const entryPath = process.argv[1];
if (
  !IS_STANDALONE_RUNTIME &&
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPath)).href
) {
  void runHook();
}
