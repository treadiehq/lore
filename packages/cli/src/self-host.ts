import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { AuthEmailSchema } from "@lore-co/core";
import { SELF_HOST_COMPOSE_ASSET } from "./generated-assets.js";
import { LORE_VERSION } from "./version.js";

const DEFAULT_API_PORT = 3001;
const DEFAULT_DASHBOARD_PORT = 3000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
const PROCESS_OUTPUT_LIMIT = 2 * 1024 * 1024;

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface CommonArguments {
  stateDirectory: string;
  json: boolean;
}

interface UpArguments extends CommonArguments {
  imageTag?: string;
  apiPort?: number;
  dashboardPort?: number;
  bindAddress?: string;
  origins: string[];
  organization?: string;
  workspaceName?: string;
  headless?: boolean;
  timeoutMs: number;
}

interface DownArguments extends CommonArguments {
  volumes: boolean;
  yes: boolean;
}

interface ResetArguments extends CommonArguments {
  email: string;
  output?: string;
}

interface SelfHostState {
  version: 1;
  projectName: string;
  imageTag: string;
  apiPort: number;
  dashboardPort: number;
  bindAddress: string;
  origins: string[];
  organization: string;
  workspaceName: string;
  headless: boolean;
  bootstrapTokenPresented: boolean;
  createdAt: string;
}

interface StatePaths {
  directory: string;
  compose: string;
  environment: string;
  metadata: string;
}

export const SELF_HOST_HELP = `lore self-host
Run a version-pinned Lore stack with Docker Compose, without cloning Lore.

Usage:
  lore self-host <command> [options]

Commands:
  up                     Create or update the stack and wait for readiness
  down                   Stop the stack while preserving database data
  status                 Show Docker, service, and API readiness state
  reset-owner-password   Mint a one-use owner password reset link

Discover:
  lore self-host up --help
  lore self-host down --help
  lore self-host status --help
  lore self-host reset-owner-password --help

Examples:
  lore self-host up
  lore self-host status --json
  lore self-host down
`;

export const SELF_HOST_UP_HELP = `lore self-host up
Create secure persistent state, start pinned images, and wait for API readiness.

Usage:
  lore self-host up [options]

Options:
  --state-dir <path>       State directory (default: ~/.lore/self-host)
  --image-tag <semver>     Pinned API/web image tag (default: CLI version)
  --api-port <port>        Host API port (default: 3001)
  --dashboard-port <port>  Host dashboard port (default: 3000)
  --bind-address <address> 127.0.0.1, 0.0.0.0, or ::1 (default: 127.0.0.1)
  --origin <origin>        Allowed dashboard origin; repeat for multiple origins
  --organization <name>    Workspace organization (default: local)
  --name <name>            Workspace display name (default: organization)
  --headless               Start PostgreSQL, migrations, and API only
  --dashboard              Start the dashboard (default)
  --timeout-ms <ms>        Readiness timeout, 1000-600000 (default: 120000)
  --json                   Print machine-readable output
  --help                   Show this command's help

Environment:
  LORE_SELF_HOST_STATE_DIR, LORE_IMAGE_TAG, API_PORT, NUXT_PORT,
  API_BIND_ADDRESS, NUXT_ORIGIN, LORE_WORKSPACE_ORGANIZATION,
  LORE_WORKSPACE_NAME, LORE_SELF_HOST_HEADLESS

Examples:
  lore self-host up
  lore self-host up --headless --api-port 3101 --json
  lore self-host up --image-tag 0.1.4 --origin https://lore.example.com
`;

export const SELF_HOST_DOWN_HELP = `lore self-host down
Stop the self-hosted stack. Database volumes are preserved by default.

Usage:
  lore self-host down [--state-dir <path>] [--volumes --yes] [--json]

Options:
  --state-dir <path>  State directory (default: ~/.lore/self-host)
  --volumes           Also delete persistent database volumes
  --yes               Required with --volumes
  --json              Print machine-readable output
  --help              Show this command's help

Examples:
  lore self-host down
  lore self-host down --volumes --yes --json
`;

export const SELF_HOST_STATUS_HELP = `lore self-host status
Read Docker availability, Compose service state, and Lore API readiness.

Usage:
  lore self-host status [--state-dir <path>] [--json]

Examples:
  lore self-host status
  lore self-host status --json
`;

export const SELF_HOST_RESET_HELP = `lore self-host reset-owner-password
Run the operator reset executable in the API container.

Usage:
  lore self-host reset-owner-password --email <owner-email> [options]

Options:
  --email <email>      Active local-owner email (required)
  --output <file>      Write the one-use link to a new mode-0600 file
  --state-dir <path>   State directory (default: ~/.lore/self-host)
  --json               Print machine-readable output
  --help               Show this command's help

Examples:
  lore self-host reset-owner-password --email owner@example.com
  lore self-host reset-owner-password --email owner@example.com --output ./reset-link.txt
`;

function environmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = environment[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function expandHome(path: string, home: string): string {
  if (path === "~") {
    return home;
  }
  return path.startsWith("~/") ? resolve(home, path.slice(2)) : resolve(path);
}

function defaultStateDirectory(environment: NodeJS.ProcessEnv): string {
  const home = resolve(environment.HOME ?? homedir());
  return expandHome(
    environmentValue(environment, "LORE_SELF_HOST_STATE_DIR") ??
      resolve(home, ".lore", "self-host"),
    home,
  );
}

function statePaths(directory: string): StatePaths {
  return {
    directory,
    compose: resolve(directory, "compose.yml"),
    environment: resolve(directory, "lore.env"),
    metadata: resolve(directory, "state.json"),
  };
}

function valueAfter(
  args: readonly string[],
  index: number,
  flag: string,
): [string, number] {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return [value, index + 1];
}

function parseInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${flag} requires an integer`);
  }
  return parsed;
}

function parsePort(value: string, flag: string): number {
  const port = parseInteger(value, flag);
  if (port < 1 || port > 65_535) {
    throw new Error(`${flag} must be between 1 and 65535`);
  }
  return port;
}

function parseBooleanEnvironment(
  value: string | undefined,
  name: string,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "1" || value === "true") {
    return true;
  }
  if (value === "0" || value === "false") {
    return false;
  }
  throw new Error(`${name} must be true, false, 1, or 0`);
}

function commonDefaults(environment: NodeJS.ProcessEnv): CommonArguments {
  return {
    stateDirectory: defaultStateDirectory(environment),
    json: false,
  };
}

function parseUpArguments(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): UpArguments | null {
  const parsed: UpArguments = {
    ...commonDefaults(environment),
    origins: [],
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(SELF_HOST_UP_HELP);
      return null;
    }
    if (flag === "--json") {
      parsed.json = true;
      continue;
    }
    if (flag === "--headless" || flag === "--dashboard") {
      if (seen.has("--mode")) {
        throw new Error("Use only one of --headless or --dashboard");
      }
      seen.add("--mode");
      parsed.headless = flag === "--headless";
      continue;
    }
    if (
      flag !== "--state-dir" &&
      flag !== "--image-tag" &&
      flag !== "--api-port" &&
      flag !== "--dashboard-port" &&
      flag !== "--bind-address" &&
      flag !== "--origin" &&
      flag !== "--organization" &&
      flag !== "--name" &&
      flag !== "--timeout-ms"
    ) {
      throw new Error(
        `Unknown self-host up option: ${flag ?? ""}\nTry: lore self-host up --help`,
      );
    }
    if (flag !== "--origin" && seen.has(flag)) {
      throw new Error(`Self-host up option may be provided once: ${flag}`);
    }
    seen.add(flag);
    const [value, valueIndex] = valueAfter(args, index, flag);
    index = valueIndex;
    if (flag === "--state-dir") {
      parsed.stateDirectory = expandHome(
        value,
        resolve(environment.HOME ?? homedir()),
      );
    } else if (flag === "--image-tag") {
      parsed.imageTag = value;
    } else if (flag === "--api-port") {
      parsed.apiPort = parsePort(value, flag);
    } else if (flag === "--dashboard-port") {
      parsed.dashboardPort = parsePort(value, flag);
    } else if (flag === "--bind-address") {
      parsed.bindAddress = value;
    } else if (flag === "--origin") {
      parsed.origins.push(value);
    } else if (flag === "--organization") {
      parsed.organization = value;
    } else if (flag === "--name") {
      parsed.workspaceName = value;
    } else {
      parsed.timeoutMs = parseInteger(value, flag);
      if (
        parsed.timeoutMs < MIN_TIMEOUT_MS ||
        parsed.timeoutMs > MAX_TIMEOUT_MS
      ) {
        throw new Error("--timeout-ms must be between 1000 and 600000");
      }
    }
  }
  return parsed;
}

function parseCommonOutputArguments(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  help: string,
  command: string,
): CommonArguments | null {
  const parsed = commonDefaults(environment);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(help);
      return null;
    }
    if (flag === "--json") {
      parsed.json = true;
      continue;
    }
    if (flag === "--state-dir") {
      const [value, valueIndex] = valueAfter(args, index, flag);
      parsed.stateDirectory = expandHome(
        value,
        resolve(environment.HOME ?? homedir()),
      );
      index = valueIndex;
      continue;
    }
    throw new Error(
      `Unknown self-host ${command} option: ${flag ?? ""}\nTry: lore self-host ${command} --help`,
    );
  }
  return parsed;
}

function parseDownArguments(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): DownArguments | null {
  const parsed: DownArguments = {
    ...commonDefaults(environment),
    volumes: false,
    yes: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(SELF_HOST_DOWN_HELP);
      return null;
    }
    if (flag === "--json") {
      parsed.json = true;
    } else if (flag === "--volumes") {
      parsed.volumes = true;
    } else if (flag === "--yes") {
      parsed.yes = true;
    } else if (flag === "--state-dir") {
      const [value, valueIndex] = valueAfter(args, index, flag);
      parsed.stateDirectory = expandHome(
        value,
        resolve(environment.HOME ?? homedir()),
      );
      index = valueIndex;
    } else {
      throw new Error(
        `Unknown self-host down option: ${flag ?? ""}\nTry: lore self-host down --help`,
      );
    }
  }
  if (parsed.volumes && !parsed.yes) {
    throw new Error(
      "Deleting database volumes requires --volumes --yes.\nExample: lore self-host down --volumes --yes",
    );
  }
  if (parsed.yes && !parsed.volumes) {
    throw new Error("--yes is valid only with --volumes");
  }
  return parsed;
}

function parseResetArguments(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): ResetArguments | null {
  const parsed: CommonArguments & { email?: string; output?: string } =
    commonDefaults(environment);
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(SELF_HOST_RESET_HELP);
      return null;
    }
    if (flag === "--json") {
      parsed.json = true;
      continue;
    }
    if (
      flag !== "--state-dir" &&
      flag !== "--email" &&
      flag !== "--output"
    ) {
      throw new Error(
        `Unknown reset-owner-password option: ${flag ?? ""}\nTry: lore self-host reset-owner-password --help`,
      );
    }
    if (seen.has(flag)) {
      throw new Error(`Reset option may be provided once: ${flag}`);
    }
    seen.add(flag);
    const [value, valueIndex] = valueAfter(args, index, flag);
    index = valueIndex;
    if (flag === "--state-dir") {
      parsed.stateDirectory = expandHome(
        value,
        resolve(environment.HOME ?? homedir()),
      );
    } else if (flag === "--email") {
      parsed.email = AuthEmailSchema.parse(value);
    } else {
      parsed.output = resolve(value);
    }
  }
  if (parsed.email === undefined) {
    throw new Error(
      "--email <owner-email> is required.\nExample: lore self-host reset-owner-password --email owner@example.com",
    );
  }
  return {
    stateDirectory: parsed.stateDirectory,
    json: parsed.json,
    email: parsed.email,
    ...(parsed.output === undefined ? {} : { output: parsed.output }),
  };
}

function normalizeImageTag(value: string): string {
  const tag = value.trim().replace(/^v(?=\d)/u, "");
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/u.test(tag)
  ) {
    throw new Error(
      "--image-tag must be a pinned semantic version such as 0.1.4",
    );
  }
  return tag;
}

function normalizeBindAddress(value: string): string {
  const address = value.trim();
  if (
    address !== "127.0.0.1" &&
    address !== "0.0.0.0" &&
    address !== "::1" &&
    address !== "[::1]"
  ) {
    throw new Error(
      "--bind-address must be 127.0.0.1, 0.0.0.0, or ::1",
    );
  }
  return address === "::1" ? "[::1]" : address;
}

function normalizeOrigin(value: string): string {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error(`Invalid self-host origin: ${value}`);
  }
  if (
    (origin.protocol !== "http:" && origin.protocol !== "https:") ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new Error(
      "Self-host origins must be HTTP(S) origins without credentials or paths",
    );
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(origin.hostname);
  if (origin.protocol !== "https:" && !loopback) {
    throw new Error(
      "Self-host origins must use HTTPS unless they are loopback origins",
    );
  }
  return origin.origin;
}

function boundedName(value: string, flag: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 200 ||
    /[\r\n\0]/u.test(normalized)
  ) {
    throw new Error(`${flag} must contain 1-200 characters on one line`);
  }
  return normalized;
}

function projectName(directory: string): string {
  return `lore-${createHash("sha256").update(directory).digest("hex").slice(0, 10)}`;
}

function createSecret(): string {
  return randomBytes(32).toString("base64url");
}

function quoteEnvironmentValue(value: string): string {
  if (/[\r\n\0]/u.test(value)) {
    throw new Error("Self-host environment values must fit on one line");
  }
  return JSON.stringify(value.replaceAll("$", "$$"));
}

function serializeEnvironment(values: Readonly<Record<string, string>>): string {
  return `${Object.entries(values)
    .map(([name, value]) => `${name}=${quoteEnvironmentValue(value)}`)
    .join("\n")}\n`;
}

function parseEnvironmentFile(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/u)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 1) {
      throw new Error("Self-host environment file is invalid");
    }
    const name = line.slice(0, separator);
    const encoded = line.slice(separator + 1);
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) {
      throw new Error("Self-host environment file is invalid");
    }
    try {
      const parsed: unknown = JSON.parse(encoded);
      if (typeof parsed !== "string") {
        throw new Error("not a string");
      }
      values[name] = parsed.replaceAll("$$", "$");
    } catch {
      throw new Error("Self-host environment file is invalid");
    }
  }
  return values;
}

async function optionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function atomicWrite(
  path: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, content, {
    encoding: "utf8",
    mode,
    flag: "wx",
  });
  await rename(temporary, path);
  await chmod(path, mode);
}

function parseState(raw: string): SelfHostState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Self-host state metadata is invalid");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Self-host state metadata is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.projectName !== "string" ||
    typeof record.imageTag !== "string" ||
    typeof record.apiPort !== "number" ||
    typeof record.dashboardPort !== "number" ||
    typeof record.bindAddress !== "string" ||
    !Array.isArray(record.origins) ||
    !record.origins.every((origin: unknown) => typeof origin === "string") ||
    typeof record.organization !== "string" ||
    typeof record.workspaceName !== "string" ||
    typeof record.headless !== "boolean" ||
    typeof record.bootstrapTokenPresented !== "boolean" ||
    typeof record.createdAt !== "string"
  ) {
    throw new Error("Self-host state metadata is invalid");
  }
  return record as unknown as SelfHostState;
}

async function readState(paths: StatePaths): Promise<SelfHostState | null> {
  const raw = await optionalFile(paths.metadata);
  return raw === null ? null : parseState(raw);
}

function processResult(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > PROCESS_OUTPUT_LIMIT) {
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > PROCESS_OUTPUT_LIMIT) {
        child.kill("SIGTERM");
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        resolvePromise({ code: 124, stdout, stderr });
        return;
      }
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function docker(
  args: readonly string[],
  timeoutMs = 30_000,
): Promise<ProcessResult> {
  try {
    return await processResult("docker", args, timeoutMs);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    if (code === "ENOENT") {
      return { code: 127, stdout: "", stderr: "" };
    }
    throw error;
  }
}

async function requireDocker(): Promise<void> {
  const compose = await docker(["compose", "version"], 15_000);
  if (compose.code !== 0) {
    throw new Error(
      "Docker Compose is unavailable. Install or start Docker Desktop, then retry.",
    );
  }
  const daemon = await docker(["info"], 15_000);
  if (daemon.code !== 0) {
    throw new Error(
      "The Docker daemon is unavailable. Start Docker Desktop, then retry.",
    );
  }
}

function composeArguments(
  paths: StatePaths,
  state: SelfHostState,
): string[] {
  return [
    "compose",
    "--project-name",
    state.projectName,
    "--env-file",
    paths.environment,
    "-f",
    paths.compose,
  ];
}

async function waitForReadiness(
  apiPort: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${apiPort}/health/ready`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.min(2_000, timeoutMs)),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Startup connection failures are retried until the bounded deadline.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(
    "Lore did not become ready before the timeout. Run lore self-host status for details.",
  );
}

function writeResult(value: unknown, json: boolean, text: string): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : text);
}

function resolvedUpState(
  args: UpArguments,
  existing: SelfHostState | null,
  environment: NodeJS.ProcessEnv,
): SelfHostState {
  const imageTag = normalizeImageTag(
    args.imageTag ??
      environmentValue(environment, "LORE_IMAGE_TAG") ??
      existing?.imageTag ??
      LORE_VERSION,
  );
  const apiPort =
    args.apiPort ??
    (environmentValue(environment, "API_PORT") === undefined
      ? undefined
      : parsePort(environment.API_PORT as string, "API_PORT")) ??
    existing?.apiPort ??
    DEFAULT_API_PORT;
  const dashboardPort =
    args.dashboardPort ??
    (environmentValue(environment, "NUXT_PORT") === undefined
      ? undefined
      : parsePort(environment.NUXT_PORT as string, "NUXT_PORT")) ??
    existing?.dashboardPort ??
    DEFAULT_DASHBOARD_PORT;
  const bindAddress = normalizeBindAddress(
    args.bindAddress ??
      environmentValue(environment, "API_BIND_ADDRESS") ??
      existing?.bindAddress ??
      "127.0.0.1",
  );
  const environmentOrigins =
    environmentValue(environment, "NUXT_ORIGIN")
      ?.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean) ?? [];
  const persistedOrigins =
    existing !== null &&
    dashboardPort !== existing.dashboardPort &&
    existing.origins.length === 1 &&
    (existing.origins[0] ===
      `http://localhost:${existing.dashboardPort}` ||
      existing.origins[0] ===
        `http://127.0.0.1:${existing.dashboardPort}`)
      ? [`http://127.0.0.1:${dashboardPort}`]
      : existing?.origins;
  const origins = [
    ...new Set(
      (
        args.origins.length > 0
          ? args.origins
          : environmentOrigins.length > 0
            ? environmentOrigins
            : persistedOrigins ?? [`http://127.0.0.1:${dashboardPort}`]
      ).map(normalizeOrigin),
    ),
  ];
  const organization = boundedName(
    args.organization ??
      environmentValue(environment, "LORE_WORKSPACE_ORGANIZATION") ??
      existing?.organization ??
      "local",
    "--organization",
  );
  const workspaceName = boundedName(
    args.workspaceName ??
      environmentValue(environment, "LORE_WORKSPACE_NAME") ??
      existing?.workspaceName ??
      organization,
    "--name",
  );
  if (
    existing !== null &&
    (organization !== existing.organization ||
      workspaceName !== existing.workspaceName)
  ) {
    throw new Error(
      "Workspace organization and name cannot change after initialization. Use a new --state-dir.",
    );
  }
  const environmentHeadless = parseBooleanEnvironment(
    environmentValue(environment, "LORE_SELF_HOST_HEADLESS"),
    "LORE_SELF_HOST_HEADLESS",
  );
  return {
    version: 1,
    projectName: existing?.projectName ?? projectName(args.stateDirectory),
    imageTag,
    apiPort,
    dashboardPort,
    bindAddress,
    origins,
    organization,
    workspaceName,
    headless: args.headless ?? environmentHeadless ?? existing?.headless ?? false,
    bootstrapTokenPresented:
      existing?.bootstrapTokenPresented ?? false,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
}

function environmentForState(
  state: SelfHostState,
  secrets: {
    postgresPassword: string;
    workspaceToken: string;
    ownerBootstrapToken: string;
  },
): Record<string, string> {
  const apiUrl = `http://127.0.0.1:${state.apiPort}`;
  const primaryOrigin =
    state.origins[0] ?? `http://127.0.0.1:${state.dashboardPort}`;
  return {
    LORE_IMAGE_TAG: state.imageTag,
    LORE_SERVER_VERSION: state.imageTag,
    POSTGRES_PASSWORD: secrets.postgresPassword,
    API_BIND_ADDRESS: state.bindAddress,
    API_PORT: String(state.apiPort),
    NUXT_BIND_ADDRESS: state.bindAddress,
    NUXT_PORT: String(state.dashboardPort),
    NUXT_ORIGIN: state.origins.join(","),
    NUXT_PUBLIC_LORE_CONNECTOR_API_URL: apiUrl,
    NUXT_AUTH_COOKIE_SECURE: String(
      new URL(primaryOrigin).protocol === "https:",
    ),
    AUTH_MODE: "local_owner",
    AUTH_EMAIL_MODE: "disabled",
    AUTH_WEB_ORIGIN: primaryOrigin,
    LORE_WORKSPACE_TOKEN: secrets.workspaceToken,
    LORE_WORKSPACE_ORGANIZATION: state.organization,
    LORE_WORKSPACE_NAME: state.workspaceName,
    LORE_OWNER_BOOTSTRAP_TOKEN: secrets.ownerBootstrapToken,
  };
}

function readSecrets(values: Record<string, string>): {
  postgresPassword: string;
  workspaceToken: string;
  ownerBootstrapToken: string;
} {
  const postgresPassword = values.POSTGRES_PASSWORD;
  const workspaceToken = values.LORE_WORKSPACE_TOKEN;
  const ownerBootstrapToken = values.LORE_OWNER_BOOTSTRAP_TOKEN;
  if (
    postgresPassword === undefined ||
    postgresPassword.length < 43 ||
    workspaceToken === undefined ||
    !/^lore_[A-Za-z0-9_-]{43}$/u.test(workspaceToken) ||
    ownerBootstrapToken === undefined ||
    !/^[A-Za-z0-9_-]{43}$/u.test(ownerBootstrapToken) ||
    new Set([postgresPassword, workspaceToken, ownerBootstrapToken]).size !== 3
  ) {
    throw new Error(
      "Self-host secrets are missing or invalid. Refusing to replace existing state.",
    );
  }
  return { postgresPassword, workspaceToken, ownerBootstrapToken };
}

async function upCommand(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const parsed = parseUpArguments(args, environment);
  if (parsed === null) {
    return;
  }
  const paths = statePaths(parsed.stateDirectory);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700);
  const [existingState, existingEnvironment] = await Promise.all([
    readState(paths),
    optionalFile(paths.environment),
  ]);
  if ((existingState === null) !== (existingEnvironment === null)) {
    throw new Error(
      "Self-host state is incomplete. Restore both lore.env and state.json or use a new --state-dir.",
    );
  }
  const state = resolvedUpState(parsed, existingState, environment);
  const secrets =
    existingEnvironment === null
      ? {
          postgresPassword: createSecret(),
          workspaceToken: `lore_${createSecret()}`,
          ownerBootstrapToken: createSecret(),
        }
      : readSecrets(parseEnvironmentFile(existingEnvironment));
  await Promise.all([
    atomicWrite(
      paths.environment,
      serializeEnvironment(environmentForState(state, secrets)),
    ),
    atomicWrite(paths.compose, SELF_HOST_COMPOSE_ASSET),
    atomicWrite(paths.metadata, `${JSON.stringify(state, null, 2)}\n`),
  ]);

  await requireDocker();
  const waitSeconds = Math.max(1, Math.ceil(parsed.timeoutMs / 1_000));
  const upArguments = [
    ...composeArguments(paths, state),
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    String(waitSeconds),
    "--remove-orphans",
    ...(state.headless ? ["postgres", "migrate", "api"] : []),
  ];
  const started = await docker(upArguments, parsed.timeoutMs + 30_000);
  if (started.code !== 0) {
    throw new Error(
      `Docker Compose could not start Lore. Run lore self-host status --state-dir ${paths.directory} for details.`,
    );
  }
  await waitForReadiness(state.apiPort, parsed.timeoutMs);

  const shouldPresentBootstrap = !state.bootstrapTokenPresented;
  const completedState = {
    ...state,
    bootstrapTokenPresented: true,
  } satisfies SelfHostState;
  await atomicWrite(
    paths.metadata,
    `${JSON.stringify(completedState, null, 2)}\n`,
  );
  const apiUrl = `http://127.0.0.1:${state.apiPort}`;
  const dashboardUrl = state.headless
    ? null
    : (state.origins[0] ?? `http://127.0.0.1:${state.dashboardPort}`);
  const setupUrl =
    dashboardUrl === null ? null : new URL("/setup", dashboardUrl).toString();
  const result = {
    status: "ready",
    stateDirectory: paths.directory,
    imageTag: state.imageTag,
    headless: state.headless,
    apiUrl,
    dashboardUrl,
    setupUrl,
    ...(shouldPresentBootstrap
      ? { bootstrapToken: secrets.ownerBootstrapToken }
      : {}),
    bootstrapTokenPresented: shouldPresentBootstrap,
  };
  const bootstrapLine = shouldPresentBootstrap
    ? `owner_bootstrap_token: ${secrets.ownerBootstrapToken}\n`
    : "owner_bootstrap_token: already presented; retained in secure state\n";
  writeResult(
    result,
    parsed.json,
    `status: ready\napi_url: ${apiUrl}\n${
      dashboardUrl === null ? "" : `dashboard_url: ${dashboardUrl}\n`
    }${setupUrl === null ? "" : `setup_url: ${setupUrl}\n`}${bootstrapLine}state_directory: ${paths.directory}\n`,
  );
}

async function downCommand(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const parsed = parseDownArguments(args, environment);
  if (parsed === null) {
    return;
  }
  const paths = statePaths(parsed.stateDirectory);
  const state = await readState(paths);
  if (state === null) {
    writeResult(
      {
        status: "not_initialized",
        stateDirectory: paths.directory,
        volumesDeleted: false,
      },
      parsed.json,
      `status: not_initialized\nstate_directory: ${paths.directory}\n`,
    );
    return;
  }
  await requireDocker();
  const stopped = await docker([
    ...composeArguments(paths, state),
    "down",
    "--remove-orphans",
    ...(parsed.volumes ? ["--volumes"] : []),
  ]);
  if (stopped.code !== 0) {
    throw new Error(
      "Docker Compose could not stop Lore. Run lore self-host status for details.",
    );
  }
  const result = {
    status: "stopped",
    stateDirectory: paths.directory,
    volumesDeleted: parsed.volumes,
  };
  writeResult(
    result,
    parsed.json,
    `status: stopped\ndatabase_data: ${
      parsed.volumes ? "deleted" : "preserved"
    }\nstate_directory: ${paths.directory}\n`,
  );
}

function parseComposeServices(output: string): unknown[] {
  const trimmed = output.trim();
  if (trimmed === "") {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const services: unknown[] = [];
    for (const line of trimmed.split(/\r?\n/u)) {
      try {
        services.push(JSON.parse(line) as unknown);
      } catch {
        return [{ raw: trimmed }];
      }
    }
    return services;
  }
}

async function readinessState(
  state: SelfHostState,
): Promise<{ state: "ready" | "unready" | "unreachable"; status: number | null }> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${state.apiPort}/health/ready`,
      { signal: AbortSignal.timeout(3_000) },
    );
    return {
      state: response.ok ? "ready" : "unready",
      status: response.status,
    };
  } catch {
    return { state: "unreachable", status: null };
  }
}

async function statusCommand(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const parsed = parseCommonOutputArguments(
    args,
    environment,
    SELF_HOST_STATUS_HELP,
    "status",
  );
  if (parsed === null) {
    return;
  }
  const paths = statePaths(parsed.stateDirectory);
  const state = await readState(paths);
  const version = await docker(["--version"], 5_000);
  const dockerInstalled = version.code === 0;
  const compose = dockerInstalled
    ? await docker(["compose", "version"], 5_000)
    : { code: 127, stdout: "", stderr: "" };
  const daemon =
    compose.code === 0
      ? await docker(["info"], 5_000)
      : { code: 127, stdout: "", stderr: "" };
  let services: unknown[] = [];
  if (state !== null && daemon.code === 0) {
    const serviceResult = await docker([
      ...composeArguments(paths, state),
      "ps",
      "--format",
      "json",
    ]);
    if (serviceResult.code === 0) {
      services = parseComposeServices(serviceResult.stdout);
    }
  }
  const health =
    state === null
      ? { state: "unreachable" as const, status: null }
      : await readinessState(state);
  const result = {
    initialized: state !== null,
    stateDirectory: paths.directory,
    docker: {
      installed: dockerInstalled,
      compose: compose.code === 0,
      daemon: daemon.code === 0,
    },
    stack:
      state === null
        ? null
        : {
            projectName: state.projectName,
            imageTag: state.imageTag,
            headless: state.headless,
            services,
          },
    health,
  };
  writeResult(
    result,
    parsed.json,
    `initialized: ${result.initialized ? "yes" : "no"}\ndocker: ${
      dockerInstalled ? "installed" : "missing"
    }\ncompose: ${compose.code === 0 ? "available" : "unavailable"}\ndaemon: ${
      daemon.code === 0 ? "available" : "unavailable"
    }\napi_health: ${health.state}\nstate_directory: ${paths.directory}\n`,
  );
}

function passwordResetUrl(output: string): string {
  const value = output.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "The API container did not return a valid password reset link.",
    );
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hash.startsWith("#token=")
  ) {
    throw new Error(
      "The API container did not return a valid password reset link.",
    );
  }
  return value;
}

async function resetCommand(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const parsed = parseResetArguments(args, environment);
  if (parsed === null) {
    return;
  }
  const paths = statePaths(parsed.stateDirectory);
  const state = await readState(paths);
  if (state === null) {
    throw new Error(
      "Self-host state is not initialized. Run lore self-host up first.",
    );
  }
  await requireDocker();
  const reset = await docker(
    [
      ...composeArguments(paths, state),
      "exec",
      "-T",
      "api",
      "lore-reset-password",
      "--email",
      parsed.email,
    ],
    30_000,
  );
  if (reset.code !== 0) {
    throw new Error(
      "Owner password reset failed. Verify the API is running and the owner email is active.",
    );
  }
  const resetUrl = passwordResetUrl(reset.stdout);
  if (parsed.output !== undefined) {
    await mkdir(dirname(parsed.output), { recursive: true, mode: 0o700 });
    await writeFile(parsed.output, `${resetUrl}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(parsed.output, 0o600);
    writeResult(
      {
        created: true,
        email: parsed.email,
        output: parsed.output,
      },
      parsed.json,
      `password_reset_link: written\noutput: ${parsed.output}\n`,
    );
    return;
  }
  writeResult(
    { created: true, email: parsed.email, resetUrl },
    parsed.json,
    parsed.json ? "" : `${resetUrl}\n`,
  );
}

export async function runSelfHostCommand(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const command = args[0];
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(SELF_HOST_HELP);
    return;
  }
  const commandArgs = args.slice(1);
  switch (command) {
    case "up":
      await upCommand(commandArgs, environment);
      return;
    case "down":
      await downCommand(commandArgs, environment);
      return;
    case "status":
      await statusCommand(commandArgs, environment);
      return;
    case "reset-owner-password":
      await resetCommand(commandArgs, environment);
      return;
    default:
      throw new Error(
        `Unknown self-host command: ${command}\nTry: lore self-host --help`,
      );
  }
}
