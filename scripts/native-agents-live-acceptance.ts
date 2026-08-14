import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { runDemoCommand } from "../packages/cli/src/demo.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function main(): Promise<void> {
  if (process.env.RUN_NATIVE_AGENT_LIVE_TESTS !== "1") {
    throw new Error(
      "Live native-agent acceptance is disabled. Set RUN_NATIVE_AGENT_LIVE_TESTS=1 to acknowledge real Claude and Codex usage.",
    );
  }
  const timeoutMs =
    process.env.NATIVE_AGENT_COMMAND_TIMEOUT_MS?.trim() || "120000";
  const claudeModel =
    process.env.NATIVE_AGENT_CLAUDE_MODEL?.trim() || "haiku";
  const codexModel = process.env.NATIVE_AGENT_CODEX_MODEL?.trim();
  await runDemoCommand(
    [
      "--json",
      "--timeout-ms",
      timeoutMs,
      "--claude-model",
      claudeModel,
      ...(codexModel === undefined || codexModel === ""
        ? []
        : ["--codex-model", codexModel]),
    ],
    {
      apiUrl: required("LORE_API_URL").replace(/\/+$/u, ""),
      token: required("LORE_WORKSPACE_TOKEN"),
      agents: ["claude", "codex"],
    },
  );
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
