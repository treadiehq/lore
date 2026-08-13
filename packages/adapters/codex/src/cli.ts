#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { CodexAdapter, type CodexTaskInput } from "./index.js";

type Command = "context" | "prompt" | "exec";

interface ParsedArguments {
  command: Command;
  baseUrl?: string;
  headers: string[];
  task?: string;
  stdin: boolean;
  review: boolean;
  organization?: string;
  project?: string;
  repo?: string;
  path?: string;
  scopeComponent?: string;
  diff?: string;
  diffFile?: string;
  files: string[];
  components: string[];
  symbols: string[];
  codexBin: string;
  codexArgs: string[];
  limit?: number;
}

const ROOT_HELP = `lore-codex
Retrieve shared engineering knowledge for Codex-compatible workflows.
The exec command injects context before launching a fresh codex exec process.

Usage:
  lore-codex <command> [options]

Commands:
  context   Print relevant shared knowledge
  prompt    Print a task enriched with relevant shared knowledge
  exec      Launch codex exec with an enriched prompt

Discover:
  lore-codex context --help
  lore-codex prompt --help
  lore-codex exec --help

Examples:
  lore-codex context --base-url http://localhost:3004 --task "Fix login"
  printf '%s' "Review this change" | lore-codex prompt --stdin --diff-file patch.diff
  lore-codex exec --repo api --review --diff-file patch.diff

Environment:
  LORE_API_URL    Default API base URL when --base-url is omitted
`;

const COMMON_OPTIONS = `Options:
  --base-url <url>        lore API URL (or LORE_BASE_URL)
  --header <name:value>   HTTP header; repeat for multiple headers
  --task <text>           Task text
  --stdin                 Read task text from stdin
  --review                Use a fresh code-review task if task text is omitted
  --organization <name>   Organization scope
  --project <name>        Project scope
  --repo <name>           Repository scope
  --path <path>           Path scope
  --scope-component <id>  Component scope
  --diff <text>           Inline diff
  --diff-file <path>      Read the diff from a file
  --file <path>           Relevant file; repeat as needed
  --component <name>      Relevant component; repeat as needed
  --symbol <name>         Relevant symbol; repeat as needed
  --limit <1-20>          Maximum learnings to retrieve
  --help                  Show this command's help`;

const CONTEXT_HELP = `lore-codex context
Print relevant shared engineering knowledge to stdout.

Usage:
  lore-codex context [options]

${COMMON_OPTIONS}

Examples:
  lore-codex context --base-url http://localhost:3004 --repo lore --task "Add a cache"
  git diff > patch.diff
  lore-codex context --review --diff-file patch.diff --file src/cache.ts
`;

const PROMPT_HELP = `lore-codex prompt
Print an enriched prompt with a delimited shared-knowledge section to stdout.
When no learning is selected, the original task is printed unchanged.

Usage:
  lore-codex prompt [options]

${COMMON_OPTIONS}

Examples:
  lore-codex prompt --base-url http://localhost:3004 --task "Fix login"
  printf '%s' "Refactor the parser" | lore-codex prompt --stdin --repo lore
  lore-codex prompt --review --diff-file patch.diff --file src/parser.ts
`;

const EXEC_HELP = `lore-codex exec
Launch a fresh non-interactive Codex task after automatically injecting relevant
lore knowledge. The wrapper does not claim to observe interactive corrections;
submit completed transcripts through POST /v1/interactions.

Usage:
  lore-codex exec [options]

${COMMON_OPTIONS}
  --codex-bin <path>      Codex executable (default: codex)
  --codex-arg <value>     Extra codex exec argument; repeat as needed

Examples:
  lore-codex exec --repo api --review --diff-file patch.diff
  lore-codex exec --task "Fix login" --codex-arg --full-auto
`;

const VALUE_OPTIONS = new Set([
  "--base-url",
  "--header",
  "--task",
  "--organization",
  "--project",
  "--repo",
  "--path",
  "--scope-component",
  "--diff",
  "--diff-file",
  "--file",
  "--component",
  "--symbol",
  "--codex-bin",
  "--codex-arg",
  "--limit",
]);

function usageError(message: string, command?: Command): Error {
  const helpCommand =
    command === undefined
      ? "lore-codex --help"
      : `lore-codex ${command} --help`;
  return new Error(`${message}\nTry: ${helpCommand}`);
}

function valueAfter(
  args: readonly string[],
  index: number,
  flag: string,
  command: Command,
): [string, number] {
  const value = args[index + 1];
  if (value === undefined) {
    throw usageError(`Missing value for ${flag}.`, command);
  }
  return [value, index + 1];
}

function parseLimit(value: string, command: Command): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw usageError("--limit must be an integer from 1 through 20.", command);
  }
  return limit;
}

function parseArguments(args: readonly string[]): ParsedArguments | null {
  const first = args[0];
  if (first === undefined || first === "--help" || first === "-h") {
    process.stdout.write(ROOT_HELP);
    return null;
  }
  if (first !== "context" && first !== "prompt" && first !== "exec") {
    throw usageError(`Unknown command: ${first}`);
  }
  const command = first;
  const parsed: ParsedArguments = {
    command,
    headers: [],
    stdin: false,
    review: false,
    files: [],
    components: [],
    symbols: [],
    codexBin: "codex",
    codexArgs: [],
  };

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(
        command === "context"
          ? CONTEXT_HELP
          : command === "prompt"
            ? PROMPT_HELP
            : EXEC_HELP,
      );
      return null;
    }
    if (argument === "--stdin") {
      parsed.stdin = true;
      continue;
    }
    if (argument === "--review") {
      parsed.review = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(argument)) {
      throw usageError(`Unknown option: ${argument}`, command);
    }

    const [value, valueIndex] = valueAfter(args, index, argument, command);
    index = valueIndex;
    switch (argument) {
      case "--base-url":
        parsed.baseUrl = value;
        break;
      case "--header":
        parsed.headers.push(value);
        break;
      case "--task":
        parsed.task = value;
        break;
      case "--organization":
        parsed.organization = value;
        break;
      case "--project":
        parsed.project = value;
        break;
      case "--repo":
        parsed.repo = value;
        break;
      case "--path":
        parsed.path = value;
        break;
      case "--scope-component":
        parsed.scopeComponent = value;
        break;
      case "--diff":
        parsed.diff = value;
        break;
      case "--diff-file":
        parsed.diffFile = value;
        break;
      case "--file":
        parsed.files.push(value);
        break;
      case "--component":
        parsed.components.push(value);
        break;
      case "--symbol":
        parsed.symbols.push(value);
        break;
      case "--codex-bin":
        parsed.codexBin = value;
        break;
      case "--codex-arg":
        parsed.codexArgs.push(value);
        break;
      case "--limit":
        parsed.limit = parseLimit(value, command);
        break;
    }
  }
  return parsed;
}

async function runCodexProcess(
  executable: string,
  args: readonly string[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { stdio: "inherit" });
    child.once("error", (error) => {
      reject(
        new Error(
          `Unable to launch Codex executable "${executable}": ${error.message}`,
          { cause: error },
        ),
      );
    });
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`Codex exited after receiving signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Codex exited with status ${code ?? "unknown"}`));
        return;
      }
      resolve();
    });
  });
}

function parseHeaders(values: readonly string[]): Headers {
  const headers = new Headers();
  for (const value of values) {
    const separator = value.indexOf(":");
    const name = value.slice(0, separator).trim();
    const headerValue = value.slice(separator + 1).trim();
    if (separator < 1 || name === "" || headerValue === "") {
      throw new Error(
        `Invalid --header "${value}". Expected --header "name:value".`,
      );
    }
    headers.set(name, headerValue);
  }
  return headers;
}

async function readTaskFromStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let task = "";
  for await (const chunk of process.stdin) {
    task += String(chunk);
  }
  return task;
}

async function resolveTask(
  parsed: ParsedArguments,
): Promise<string | undefined> {
  if (parsed.stdin && parsed.task !== undefined) {
    throw usageError(
      "Use either --task or --stdin, not both.",
      parsed.command,
    );
  }
  if (!parsed.stdin) {
    return parsed.task;
  }
  const task = await readTaskFromStdin();
  if (task.trim() === "") {
    throw usageError("stdin did not contain task text.", parsed.command);
  }
  return task;
}

async function resolveDiff(parsed: ParsedArguments): Promise<string | undefined> {
  if (parsed.diff !== undefined && parsed.diffFile !== undefined) {
    throw usageError(
      "Use either --diff or --diff-file, not both.",
      parsed.command,
    );
  }
  if (parsed.diffFile === undefined) {
    return parsed.diff;
  }
  try {
    return await readFile(parsed.diffFile, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to read diff file "${parsed.diffFile}": ${detail}`,
    );
  }
}

function buildTaskInput(
  parsed: ParsedArguments,
  task: string | undefined,
  diff: string | undefined,
): CodexTaskInput {
  if (task === undefined && !parsed.review) {
    throw usageError(
      'Task text is required. Use --task "..." or --stdin.',
      parsed.command,
    );
  }
  return {
    ...(task === undefined ? {} : { task }),
    ...(parsed.review ? { review: true } : {}),
    ...(parsed.organization === undefined
      ? {}
      : { organization: parsed.organization }),
    ...(parsed.project === undefined ? {} : { project: parsed.project }),
    ...(parsed.repo === undefined ? {} : { repo: parsed.repo }),
    ...(parsed.path === undefined ? {} : { path: parsed.path }),
    ...(parsed.scopeComponent === undefined
      ? {}
      : { component: parsed.scopeComponent }),
    ...(diff === undefined ? {} : { diff }),
    ...(parsed.files.length === 0 ? {} : { files: parsed.files }),
    ...(parsed.components.length === 0
      ? {}
      : { components: parsed.components }),
    ...(parsed.symbols.length === 0 ? {} : { symbols: parsed.symbols }),
    ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
  };
}

export async function runCodexCli(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const parsed = parseArguments(args);
  if (parsed === null) {
    return;
  }
  const baseUrl =
    parsed.baseUrl ??
    process.env.LORE_API_URL ??
    process.env.LORE_BASE_URL;
  if (baseUrl === undefined || baseUrl.trim() === "") {
    throw usageError(
      "API base URL is required. Use --base-url <url> or LORE_API_URL.",
      parsed.command,
    );
  }
  const [task, diff] = await Promise.all([
    resolveTask(parsed),
    resolveDiff(parsed),
  ]);
  const input = buildTaskInput(parsed, task, diff);
  const adapter = new CodexAdapter({
    baseUrl,
    headers: parseHeaders(parsed.headers),
  });

  if (parsed.command === "context") {
    const context = await adapter.formatContext(
      await adapter.getContext(input),
    );
    process.stdout.write(context === "" ? "" : `${context}\n`);
    return;
  }
  const prepared = await adapter.prepareTask(input);
  if (parsed.command === "prompt") {
    process.stdout.write(`${prepared.prompt}\n`);
    return;
  }
  await runCodexProcess(parsed.codexBin, [
    "exec",
    ...parsed.codexArgs,
    prepared.prompt,
  ]);
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(entryPath).href
) {
  runCodexCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  });
}
