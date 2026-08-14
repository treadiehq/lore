#!/usr/bin/env node

import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { delimiter, dirname, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type AgentName,
  runHook,
} from "./runtime.js";
import { connectGithub, runGithubCommand } from "./github.js";
import { runDevinCommand } from "./devin.js";
import { runHostCommand } from "./host.js";
import { runDemoCommand } from "./demo.js";
import { updateCommand } from "./update.js";
import { IS_STANDALONE_BINARY, LORE_VERSION } from "./version.js";

const LORE_OWNER_ARGUMENT = "--owner lore";
const HOOK_EVENTS = ["UserPromptSubmit", "Stop", "SessionEnd"] as const;
type HookEvent = (typeof HOOK_EVENTS)[number];

export interface LorePaths {
  home: string;
  loreDirectory: string;
  config: string;
  runtime: string;
  runtimeRepository: string;
  runtimePackage: string;
  state: string;
  queue: string;
  codexHooks: string;
  claudeSettings: string;
}

export interface ConnectorConfig {
  version: 1;
  apiUrl: string;
  dashboardUrl?: string;
  token: string;
  agents: AgentName[];
  connectedAt: string;
  timeoutMs: number;
}

interface JsonDocument {
  exists: boolean;
  value: Record<string, unknown>;
  mode: number;
}

interface ConnectArguments {
  apiUrl?: string;
  dashboardUrl?: string;
  token?: string;
  agents: AgentName[];
  timeoutMs?: number;
  json: boolean;
}

interface OutputArguments {
  json: boolean;
}

interface AgentStatus {
  agent: AgentName;
  configured: boolean;
  executable: boolean;
  hookFile: string;
  installedHooks: number;
  expectedHooks: number;
}

const ROOT_HELP = `lore
Connect local coding agents to Lore shared engineering memory.

Usage:
  lore <command> [options]

Commands:
  connect      Configure Lore and install native agent hooks
  github       Prepare/post GitHub reviews and observe corrections
  devin        Start and manage Lore-enabled Devin sessions
  host         Call auditable APIs from external agent hosts
  status       Show connector and hook state
  doctor       Diagnose configuration, hooks, and API reachability
  demo         Prove a file-scoped Claude-to-Codex handoff
  update       Install the latest Lore CLI binary
  disconnect   Remove Lore-owned hooks and local credentials
  hook         Internal native hook handler

Discover:
  lore connect --help
  lore status --help
  lore doctor --help
  lore disconnect --help
  lore host --help

Examples:
  lore connect --url https://lore.example.com --token "$LORE_TOKEN"
  lore connect github --repo owner/repository
  lore status --json
  lore doctor
  lore demo
  lore update
  lore devin --help
`;

const CONNECT_HELP = `lore connect
Store a workspace credential and idempotently install Codex and Claude hooks.

Usage:
  lore connect --url <url> --token <token> [options]

Options:
  --url <url>           Lore API base URL (or LORE_API_URL)
  --dashboard-url <url> Lore dashboard URL used for receipt links
  --token <token>       Workspace bearer token (or LORE_TOKEN)
  --agent <name>        codex or claude; repeat to override auto-detection
  --timeout-ms <ms>     Hook request timeout, 250-10000 (default: 2500)
  --json                Print machine-readable output
  --help                Show this command's help

Examples:
  lore connect --url https://lore.example.com --token "$LORE_TOKEN"
  lore connect --url http://localhost:3004 --token dev-token --agent codex
`;

const STATUS_HELP = `lore status
Show whether Lore is configured and its native hooks are installed.

Usage:
  lore status [--json]

Examples:
  lore status
  lore status --json
`;

const DOCTOR_HELP = `lore doctor
Check local security, runtime, native hooks, agent binaries, and Lore health.

Usage:
  lore doctor [--json]

Examples:
  lore doctor
  lore doctor --json
`;

const DISCONNECT_HELP = `lore disconnect
Remove only Lore-owned native hooks, credentials, runtime, state, and retry queue.
Unrelated Codex and Claude settings and Lore-created backups are retained.

Usage:
  lore disconnect [--json]

Examples:
  lore disconnect
  lore disconnect --json
`;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneObject(value: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(value);
}

export function getLorePaths(home?: string): LorePaths {
  const resolvedHome = resolve(home ?? process.env.HOME ?? homedir());
  const loreDirectory = resolve(resolvedHome, ".lore");
  return {
    home: resolvedHome,
    loreDirectory,
    config: resolve(loreDirectory, "config.json"),
    runtime: resolve(loreDirectory, "bin", "lore-hook.mjs"),
    runtimeRepository: resolve(loreDirectory, "bin", "repository.js"),
    runtimePackage: resolve(loreDirectory, "bin", "package.json"),
    state: resolve(loreDirectory, "state"),
    queue: resolve(loreDirectory, "queue"),
    codexHooks: resolve(resolvedHome, ".codex", "hooks.json"),
    claudeSettings: resolve(resolvedHome, ".claude", "settings.json"),
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function hookCommand(agent: AgentName, paths: LorePaths): string {
  if (IS_STANDALONE_BINARY) {
    return `env -u BUN_OPTIONS -u BUN_BE_BUN ${shellQuote(process.execPath)} hook --agent ${agent} ${LORE_OWNER_ARGUMENT}`;
  }
  return `${shellQuote(process.execPath)} ${shellQuote(paths.runtime)} --agent ${agent} ${LORE_OWNER_ARGUMENT}`;
}

function isLoreHook(value: unknown): boolean {
  if (!isObject(value) || value.type !== "command") {
    return false;
  }
  const command = value.command;
  return (
    typeof command === "string" &&
    (/(?:^|\s)--owner(?:=|\s+)lore(?:\s|$)/u.test(command) ||
      command.includes("/.lore/bin/lore-hook.mjs"))
  );
}

function stripLoreFromEvent(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const groups: unknown[] = [];
  for (const candidate of value) {
    if (!isObject(candidate) || !Array.isArray(candidate.hooks)) {
      groups.push(candidate);
      continue;
    }
    const hooks = candidate.hooks.filter((hook) => !isLoreHook(hook));
    if (hooks.length === 0 && candidate.hooks.some(isLoreHook)) {
      continue;
    }
    groups.push({ ...candidate, hooks });
  }
  return groups;
}

function eventHandler(
  agent: AgentName,
  event: HookEvent,
  paths: LorePaths,
): Record<string, unknown> {
  return {
    type: "command",
    command: hookCommand(agent, paths),
    timeout: event === "SessionEnd" ? 2 : event === "Stop" ? 3 : 25,
    ...(event === "UserPromptSubmit"
      ? { statusMessage: "Loading Lore context" }
      : {}),
  };
}

export function mergeLoreHooks(
  input: Record<string, unknown>,
  agent: AgentName,
  paths: LorePaths,
): Record<string, unknown> {
  const result = cloneObject(input);
  if (result.hooks !== undefined && !isObject(result.hooks)) {
    throw new Error("Agent configuration field \"hooks\" must be a JSON object");
  }
  const hooks = isObject(result.hooks) ? { ...result.hooks } : {};
  for (const event of HOOK_EVENTS) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) {
      throw new Error(`Agent hook event "${event}" must be a JSON array`);
    }
    hooks[event] = [
      ...stripLoreFromEvent(hooks[event]),
      { hooks: [eventHandler(agent, event, paths)] },
    ];
  }
  result.hooks = hooks;
  return result;
}

export function removeLoreHooks(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const result = cloneObject(input);
  if (!isObject(result.hooks)) {
    return result;
  }
  const hooks = { ...result.hooks };
  for (const event of HOOK_EVENTS) {
    if (Array.isArray(hooks[event])) {
      const groups = stripLoreFromEvent(hooks[event]);
      if (groups.length === 0) {
        delete hooks[event];
      } else {
        hooks[event] = groups;
      }
    }
  }
  if (Object.keys(hooks).length === 0) {
    delete result.hooks;
  } else {
    result.hooks = hooks;
  }
  return result;
}

export function countLoreHooks(input: Record<string, unknown>): number {
  if (!isObject(input.hooks)) {
    return 0;
  }
  let count = 0;
  for (const event of HOOK_EVENTS) {
    const groups = input.hooks[event];
    if (!Array.isArray(groups)) {
      continue;
    }
    for (const group of groups) {
      if (isObject(group) && Array.isArray(group.hooks)) {
        count += group.hooks.filter(isLoreHook).length;
      }
    }
  }
  return count;
}

async function readJsonDocument(path: string): Promise<JsonDocument> {
  try {
    const [raw, metadata] = await Promise.all([
      readFile(path, "utf8"),
      stat(path),
    ]);
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) {
      throw new Error(`Expected a JSON object in ${path}`);
    }
    return {
      exists: true,
      value: parsed,
      mode: metadata.mode & 0o777,
    };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    if (code === "ENOENT") {
      return { exists: false, value: {}, mode: 0o600 };
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Refusing to overwrite invalid JSON in ${path}`, {
        cause: error,
      });
    }
    throw error;
  }
}

async function atomicWrite(
  path: string,
  content: string,
  mode: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, {
    encoding: "utf8",
    mode,
    flag: "wx",
  });
  await rename(temporary, path);
  await chmod(path, mode);
}

function backupTimestamp(now: Date): string {
  return now.toISOString().replaceAll(":", "").replaceAll(".", "-");
}

async function writeMergedJson(
  path: string,
  document: JsonDocument,
  value: Record<string, unknown>,
  now: Date,
): Promise<{ changed: boolean; backup?: string }> {
  if (JSON.stringify(document.value) === JSON.stringify(value)) {
    return { changed: false };
  }
  let backup: string | undefined;
  if (document.exists) {
    backup = `${path}.lore-backup-${backupTimestamp(now)}-${randomUUID().slice(0, 8)}`;
    await copyFile(path, backup, fsConstants.COPYFILE_EXCL);
  }
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, document.mode);
  return {
    changed: true,
    ...(backup === undefined ? {} : { backup }),
  };
}

function parseConnectorConfig(value: unknown): ConnectorConfig | null {
  if (
    !isObject(value) ||
    value.version !== 1 ||
    typeof value.apiUrl !== "string" ||
    typeof value.token !== "string" ||
    !Array.isArray(value.agents) ||
    typeof value.connectedAt !== "string"
  ) {
    return null;
  }
  const agents = value.agents.filter(
    (agent): agent is AgentName => agent === "codex" || agent === "claude",
  );
  const timeoutMs =
    typeof value.timeoutMs === "number" &&
    Number.isInteger(value.timeoutMs) &&
    value.timeoutMs >= 250 &&
    value.timeoutMs <= 10_000
      ? value.timeoutMs
      : 2_500;
  const dashboardUrl =
    typeof value.dashboardUrl === "string"
      ? normalizeApiUrl(value.dashboardUrl)
      : undefined;
  return {
    version: 1,
    apiUrl: value.apiUrl,
    ...(dashboardUrl === undefined ? {} : { dashboardUrl }),
    token: value.token,
    agents,
    connectedAt: value.connectedAt,
    timeoutMs,
  };
}

async function readConnectorConfig(
  paths: LorePaths,
): Promise<ConnectorConfig | null> {
  try {
    return parseConnectorConfig(
      JSON.parse(await readFile(paths.config, "utf8")) as unknown,
    );
  } catch {
    return null;
  }
}

function normalizeApiUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid Lore API URL: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Lore API URL must use http or https");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("Lore API URL must not contain credentials");
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed.href.replace(/\/+$/u, "");
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function commandExists(command: string): Promise<boolean> {
  const path = process.env.PATH;
  if (path === undefined) {
    return false;
  }
  for (const directory of path.split(delimiter)) {
    if (directory !== "" && (await isExecutable(resolve(directory, command)))) {
      return true;
    }
  }
  return false;
}

async function detectAgents(): Promise<AgentName[]> {
  const [codex, claude] = await Promise.all([
    commandExists("codex"),
    commandExists("claude"),
  ]);
  return [
    ...(codex ? (["codex"] as const) : []),
    ...(claude ? (["claude"] as const) : []),
  ];
}

async function installRuntime(paths: LorePaths): Promise<void> {
  if (IS_STANDALONE_BINARY) {
    await Promise.all([
      rm(paths.runtime, { force: true }),
      rm(paths.runtimeRepository, { force: true }),
      rm(paths.runtimePackage, { force: true }),
    ]);
    return;
  }
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const [runtime, repository] = await Promise.all([
    readFile(resolve(sourceDirectory, "runtime.js"), "utf8"),
    readFile(resolve(sourceDirectory, "repository.js"), "utf8"),
  ]);
  await Promise.all([
    atomicWrite(paths.runtime, runtime, 0o700),
    atomicWrite(paths.runtimeRepository, repository, 0o600),
    atomicWrite(paths.runtimePackage, '{"type":"module"}\n', 0o600),
  ]);
}

function hookPath(agent: AgentName, paths: LorePaths): string {
  return agent === "codex" ? paths.codexHooks : paths.claudeSettings;
}

function parseInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${flag} requires an integer`);
  }
  return parsed;
}

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

function parseConnectArguments(args: readonly string[]): ConnectArguments | null {
  const parsed: ConnectArguments = { agents: [], json: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(CONNECT_HELP);
      return null;
    }
    if (argument === "--json") {
      parsed.json = true;
      continue;
    }
    if (
      argument !== "--url" &&
      argument !== "--dashboard-url" &&
      argument !== "--token" &&
      argument !== "--agent" &&
      argument !== "--timeout-ms"
    ) {
      throw new Error(`Unknown connect option: ${argument ?? ""}`);
    }
    const [value, valueIndex] = valueAfter(args, index, argument);
    index = valueIndex;
    if (argument === "--url") {
      parsed.apiUrl = value;
    } else if (argument === "--dashboard-url") {
      parsed.dashboardUrl = value;
    } else if (argument === "--token") {
      parsed.token = value;
    } else if (argument === "--timeout-ms") {
      const timeoutMs = parseInteger(value, "--timeout-ms");
      if (timeoutMs < 250 || timeoutMs > 10_000) {
        throw new Error("--timeout-ms must be between 250 and 10000");
      }
      parsed.timeoutMs = timeoutMs;
    } else if (value === "codex" || value === "claude") {
      parsed.agents.push(value);
    } else {
      throw new Error("--agent must be codex or claude");
    }
  }
  return parsed;
}

function parseOutputArguments(
  args: readonly string[],
  help: string,
  command: string,
): OutputArguments | null {
  let json = false;
  for (const argument of args) {
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(help);
      return null;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    throw new Error(`Unknown ${command} option: ${argument}`);
  }
  return { json };
}

function writeResult(value: unknown, json: boolean, text: string): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : text);
}

async function connectCommand(args: readonly string[]): Promise<void> {
  const parsed = parseConnectArguments(args);
  if (parsed === null) {
    return;
  }
  if (platform() !== "darwin" && platform() !== "linux") {
    throw new Error("Lore hooks currently support macOS and Linux");
  }
  const paths = getLorePaths();
  const existing = await readConnectorConfig(paths);
  const apiUrlValue =
    parsed.apiUrl ??
    process.env.LORE_API_URL ??
    process.env.LORE_BASE_URL ??
    existing?.apiUrl;
  const token =
    parsed.token ?? process.env.LORE_TOKEN ?? existing?.token;
  const dashboardUrlValue =
    parsed.dashboardUrl ??
    process.env.LORE_DASHBOARD_URL ??
    existing?.dashboardUrl;
  if (apiUrlValue === undefined || apiUrlValue.trim() === "") {
    throw new Error(
      "Lore API URL is required. Use --url <url> or LORE_API_URL.",
    );
  }
  if (token === undefined || token.trim() === "") {
    throw new Error(
      "Workspace token is required. Use --token <token> or LORE_TOKEN.",
    );
  }
  const detected = parsed.agents.length === 0 ? await detectAgents() : [];
  const agents = [
    ...new Set<AgentName>([
      ...(existing?.agents ?? []),
      ...parsed.agents,
      ...detected,
    ]),
  ].sort();
  if (agents.length === 0) {
    throw new Error(
      "No Codex or Claude executable detected. Use --agent codex or --agent claude.",
    );
  }

  const now = new Date();
  const documents = new Map<AgentName, JsonDocument>();
  const mergedDocuments = new Map<AgentName, Record<string, unknown>>();
  for (const agent of agents) {
    const document = await readJsonDocument(hookPath(agent, paths));
    documents.set(agent, document);
    mergedDocuments.set(agent, mergeLoreHooks(document.value, agent, paths));
  }
  await installRuntime(paths);

  const changedHookFiles: string[] = [];
  const backups: string[] = [];
  for (const agent of agents) {
    const document = documents.get(agent);
    const merged = mergedDocuments.get(agent);
    if (document === undefined || merged === undefined) {
      continue;
    }
    const result = await writeMergedJson(
      hookPath(agent, paths),
      document,
      merged,
      now,
    );
    if (result.changed) {
      changedHookFiles.push(hookPath(agent, paths));
    }
    if (result.backup !== undefined) {
      backups.push(result.backup);
    }
  }

  const config: ConnectorConfig = {
    version: 1,
    apiUrl: normalizeApiUrl(apiUrlValue),
    ...(dashboardUrlValue === undefined
      ? {}
      : { dashboardUrl: normalizeApiUrl(dashboardUrlValue) }),
    token: token.trim(),
    agents,
    connectedAt: existing?.connectedAt ?? now.toISOString(),
    timeoutMs: parsed.timeoutMs ?? existing?.timeoutMs ?? 2_500,
  };
  await atomicWrite(paths.config, `${JSON.stringify(config, null, 2)}\n`, 0o600);
  const result = {
    connected: true,
    apiUrl: config.apiUrl,
    agents,
    config: paths.config,
    changedHookFiles,
    backups,
  };
  writeResult(
    result,
    parsed.json,
    `connected: ${agents.join(", ")}\napi_url: ${config.apiUrl}\nconfig: ${paths.config}\n`,
  );
}

async function queueCount(paths: LorePaths): Promise<number> {
  try {
    return (await readdir(paths.queue)).filter((entry) =>
      entry.endsWith(".json"),
    ).length;
  } catch {
    return 0;
  }
}

async function getAgentStatus(
  agent: AgentName,
  config: ConnectorConfig | null,
  paths: LorePaths,
): Promise<AgentStatus> {
  const path = hookPath(agent, paths);
  let installedHooks = 0;
  try {
    installedHooks = countLoreHooks((await readJsonDocument(path)).value);
  } catch {
    installedHooks = 0;
  }
  return {
    agent,
    configured: config?.agents.includes(agent) ?? false,
    executable: await commandExists(agent),
    hookFile: path,
    installedHooks,
    expectedHooks: HOOK_EVENTS.length,
  };
}

async function statusData(paths: LorePaths): Promise<{
  connected: boolean;
  apiUrl: string | null;
  config: string;
  configMode: string | null;
  runtimeInstalled: boolean;
  queuedTurns: number;
  agents: AgentStatus[];
}> {
  const config = await readConnectorConfig(paths);
  let configMode: string | null = null;
  try {
    configMode = (await stat(paths.config)).mode.toString(8).slice(-3);
  } catch {
    // Missing configuration is represented as disconnected.
  }
  const runtimeChecks = IS_STANDALONE_BINARY
    ? [access(process.execPath, fsConstants.R_OK | fsConstants.X_OK)]
    : [
        access(paths.runtime, fsConstants.R_OK | fsConstants.X_OK),
        access(paths.runtimeRepository, fsConstants.R_OK),
        access(paths.runtimePackage, fsConstants.R_OK),
      ];
  const [runtimeInstalled, queuedTurns, codex, claude] = await Promise.all([
    Promise.all(runtimeChecks).then(
      () => true,
      () => false,
    ),
    queueCount(paths),
    getAgentStatus("codex", config, paths),
    getAgentStatus("claude", config, paths),
  ]);
  return {
    connected: config !== null,
    apiUrl: config?.apiUrl ?? null,
    config: paths.config,
    configMode,
    runtimeInstalled,
    queuedTurns,
    agents: [codex, claude],
  };
}

async function statusCommand(args: readonly string[]): Promise<void> {
  const parsed = parseOutputArguments(args, STATUS_HELP, "status");
  if (parsed === null) {
    return;
  }
  const data = await statusData(getLorePaths());
  const agentLines = data.agents
    .map(
      (agent) =>
        `${agent.agent}: ${agent.configured ? "configured" : "not configured"}, hooks ${agent.installedHooks}/${agent.expectedHooks}, executable ${agent.executable ? "yes" : "no"}`,
    )
    .join("\n");
  writeResult(
    data,
    parsed.json,
    `connected: ${data.connected ? "yes" : "no"}\napi_url: ${data.apiUrl ?? "-"}\nconfig_mode: ${data.configMode ?? "-"}\nruntime: ${data.runtimeInstalled ? "installed" : "missing"}\nqueued_turns: ${data.queuedTurns}\n${agentLines}\n`,
  );
}

async function disconnectCommand(args: readonly string[]): Promise<void> {
  const parsed = parseOutputArguments(args, DISCONNECT_HELP, "disconnect");
  if (parsed === null) {
    return;
  }
  const paths = getLorePaths();
  const now = new Date();
  const changedHookFiles: string[] = [];
  const backups: string[] = [];
  for (const agent of ["codex", "claude"] as const) {
    const path = hookPath(agent, paths);
    const document = await readJsonDocument(path);
    if (!document.exists) {
      continue;
    }
    const result = await writeMergedJson(
      path,
      document,
      removeLoreHooks(document.value),
      now,
    );
    if (result.changed) {
      changedHookFiles.push(path);
    }
    if (result.backup !== undefined) {
      backups.push(result.backup);
    }
  }
  await Promise.all([
    rm(paths.config, { force: true }),
    rm(paths.runtime, { force: true }),
    rm(paths.runtimeRepository, { force: true }),
    rm(paths.runtimePackage, { force: true }),
    rm(paths.state, { recursive: true, force: true }),
    rm(paths.queue, { recursive: true, force: true }),
  ]);
  const result = { connected: false, changedHookFiles, backups };
  writeResult(
    result,
    parsed.json,
    `disconnected: yes\nchanged_hook_files: ${changedHookFiles.length}\n`,
  );
}

interface DoctorCheck {
  name: string;
  status: "ok" | "warning" | "error";
  detail: string;
}

async function apiHealth(config: ConnectorConfig): Promise<DoctorCheck> {
  const url = `${config.apiUrl.replace(/\/+$/u, "")}/health`;
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok
      ? { name: "api", status: "ok", detail: `${url} returned ${response.status}` }
      : {
          name: "api",
          status: "error",
          detail: `${url} returned ${response.status}`,
        };
  } catch (error) {
    return {
      name: "api",
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function doctorCommand(args: readonly string[]): Promise<void> {
  const parsed = parseOutputArguments(args, DOCTOR_HELP, "doctor");
  if (parsed === null) {
    return;
  }
  const paths = getLorePaths();
  const config = await readConnectorConfig(paths);
  const status = await statusData(paths);
  const checks: DoctorCheck[] = [];
  checks.push({
    name: "platform",
    status:
      platform() === "darwin" || platform() === "linux" ? "ok" : "error",
    detail: `${platform()} ${process.arch}`,
  });
  checks.push(
    IS_STANDALONE_BINARY
      ? {
          name: "binary",
          status: "ok",
          detail: `Lore ${LORE_VERSION} at ${process.execPath}`,
        }
      : {
          name: "node",
          status:
            Number(process.versions.node.split(".")[0]) >= 22 ? "ok" : "error",
          detail: process.versions.node,
        },
  );
  checks.push({
    name: "config",
    status: config === null ? "error" : "ok",
    detail: config === null ? `missing or invalid: ${paths.config}` : paths.config,
  });
  checks.push({
    name: "config-permissions",
    status: status.configMode === "600" ? "ok" : "error",
    detail: status.configMode ?? "missing",
  });
  checks.push({
    name: "runtime",
    status: status.runtimeInstalled ? "ok" : "error",
    detail: IS_STANDALONE_BINARY ? process.execPath : paths.runtime,
  });
  for (const agent of status.agents.filter((item) => item.configured)) {
    checks.push({
      name: `${agent.agent}-executable`,
      status: agent.executable ? "ok" : "warning",
      detail: agent.executable ? "found on PATH" : "not found on PATH",
    });
    checks.push({
      name: `${agent.agent}-hooks`,
      status:
        agent.installedHooks === agent.expectedHooks ? "ok" : "error",
      detail: `${agent.installedHooks}/${agent.expectedHooks} Lore hooks in ${agent.hookFile}`,
    });
  }
  checks.push({
    name: "retry-queue",
    status: status.queuedTurns === 0 ? "ok" : "warning",
    detail: `${status.queuedTurns} queued turn(s)`,
  });
  if (config !== null) {
    checks.push(await apiHealth(config));
  }
  const errors = checks.filter((check) => check.status === "error").length;
  const warnings = checks.filter((check) => check.status === "warning").length;
  const result = { ok: errors === 0, errors, warnings, checks };
  writeResult(
    result,
    parsed.json,
    `${checks.map((check) => `[${check.status.toUpperCase()}] ${check.name}: ${check.detail}`).join("\n")}\nsummary: ${errors} error(s), ${warnings} warning(s)\n`,
  );
  if (errors > 0) {
    process.exitCode = 1;
  }
}

export async function runCli(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const command = args[0];
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(ROOT_HELP);
    return;
  }
  if (command === "--version" || command === "-V") {
    process.stdout.write(`${LORE_VERSION}\n`);
    return;
  }
  const commandArgs = args.slice(1);
  switch (command) {
    case "connect":
      if (commandArgs[0] === "github") {
        await connectGithub(commandArgs.slice(1));
        return;
      }
      await connectCommand(commandArgs);
      return;
    case "github":
      await runGithubCommand(commandArgs);
      return;
    case "devin":
      await runDevinCommand(commandArgs);
      return;
    case "host":
      await runHostCommand(commandArgs);
      return;
    case "status":
      await statusCommand(commandArgs);
      return;
    case "doctor":
      await doctorCommand(commandArgs);
      return;
    case "demo":
      await runDemoCommand(
        commandArgs,
        await readConnectorConfig(getLorePaths()),
      );
      return;
    case "update":
      await updateCommand(commandArgs);
      return;
    case "disconnect":
      await disconnectCommand(commandArgs);
      return;
    case "hook":
      await runHook(commandArgs);
      return;
    default:
      throw new Error(`Unknown command: ${command}\nTry: lore --help`);
  }
}

const entryPath = process.argv[1];
if (
  !IS_STANDALONE_BINARY &&
  entryPath !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(entryPath))
) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  });
}
