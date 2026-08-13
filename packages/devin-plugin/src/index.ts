import { createHash } from "node:crypto";
import { stripLoreInjectedContext } from "@lore-co/core";

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BYTES = 512 * 1024;
export const MAX_REQUEST_BYTES = 256 * 1024;
export const MAX_CONTEXT_BYTES = 12_000;
export const MAX_STDOUT_BYTES = 64 * 1024;
export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 5_000;
export const DEFAULT_TIMEOUT_MS = 2_000;

const MAX_ID_BYTES = 500;
const MAX_PROMPT_BYTES = 100_000;
const MAX_ASSISTANT_MESSAGE_BYTES = 100_000;
const MAX_REPO_BYTES = 1_000;
const MAX_PATH_BYTES = 2_000;
const MAX_SCOPE_VALUE_BYTES = 500;
const MAX_URL_BYTES = 2_048;
const MAX_TOKEN_BYTES = 8_192;

type Environment = Readonly<Record<string, string | undefined>>;

export interface DevinHookScope {
  project?: string;
  repo?: string;
  path?: string;
  component?: string;
}

export interface DevinUserPromptSubmit {
  hookEventName: "UserPromptSubmit";
  sessionId: string;
  promptId: string;
  prompt: string;
  cwd: string;
  scope?: DevinHookScope;
  priorAssistantMessage?: string;
  priorAssistantMessageId?: string;
}

export interface DevinHookOutput {
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit";
    additionalContext: string;
  };
}

export interface DevinHookHandlerOptions {
  fetch?: typeof globalThis.fetch;
  env?: Environment;
  timeoutMs?: number;
}

export interface DevinHookRunnerOptions extends DevinHookHandlerOptions {
  stdin?: AsyncIterable<unknown>;
  stdout?: NodeJS.WritableStream;
}

interface LoreConfig {
  apiUrl: string;
  token: string;
  timeoutMs: number;
}

class InvalidHookInputError extends Error {}
class ResponseSizeError extends Error {}
class RequestTimeoutError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function requiredString(
  value: unknown,
  field: string,
  maxBytes: number,
): string {
  if (typeof value !== "string") {
    throw new InvalidHookInputError(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (normalized === "" || utf8Length(normalized) > maxBytes) {
    throw new InvalidHookInputError(`${field} has an invalid size`);
  }
  return normalized;
}

function optionalString(
  record: Record<string, unknown>,
  keys: readonly string[],
  maxBytes: number,
): string | undefined {
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) {
      continue;
    }
    return requiredString(record[key], key, maxBytes);
  }
  return undefined;
}

function repositoryFields(
  value: unknown,
): { repo?: string; path?: string } | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return {
      repo: requiredString(value, "repository", MAX_REPO_BYTES),
    };
  }
  if (!isRecord(value)) {
    throw new InvalidHookInputError("repository must be a string or object");
  }
  const repo = optionalString(
    value,
    ["repo", "repository", "full_name", "name"],
    MAX_REPO_BYTES,
  );
  const path = optionalString(
    value,
    ["path", "repository_path"],
    MAX_PATH_BYTES,
  );
  if (repo === undefined && path === undefined) {
    throw new InvalidHookInputError("repository object has no usable scope");
  }
  return {
    ...(repo === undefined ? {} : { repo }),
    ...(path === undefined ? {} : { path }),
  };
}

function parseScope(
  input: Record<string, unknown>,
  cwd: string,
  env: Environment,
): DevinHookScope {
  let nestedScope: Record<string, unknown> | undefined;
  if (Object.hasOwn(input, "scope")) {
    if (!isRecord(input.scope)) {
      throw new InvalidHookInputError("scope must be an object");
    }
    nestedScope = input.scope;
  }

  const topRepository = repositoryFields(input.repository);
  const nestedRepository = repositoryFields(nestedScope?.repository);
  const repo =
    optionalString(nestedScope ?? {}, ["repo"], MAX_REPO_BYTES) ??
    nestedRepository?.repo ??
    optionalString(input, ["repo"], MAX_REPO_BYTES) ??
    topRepository?.repo ??
    optionalString(env, ["LORE_DEVIN_REPO"], MAX_REPO_BYTES);
  const path =
    optionalString(nestedScope ?? {}, ["path"], MAX_PATH_BYTES) ??
    nestedRepository?.path ??
    optionalString(input, ["path", "repository_path"], MAX_PATH_BYTES) ??
    topRepository?.path ??
    cwd;
  const project =
    optionalString(
      nestedScope ?? {},
      ["project"],
      MAX_SCOPE_VALUE_BYTES,
    ) ?? optionalString(input, ["project"], MAX_SCOPE_VALUE_BYTES);
  const component =
    optionalString(
      nestedScope ?? {},
      ["component"],
      MAX_SCOPE_VALUE_BYTES,
    ) ?? optionalString(input, ["component"], MAX_SCOPE_VALUE_BYTES);

  return {
    ...(project === undefined ? {} : { project }),
    ...(repo === undefined ? {} : { repo }),
    path,
    ...(component === undefined ? {} : { component }),
  };
}

export function parseDevinHookEvent(value: unknown): DevinUserPromptSubmit {
  if (!isRecord(value)) {
    throw new InvalidHookInputError("hook input must be an object");
  }
  const hookEventName = requiredString(
    value.hook_event_name,
    "hook_event_name",
    100,
  );
  if (hookEventName !== "UserPromptSubmit") {
    throw new InvalidHookInputError("unsupported hook event");
  }

  const sessionId = requiredString(
    value.session_id,
    "session_id",
    MAX_ID_BYTES,
  );
  const promptId = requiredString(
    value.prompt_id,
    "prompt_id",
    MAX_ID_BYTES,
  );
  const prompt = stripLoreInjectedContext(
    requiredString(value.prompt, "prompt", MAX_PROMPT_BYTES),
  ).trim();
  if (prompt === "") {
    throw new InvalidHookInputError("prompt contains no user content");
  }
  const cwd = requiredString(value.cwd, "cwd", MAX_PATH_BYTES);
  const env: Environment = {};
  const scope = parseScope(value, cwd, env);
  const priorAssistantMessage = optionalString(
    value,
    [
      "prior_assistant_message",
      "previous_assistant_message",
      "last_assistant_message",
    ],
    MAX_ASSISTANT_MESSAGE_BYTES,
  );
  const priorAssistantMessageId = optionalString(
    value,
    [
      "prior_assistant_message_id",
      "previous_assistant_message_id",
      "last_assistant_message_id",
      "previous_turn_id",
    ],
    MAX_ID_BYTES,
  );

  return {
    hookEventName: "UserPromptSubmit",
    sessionId,
    promptId,
    prompt,
    cwd,
    scope,
    ...(priorAssistantMessage === undefined
      ? {}
      : { priorAssistantMessage }),
    ...(priorAssistantMessageId === undefined
      ? {}
      : { priorAssistantMessageId }),
  };
}

function parseEventWithEnvironment(
  value: unknown,
  env: Environment,
): DevinUserPromptSubmit {
  const event = parseDevinHookEvent(value);
  if (!isRecord(value)) {
    throw new InvalidHookInputError("hook input must be an object");
  }
  return {
    ...event,
    scope: parseScope(value, event.cwd, env),
  };
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(value)));
}

function readConfig(
  env: Environment,
  timeoutOverride: number | undefined,
): LoreConfig {
  const apiUrl = requiredString(env.LORE_API_URL, "LORE_API_URL", MAX_URL_BYTES);
  const token = requiredString(
    env.LORE_WORKSPACE_TOKEN,
    "LORE_WORKSPACE_TOKEN",
    MAX_TOKEN_BYTES,
  );
  const parsedUrl = new URL(apiUrl);
  if (
    (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") ||
    parsedUrl.username !== "" ||
    parsedUrl.password !== "" ||
    parsedUrl.search !== "" ||
    parsedUrl.hash !== ""
  ) {
    throw new InvalidHookInputError("LORE_API_URL is not a supported base URL");
  }
  const configuredTimeout =
    timeoutOverride ??
    (env.LORE_DEVIN_TIMEOUT_MS === undefined
      ? undefined
      : Number(env.LORE_DEVIN_TIMEOUT_MS));
  return {
    apiUrl: apiUrl.replace(/\/+$/u, ""),
    token,
    timeoutMs: boundedTimeout(configuredTimeout),
  };
}

function endpoint(config: LoreConfig, path: "/v1/context" | "/v1/turns"): string {
  return `${config.apiUrl}${path}`;
}

function stableTurnId(event: DevinUserPromptSubmit): string {
  const digest = createHash("sha256")
    .update(
      [
        "@lore-co/devin-plugin",
        event.sessionId,
        event.promptId,
        event.priorAssistantMessageId ?? "",
      ].join("\0"),
    )
    .digest("hex");
  return `devin:${digest}`;
}

async function readResponseJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (response.body === null) {
    return undefined;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ResponseSizeError("Lore response is too large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const body = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
    bytes,
  ).toString("utf8");
  if (body.trim() === "") {
    return undefined;
  }
  return JSON.parse(body) as unknown;
}

async function withTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RequestTimeoutError("Lore request timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function postLore(
  config: LoreConfig,
  path: "/v1/context" | "/v1/turns",
  body: unknown,
  fetchImplementation: typeof globalThis.fetch,
  idempotencyKey?: string,
): Promise<unknown> {
  const serializedBody = JSON.stringify(body);
  if (utf8Length(serializedBody) > MAX_REQUEST_BYTES) {
    throw new InvalidHookInputError("Lore request is too large");
  }
  return withTimeout(config.timeoutMs, async (signal) => {
    const response = await fetchImplementation(endpoint(config, path), {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
        ...(idempotencyKey === undefined
          ? {}
          : { "idempotency-key": idempotencyKey }),
        "user-agent": "@lore-co/devin-plugin/0.0.0",
      },
      body: serializedBody,
      signal,
    });
    if (!response.ok) {
      throw new Error(`Lore request failed with HTTP ${response.status}`);
    }
    return readResponseJson(response, signal);
  });
}

function truncateUtf8(value: string, maxBytes: number): string {
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = utf8Length(character);
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    output += character;
    bytes += characterBytes;
  }
  return output;
}

function contextFromResponse(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }
  const candidates: unknown[] = [value.context, value.additionalContext];
  if (isRecord(value.context)) {
    candidates.push(value.context.text);
  }
  if (isRecord(value.hookSpecificOutput)) {
    candidates.push(value.hookSpecificOutput.additionalContext);
  }
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return truncateUtf8(candidate.trim(), MAX_CONTEXT_BYTES);
    }
  }
  return "";
}

function contextRequest(event: DevinUserPromptSubmit): Record<string, unknown> {
  return {
    agent: "devin",
    task: event.prompt,
    ...(event.scope === undefined ? {} : { scope: event.scope }),
  };
}

function turnRequest(
  event: DevinUserPromptSubmit & {
    priorAssistantMessage: string;
    priorAssistantMessageId: string;
  },
  eventId: string,
): Record<string, unknown> {
  return {
    connector: "lore-devin-plugin",
    eventId,
    agent: "devin",
    sessionId: event.sessionId,
    previousAssistant: {
      content: event.priorAssistantMessage,
      id: event.priorAssistantMessageId,
    },
    currentUser: {
      content: event.prompt,
      id: event.promptId,
    },
    ...(event.scope === undefined ? {} : { scope: event.scope }),
    learningScope: {},
    task: event.prompt,
    metadata: {
      cwd: event.cwd,
      promptId: event.promptId,
      previousAssistantMessageId: event.priorAssistantMessageId,
    },
  };
}

function hookOutput(context: string): DevinHookOutput | undefined {
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

export async function handleDevinHookEvent(
  input: unknown,
  options: DevinHookHandlerOptions = {},
): Promise<DevinHookOutput | undefined> {
  try {
    const env = options.env ?? process.env;
    const event = parseEventWithEnvironment(input, env);
    const config = readConfig(env, options.timeoutMs);
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    const hasPairedTurn =
      event.priorAssistantMessage !== undefined &&
      event.priorAssistantMessageId !== undefined;
    if (hasPairedTurn) {
      const pairedEvent = event as DevinUserPromptSubmit & {
        priorAssistantMessage: string;
        priorAssistantMessageId: string;
      };
      const eventId = stableTurnId(pairedEvent);
      const response = await postLore(
        config,
        "/v1/turns",
        turnRequest(pairedEvent, eventId),
        fetchImplementation,
        eventId,
      );
      return hookOutput(contextFromResponse(response));
    }
    const response = await postLore(
      config,
      "/v1/context",
      contextRequest(event),
      fetchImplementation,
    );
    return hookOutput(contextFromResponse(response));
  } catch {
    return undefined;
  }
}

export async function readBoundedHookInput(
  input: AsyncIterable<unknown>,
  maxBytes = MAX_STDIN_BYTES,
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new InvalidHookInputError("input byte limit is invalid");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    let buffer: Buffer;
    if (typeof chunk === "string") {
      buffer = Buffer.from(chunk, "utf8");
    } else if (chunk instanceof Uint8Array) {
      buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    } else {
      throw new InvalidHookInputError("stdin produced an unsupported chunk");
    }
    bytes += buffer.byteLength;
    if (bytes > maxBytes) {
      throw new InvalidHookInputError("hook input is too large");
    }
    chunks.push(buffer);
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const text = decoder.decode(Buffer.concat(chunks, bytes));
  return JSON.parse(text) as unknown;
}

function outputWithContext(context: string): DevinHookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
    },
  };
}

export function serializeDevinHookOutput(
  output: DevinHookOutput | undefined,
): string | undefined {
  if (output === undefined) {
    return undefined;
  }
  const characters = Array.from(output.hookSpecificOutput.additionalContext);
  let low = 0;
  let high = characters.length;
  let serialized = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = JSON.stringify(
      outputWithContext(characters.slice(0, middle).join("")),
    );
    if (utf8Length(candidate) < MAX_STDOUT_BYTES) {
      serialized = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return serialized === "" ? undefined : serialized;
}

async function writeOutput(
  output: NodeJS.WritableStream,
  value: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    output.write(`${value}\n`, (error?: Error | null) => {
      if (error === undefined || error === null) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

export async function runDevinHook(
  options: DevinHookRunnerOptions = {},
): Promise<void> {
  try {
    const stdin = options.stdin ?? process.stdin;
    const stdout = options.stdout ?? process.stdout;
    const input = await readBoundedHookInput(stdin);
    const result = await handleDevinHookEvent(input, options);
    const serialized = serializeDevinHookOutput(result);
    if (serialized !== undefined) {
      await writeOutput(stdout, serialized);
    }
  } catch {
    // Managed hooks must never block Devin when Lore is unavailable or invalid.
  }
}
