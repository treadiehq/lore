import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  ContextDeliveryRequestSchema,
  GENERIC_LORE_CONTEXT_DELIMITERS,
  ObservationRequestSchema,
  PairedTurnRequestSchema,
  type ContextDeliveryRequest,
  type ObservationRequest,
  type PairedTurnRequest,
} from "@lore-co/core";
import { SharedMemoryClient } from "@lore-co/sdk";
import { ZodError } from "zod";

const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 10_000;

export type HostCommand = "deliver" | "observe" | "turn";
export type HostOutput = "json" | "context" | "prompt";

export interface HostConnection {
  apiUrl: string;
  token: string;
  timeoutMs: number;
}

export interface HostCommandOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  fetch?: typeof fetch;
  stdin?: NodeJS.ReadableStream & AsyncIterable<string | Uint8Array>;
  stdout?: { write(value: string): unknown };
}

interface ParsedHostArguments {
  input: string;
  output: HostOutput;
  idempotencyKey?: string;
}

export const HOST_HELP = `lore host
Call Lore's auditable host APIs from services, CI, and webhook handlers.

Usage:
  lore host <command> [options]

Commands:
  deliver   Retrieve context and record a delivery receipt
  observe   Record a stable host event for later learning
  turn      Process an assistant/user pair and retrieve context

Discover:
  lore host deliver --help
  lore host observe --help
  lore host turn --help

Examples:
  lore host deliver --input request.json --output prompt
  cat observation.json | lore host observe --input -
  lore host turn --input turn.json --idempotency-key incident-42:reply-3
`;

export const HOST_DELIVER_HELP = `lore host deliver
Send exact POST /v1/context/deliveries JSON and print its audited result.

Usage:
  lore host deliver --input <file|-> [--output json|context|prompt]

Options:
  --input <file|->       Strict endpoint JSON file, or - for standard input
  --output <format>      json (default), context, or prompt
  --help                 Show this command's help

Examples:
  lore host deliver --input delivery.json --output json
  cat delivery.json | lore host deliver --input - --output prompt
`;

export const HOST_OBSERVE_HELP = `lore host observe
Send exact POST /v1/observations JSON and print its audited event.

Usage:
  lore host observe --input <file|-> [--output json]

Options:
  --input <file|->       Strict endpoint JSON file, or - for standard input
  --output json          Print the JSON response (default)
  --help                 Show this command's help

Examples:
  lore host observe --input webhook-observation.json
  cat observation.json | lore host observe --input -
`;

export const HOST_TURN_HELP = `lore host turn
Send exact POST /v1/turns JSON and print its audited result.

Usage:
  lore host turn --input <file|-> [--output json|context|prompt] [--idempotency-key value]

Options:
  --input <file|->             Strict endpoint JSON file, or - for standard input
  --output <format>            json (default), context, or prompt
  --idempotency-key <value>    Forward a retry-safe Idempotency-Key header
  --help                       Show this command's help

Examples:
  lore host turn --input turn.json --output prompt
  cat turn.json | lore host turn --input - --idempotency-key incident-42:reply-3
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

function commandExample(command: HostCommand): string {
  return `lore host ${command} --input request.json`;
}

function parseHostArguments(
  command: HostCommand,
  args: readonly string[],
): ParsedHostArguments {
  let input: string | undefined;
  let output: HostOutput = "json";
  let idempotencyKey: string | undefined;
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (
      flag !== "--input" &&
      flag !== "--output" &&
      flag !== "--idempotency-key"
    ) {
      throw new Error(
        `Unknown host ${command} option: ${flag ?? ""}\nTry: lore host ${command} --help`,
      );
    }
    if (seen.has(flag)) {
      throw new Error(`Host ${command} option may be provided once: ${flag}`);
    }
    seen.add(flag);
    const [value, valueIndex] = valueAfter(args, index, flag);
    index = valueIndex;
    if (flag === "--input") {
      input = value;
    } else if (flag === "--output") {
      if (value !== "json" && value !== "context" && value !== "prompt") {
        throw new Error("--output must be json, context, or prompt");
      }
      output = value;
    } else {
      idempotencyKey = value;
    }
  }

  if (input === undefined || input.trim() === "") {
    throw new Error(
      `--input <file|-> is required; no interactive fallback is available.\nExample: ${commandExample(command)}`,
    );
  }
  if (command === "observe" && output !== "json") {
    throw new Error("lore host observe supports only --output json");
  }
  if (command !== "turn" && idempotencyKey !== undefined) {
    throw new Error("--idempotency-key is available only for lore host turn");
  }
  if (idempotencyKey === "") {
    throw new Error("--idempotency-key must not be empty");
  }
  return {
    input,
    output,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
}

function normalizeApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid Lore API URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Lore API URL must use http or https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("Lore API URL must not contain credentials");
  }
  url.hash = "";
  url.search = "";
  return url.href.replace(/\/+$/u, "");
}

function requiredCredential(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is missing`);
  }
  return value.trim();
}

function boundedTimeout(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_TIMEOUT_MS ||
    value > MAX_TIMEOUT_MS
  ) {
    return DEFAULT_TIMEOUT_MS;
  }
  return value;
}

export async function readHostConnection(
  env: NodeJS.ProcessEnv = process.env,
  home = env.HOME ?? homedir(),
): Promise<HostConnection> {
  const environmentUrl = env.LORE_API_URL?.trim();
  const environmentToken = (
    env.LORE_WORKSPACE_TOKEN ?? env.LORE_TOKEN
  )?.trim();
  if (environmentUrl !== undefined || environmentToken !== undefined) {
    if (environmentUrl === undefined || environmentUrl === "") {
      throw new Error(
        "LORE_API_URL is required when a Lore token environment variable is set",
      );
    }
    if (environmentToken === undefined || environmentToken === "") {
      throw new Error(
        "LORE_WORKSPACE_TOKEN or LORE_TOKEN is required with LORE_API_URL",
      );
    }
    return {
      apiUrl: normalizeApiUrl(environmentUrl),
      token: environmentToken,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    };
  }

  const configPath = resolve(home, ".lore", "config.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(
      `Lore credentials are required. Set LORE_API_URL plus LORE_WORKSPACE_TOKEN/LORE_TOKEN, or configure ${configPath}${detail}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid Lore connector config: ${configPath}`);
  }
  const config = parsed as Record<string, unknown>;
  return {
    apiUrl: normalizeApiUrl(requiredCredential(config.apiUrl, "Lore API URL")),
    token: requiredCredential(config.token, "Lore workspace token"),
    timeoutMs: boundedTimeout(config.timeoutMs),
  };
}

async function readStdin(
  stream: NodeJS.ReadableStream & AsyncIterable<string | Uint8Array>,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    const buffer =
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_INPUT_BYTES) {
      throw new Error(`Standard input exceeds ${MAX_INPUT_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes);
}

async function readInput(
  input: string,
  stdin: NodeJS.ReadableStream & AsyncIterable<string | Uint8Array>,
): Promise<unknown> {
  const buffer = input === "-" ? await readStdin(stdin) : await readFile(input);
  if (buffer.byteLength > MAX_INPUT_BYTES) {
    throw new Error(`Input exceeds ${MAX_INPUT_BYTES} bytes: ${input}`);
  }
  const text = buffer.toString("utf8");
  if (text.trim() === "") {
    throw new Error(`Input is empty: ${input === "-" ? "standard input" : input}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Input is not valid JSON (${input === "-" ? "standard input" : input}): ${detail}`,
    );
  }
}

function parseEndpointInput<T>(label: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (!(error instanceof ZodError)) {
      throw error;
    }
    const details = error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid ${label} endpoint JSON: ${details}`);
  }
}

function withTimeout(
  implementation: typeof fetch,
  timeoutMs: number,
): typeof fetch {
  return async (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal =
      init?.signal === undefined || init.signal === null
        ? timeout
        : AbortSignal.any([init.signal, timeout]);
    return implementation(input, { ...init, signal });
  };
}

function escapedContext(context: string): string {
  return context
    .replaceAll(
      GENERIC_LORE_CONTEXT_DELIMITERS.start,
      "[Lore context start marker omitted]",
    )
    .replaceAll(
      GENERIC_LORE_CONTEXT_DELIMITERS.end,
      "[Lore context end marker omitted]",
    );
}

export function injectHostContext(original: string, context: string): string {
  const normalized = context.trim();
  if (normalized === "") {
    return original;
  }
  return `${GENERIC_LORE_CONTEXT_DELIMITERS.start}\n${escapedContext(normalized)}\n${GENERIC_LORE_CONTEXT_DELIMITERS.end}\n\n${original}`;
}

function writeJson(
  stdout: { write(value: string): unknown },
  value: unknown,
): void {
  stdout.write(`${JSON.stringify(value)}\n`);
}

function writeText(
  stdout: { write(value: string): unknown },
  value: string,
): void {
  stdout.write(`${value}\n`);
}

export async function runHostCommand(
  args: readonly string[],
  options: HostCommandOptions = {},
): Promise<void> {
  const command = args[0];
  if (command === undefined || command === "--help" || command === "-h") {
    (options.stdout ?? process.stdout).write(HOST_HELP);
    return;
  }
  if (command !== "deliver" && command !== "observe" && command !== "turn") {
    throw new Error(`Unknown host command: ${command}\nTry: lore host --help`);
  }
  const help =
    command === "deliver"
      ? HOST_DELIVER_HELP
      : command === "observe"
        ? HOST_OBSERVE_HELP
        : HOST_TURN_HELP;
  const commandArgs = args.slice(1);
  if (commandArgs.includes("--help") || commandArgs.includes("-h")) {
    (options.stdout ?? process.stdout).write(help);
    return;
  }

  const parsed = parseHostArguments(command, commandArgs);
  const stdin =
    options.stdin ??
    (process.stdin as NodeJS.ReadableStream &
      AsyncIterable<string | Uint8Array>);
  const stdout = options.stdout ?? process.stdout;
  const input = await readInput(parsed.input, stdin);
  const connection = await readHostConnection(options.env, options.home);
  const client = new SharedMemoryClient({
    baseUrl: connection.apiUrl,
    fetch: withTimeout(options.fetch ?? globalThis.fetch, connection.timeoutMs),
    headers: { authorization: `Bearer ${connection.token}` },
  });

  if (command === "observe") {
    const request: ObservationRequest = parseEndpointInput(
      "POST /v1/observations",
      () => ObservationRequestSchema.parse(input),
    );
    writeJson(stdout, await client.observeEvent(request));
    return;
  }

  if (command === "deliver") {
    const request: ContextDeliveryRequest = parseEndpointInput(
      "POST /v1/context/deliveries",
      () => ContextDeliveryRequestSchema.parse(input),
    );
    const result = await client.deliverContext(request);
    if (parsed.output === "json") {
      writeJson(stdout, result);
    } else if (parsed.output === "context") {
      writeText(stdout, result.context);
    } else {
      writeText(stdout, injectHostContext(request.task.task, result.context));
    }
    return;
  }

  const request: PairedTurnRequest = parseEndpointInput(
    "POST /v1/turns",
    () => PairedTurnRequestSchema.parse(input),
  );
  const result = await client.processTurn(request, parsed.idempotencyKey);
  if (parsed.output === "json") {
    writeJson(stdout, result);
  } else if (parsed.output === "context") {
    writeText(stdout, result.context.text);
  } else {
    writeText(
      stdout,
      injectHostContext(request.currentUser.content, result.context.text),
    );
  }
}
