import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { getLorePaths, type ConnectorConfig } from "./cli.js";
import {
  DevinApiClient,
  type CreateDevinSessionInput,
} from "./devin-client.js";
import {
  REVIEW_OUTPUT_SCHEMA,
  validateReviewOutput,
} from "./review-output.js";

interface ReviewMetadata {
  provider: "devin";
  repository: string;
  owner: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
  marker: string;
  sessionId?: string;
}

interface LoreConnection {
  apiUrl: string;
  token: string;
}

interface LoreContextDelivery {
  context: string;
  receiptId: string;
}

const RegistrationResponseSchema = z.object({
  registered: z.literal(true),
  sessionId: z.string().min(1),
  status: z.literal("active"),
});

const ContextDeliveryResponseSchema = z
  .object({
    context: z.string(),
    event: z
      .object({
        id: z.string().min(1),
        externalEventId: z.string().min(1),
      })
      .passthrough(),
    receipt: z
      .object({
        id: z.string().min(1),
        eventId: z.string().min(1),
      })
      .passthrough(),
  })
  .passthrough();

const DEVIN_CONTEXT_DELIMITERS = {
  start: "<<< RELEVANT ENGINEERING KNOWLEDGE >>>",
  end: "<<< END RELEVANT ENGINEERING KNOWLEDGE >>>",
} as const;
const MAX_PROMPT_BYTES = 1024 * 1024;
const DEVIN_FLAG_VALUES = {
  start: new Set([
    "--repo",
    "--prompt",
    "--prompt-file",
    "--task",
    "--title",
    "--project",
    "--user-id",
    "--max-acu",
  ]),
  prompt: new Set([
    "--session",
    "--repo",
    "--prompt",
    "--prompt-file",
    "--project",
    "--message-as-user-id",
  ]),
  status: new Set(["--session"]),
  terminate: new Set(["--session"]),
  "run-review": new Set(["--prompt", "--metadata", "--output"]),
} as const;

const DEVIN_HELP = `lore devin
Start and manage Lore-enabled Devin sessions.

Usage:
  lore devin setup
  lore devin start --repo <owner/repo> --prompt <text> [options]
  lore devin prompt --session <devin-id> --repo <owner/repo> --prompt <text> [options]
  lore devin status --session <devin-id>
  lore devin terminate --session <devin-id>

Discover:
  lore devin start --help
  lore devin prompt --help

Examples:
  lore devin setup
  lore devin start --repo owner/repo --prompt "Fix the failing tests" --max-acu 2
  lore devin prompt --session devin-id --repo owner/repo --prompt "Apply the review correction"
`;

const START_HELP = `lore devin start
Create a Devin session with audited Lore context and transcript polling.

Usage:
  lore devin start --repo <owner/repo> (--prompt <text> | --prompt-file <path> | --stdin) [options]

Options:
  --repo <owner/repo>   Repository available to the Devin session
  --prompt <text>       Task prompt
  --prompt-file <path>  Read the task prompt from a file
  --stdin               Read the task prompt from standard input
  --task <summary>      Retrieval summary (defaults to the prompt)
  --title <title>       Devin session title
  --project <name>      Optional Lore project scope
  --user-id <id>        Create the session as this Devin user
  --max-acu <count>     Hard session budget (default: 2)
  --help                Show this command's help

Credentials:
  DEVIN_API_KEY and DEVIN_ORG_ID are required. Lore uses LORE_API_URL and
  LORE_WORKSPACE_TOKEN (or the stored ~/.lore configuration).

Examples:
  lore devin start --repo owner/repo --prompt "Fix the failing tests" --max-acu 2
  lore devin start --repo owner/repo --prompt-file ./task.md --project payments
  printf '%s\\n' "Fix the failing tests" | lore devin start --repo owner/repo --stdin
`;

const PROMPT_HELP = `lore devin prompt
Send a later prompt through audited Lore enrichment and re-register polling.

Usage:
  lore devin prompt --session <devin-id> --repo <owner/repo> (--prompt <text> | --prompt-file <path> | --stdin) [options]

Options:
  --session <devin-id>          Existing Devin session ID
  --repo <owner/repo>           Repository used for Lore retrieval and polling
  --prompt <text>               User prompt to send
  --prompt-file <path>          Read the prompt from a file
  --stdin                       Read the prompt from standard input
  --project <name>              Optional Lore project scope
  --message-as-user-id <id>     Send as this Devin user
  --help                        Show this command's help

Credentials:
  DEVIN_API_KEY and DEVIN_ORG_ID are required. Lore uses LORE_API_URL and
  LORE_WORKSPACE_TOKEN (or the stored ~/.lore configuration). Credentials are
  never accepted as command arguments.

Examples:
  lore devin prompt --session devin-id --repo owner/repo --prompt "Apply the review correction"
  lore devin prompt --session devin-id --repo owner/repo --prompt-file ./correction.md --project payments
  printf '%s\\n' "Apply the correction" | lore devin prompt --session devin-id --repo owner/repo --stdin
`;

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function integerFlag(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const resolved = value === undefined ? fallback : Number(value);
  if (
    !Number.isInteger(resolved) ||
    resolved < minimum ||
    resolved > maximum
  ) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return resolved;
}

function parseFlags(
  args: readonly string[],
  command: keyof typeof DEVIN_FLAG_VALUES,
  booleanFlags: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === undefined || !name.startsWith("--")) {
      throw new Error(`Invalid lore devin ${command} option near ${name ?? ""}`);
    }
    if (flags.has(name)) {
      throw new Error(`Duplicate Devin option: ${name}`);
    }
    if (booleanFlags.has(name)) {
      flags.set(name, "true");
      continue;
    }
    if (!DEVIN_FLAG_VALUES[command].has(name)) {
      throw new Error(`Unknown lore devin ${command} option: ${name}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${name}`);
    }
    flags.set(name, value);
    index += 1;
  }
  return flags;
}

function wantsHelp(args: readonly string[], help: string): boolean {
  if (!args.includes("--help") && !args.includes("-h")) {
    return false;
  }
  process.stdout.write(help);
  return true;
}

function devinClient(): DevinApiClient {
  return new DevinApiClient({
    apiKey: required(process.env.DEVIN_API_KEY, "DEVIN_API_KEY"),
    organizationId: required(process.env.DEVIN_ORG_ID, "DEVIN_ORG_ID"),
    timeoutMs: integerFlag(
      process.env.DEVIN_REQUEST_TIMEOUT_MS,
      30_000,
      1_000,
      60_000,
      "DEVIN_REQUEST_TIMEOUT_MS",
    ),
  });
}

async function loreConnection(): Promise<LoreConnection> {
  const environmentUrl = process.env.LORE_API_URL?.trim();
  const environmentToken = (
    process.env.LORE_WORKSPACE_TOKEN ?? process.env.LORE_TOKEN
  )?.trim();
  if (environmentUrl !== undefined && environmentUrl !== "") {
    return {
      apiUrl: environmentUrl.replace(/\/+$/u, ""),
      token: required(environmentToken, "LORE_WORKSPACE_TOKEN"),
    };
  }
  const parsed = JSON.parse(
    await readFile(getLorePaths().config, "utf8"),
  ) as Partial<ConnectorConfig>;
  return {
    apiUrl: required(parsed.apiUrl, "Lore API URL").replace(/\/+$/u, ""),
    token: required(parsed.token, "Lore workspace token"),
  };
}

async function loreRequest<T>(
  connection: LoreConnection,
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await fetch(`${connection.apiUrl}${path}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${connection.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(
      `Lore API ${path} failed with HTTP ${response.status}: ${detail}`,
    );
  }
  return schema.parse((await response.json()) as unknown);
}

async function readPromptFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const buffer =
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_PROMPT_BYTES) {
      throw new Error(`Standard input exceeds ${MAX_PROMPT_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

async function loadPrompt(
  flags: Map<string, string>,
  command: "start" | "prompt",
): Promise<string> {
  const direct = flags.get("--prompt");
  const file = flags.get("--prompt-file");
  const stdin = flags.has("--stdin");
  const sourceCount =
    Number(direct !== undefined) +
    Number(file !== undefined) +
    Number(stdin);
  if (sourceCount !== 1) {
    throw new Error(
      `Provide exactly one of --prompt, --prompt-file, or --stdin.\nExample: lore devin ${command} ${
        command === "prompt" ? "--session <devin-id> " : ""
      }--repo owner/repo --prompt "Describe the task"`,
    );
  }
  if (file !== undefined) {
    return required(await readFile(resolve(file), "utf8"), "--prompt-file");
  }
  if (stdin) {
    return required(await readPromptFromStdin(), "--stdin");
  }
  return required(direct, "--prompt");
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

async function deliverLoreContext(
  connection: LoreConnection,
  command: "start" | "prompt",
  sessionId: string | undefined,
  repository: string,
  task: string,
  project?: string,
): Promise<LoreContextDelivery> {
  const retrievalTask = task.slice(0, 500);
  const identity = [
    "lore-devin-context",
    command,
    sessionId ?? "",
    repository,
    project ?? "",
    retrievalTask,
  ].join("\0");
  const eventId = deterministicUuid(identity);
  const deliverySessionId =
    sessionId ?? `lore-devin-start:${sha256(identity).slice(0, 32)}`;
  const response = await loreRequest(
    connection,
    "/v1/context/deliveries",
    {
      connector: "lore-devin-cli",
      eventId,
      sessionId: deliverySessionId,
      task: {
        agent: "devin",
        task: retrievalTask,
        scope: {
          ...(project === undefined ? {} : { project }),
          repo: repository,
        },
      },
    },
    ContextDeliveryResponseSchema,
  );
  if (response.event.externalEventId !== eventId) {
    throw new Error("Lore context delivery returned a mismatched event identity");
  }
  if (response.receipt.eventId !== response.event.id) {
    throw new Error("Lore context delivery returned a mismatched receipt");
  }
  return {
    context: response.context.trim(),
    receiptId: response.receipt.id,
  };
}

function enrichDevinPrompt(prompt: string, context: string): string {
  const formatted = context.trim();
  if (formatted === "") {
    return prompt;
  }
  return [
    DEVIN_CONTEXT_DELIMITERS.start,
    formatted,
    DEVIN_CONTEXT_DELIMITERS.end,
    "",
    prompt,
  ].join("\n");
}

async function registerSession(
  connection: LoreConnection,
  sessionId: string,
  repository: string,
  project?: string,
): Promise<void> {
  await loreRequest(
    connection,
    "/v1/connectors/devin/sessions",
    {
      organizationId: required(process.env.DEVIN_ORG_ID, "DEVIN_ORG_ID"),
      sessionId,
      repo: repository,
      ...(project === undefined ? {} : { project }),
    },
    RegistrationResponseSchema,
  );
}

async function start(args: readonly string[]): Promise<void> {
  if (wantsHelp(args, START_HELP)) {
    return;
  }
  const flags = parseFlags(args, "start", new Set(["--stdin"]));
  const repository = required(flags.get("--repo"), "--repo");
  const prompt = await loadPrompt(flags, "start");
  const task = flags.get("--task")?.trim() || prompt;
  const project = flags.get("--project")?.trim() || undefined;
  const createAsUserId =
    flags.get("--user-id")?.trim() ||
    process.env.DEVIN_CREATE_AS_USER_ID?.trim() ||
    undefined;
  const maxAcuLimit = integerFlag(
    flags.get("--max-acu") ?? process.env.DEVIN_MAX_ACU_LIMIT,
    2,
    1,
    100,
    "--max-acu",
  );
  const client = devinClient();
  const connection = await loreConnection();
  const delivery = await deliverLoreContext(
    connection,
    "start",
    undefined,
    repository,
    task,
    project,
  );
  const enrichedPrompt = enrichDevinPrompt(prompt, delivery.context);
  const createInput: CreateDevinSessionInput = {
    prompt: enrichedPrompt,
    repos: [repository],
    title: flags.get("--title") ?? `Lore: ${task.slice(0, 80)}`,
    tags: ["lore", "ambient-learning"],
    maxAcuLimit,
    ...(createAsUserId === undefined ? {} : { createAsUserId }),
    resumable: true,
  };
  const session = await client.createSession(createInput);
  try {
    await registerSession(
      connection,
      session.session_id,
      repository,
      project,
    );
  } catch (error) {
    await client.archiveSession(session.session_id).catch(() => undefined);
    throw error;
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        sessionId: session.session_id,
        url: session.url,
        repository,
        maxAcuLimit,
        loreContextInjected: delivery.context !== "",
        lorePollingRegistered: true,
        loreDeliveryReceiptId: delivery.receiptId,
      },
      null,
      2,
    )}\n`,
  );
}

async function prompt(args: readonly string[]): Promise<void> {
  if (wantsHelp(args, PROMPT_HELP)) {
    return;
  }
  const flags = parseFlags(args, "prompt", new Set(["--stdin"]));
  const sessionId = required(flags.get("--session"), "--session");
  const repository = required(flags.get("--repo"), "--repo");
  const userPrompt = await loadPrompt(flags, "prompt");
  const project = flags.get("--project")?.trim() || undefined;
  const messageAsUserId =
    flags.get("--message-as-user-id")?.trim() ||
    process.env.DEVIN_MESSAGE_AS_USER_ID?.trim() ||
    process.env.DEVIN_CREATE_AS_USER_ID?.trim() ||
    undefined;
  const client = devinClient();
  const connection = await loreConnection();
  const delivery = await deliverLoreContext(
    connection,
    "prompt",
    sessionId,
    repository,
    userPrompt,
    project,
  );
  await registerSession(connection, sessionId, repository, project);
  await client.sendMessage(
    sessionId,
    enrichDevinPrompt(userPrompt, delivery.context),
    messageAsUserId,
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        sessionId,
        loreContextInjected: delivery.context !== "",
        lorePollingRegistered: true,
        sent: true,
        loreDeliveryReceiptId: delivery.receiptId,
      },
      null,
      2,
    )}\n`,
  );
}

async function setup(): Promise<void> {
  const client = devinClient();
  await client.checkAccess();
  const connection = await loreConnection();
  const health = await fetch(`${connection.apiUrl}/health`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!health.ok) {
    throw new Error(`Lore health check failed with HTTP ${health.status}`);
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        devin: "connected",
        lore: "connected",
        organizationId: client.organizationId,
      },
      null,
      2,
    )}\n`,
  );
}

async function status(args: readonly string[]): Promise<void> {
  const flags = parseFlags(args, "status");
  const session = await devinClient().getSession(
    required(flags.get("--session"), "--session"),
  );
  process.stdout.write(`${JSON.stringify(session, null, 2)}\n`);
}

async function runReview(args: readonly string[]): Promise<void> {
  const flags = parseFlags(args, "run-review");
  const promptPath = resolve(required(flags.get("--prompt"), "--prompt"));
  const metadataPath = resolve(
    required(flags.get("--metadata"), "--metadata"),
  );
  const outputPath = resolve(required(flags.get("--output"), "--output"));
  const prompt = await readFile(promptPath, "utf8");
  const metadata = JSON.parse(
    await readFile(metadataPath, "utf8"),
  ) as ReviewMetadata;
  const client = devinClient();
  const created = await client.createSession({
    prompt,
    title: `Lore review ${metadata.repository}#${metadata.prNumber}`,
    tags: [
      "lore",
      "github-review",
      `pr:${metadata.prNumber}`,
      `sha:${metadata.headSha.slice(0, 12)}`,
    ],
    repos: [metadata.repository],
    maxAcuLimit: integerFlag(
      process.env.DEVIN_REVIEW_MAX_ACU_LIMIT,
      2,
      1,
      100,
      "DEVIN_REVIEW_MAX_ACU_LIMIT",
    ),
    resumable: false,
    structuredOutputRequired: true,
    structuredOutputSchema: REVIEW_OUTPUT_SCHEMA,
  });
  metadata.sessionId = created.session_id;
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  try {
    const completed = await client.waitForCompletion(
      created.session_id,
      integerFlag(
        process.env.LORE_DEVIN_TIMEOUT_MS,
        30 * 60_000,
        1_000,
        60 * 60_000,
        "LORE_DEVIN_TIMEOUT_MS",
      ),
    );
    const output = validateReviewOutput(completed.structured_output);
    await writeFile(
      outputPath,
      `${JSON.stringify(output, null, 2)}\n`,
      "utf8",
    );
  } finally {
    await client.archiveSession(created.session_id).catch(() => undefined);
  }
}

async function terminate(args: readonly string[]): Promise<void> {
  const flags = parseFlags(args, "terminate");
  await devinClient().archiveSession(
    required(flags.get("--session"), "--session"),
  );
}

export async function runDevinCommand(args: readonly string[]): Promise<void> {
  switch (args[0]) {
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(DEVIN_HELP);
      return;
    case "setup":
      await setup();
      return;
    case "start":
      await start(args.slice(1));
      return;
    case "prompt":
      await prompt(args.slice(1));
      return;
    case "status":
      await status(args.slice(1));
      return;
    case "run-review":
      await runReview(args.slice(1));
      return;
    case "terminate":
      await terminate(args.slice(1));
      return;
    default:
      throw new Error(
        `Unknown devin command: ${args[0] ?? ""}. Use setup, start, prompt, status, run-review, or terminate.`,
      );
  }
}
