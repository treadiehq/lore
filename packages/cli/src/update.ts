import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { IS_STANDALONE_BINARY } from "./version.js";

const DEFAULT_INSTALL_URL =
  "https://raw.githubusercontent.com/treadiehq/lore/main/scripts/install.sh";

const UPDATE_HELP = `lore update
Install the latest Lore CLI binary, or a specific release.

Usage:
  lore update [--version <tag>]

Options:
  --version <tag>  Release tag to install, for example v0.1.2
  -h, --help       Show this help

Environment:
  LORE_INSTALL_URL  Installer script URL

Examples:
  lore update
  lore update --version v0.1.2
`;

function parseVersion(args: readonly string[]): string | undefined | null {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(UPDATE_HELP);
    return null;
  }
  if (args.length === 0) {
    return undefined;
  }
  if (args.length === 2 && args[0] === "--version") {
    const version = args[1]?.trim();
    if (version !== undefined && /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
      return version;
    }
    throw new Error("--version must be a release tag such as v0.1.2");
  }
  throw new Error("Unknown update options. Try: lore update --help");
}

function runInstaller(path: string, environment: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("bash", [path], {
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          signal === null
            ? `Lore installer exited with code ${code ?? 1}`
            : `Lore installer stopped with signal ${signal}`,
        ),
      );
    });
  });
}

export async function updateCommand(args: readonly string[]): Promise<void> {
  const version = parseVersion(args);
  if (version === null) {
    return;
  }
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("Binary updates currently support macOS and Linux");
  }

  const installUrl = process.env.LORE_INSTALL_URL?.trim() || DEFAULT_INSTALL_URL;
  const parsedUrl = new URL(installUrl);
  if (parsedUrl.protocol !== "https:") {
    throw new Error("LORE_INSTALL_URL must use HTTPS");
  }

  const response = await fetch(parsedUrl, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(
      `Could not download the Lore installer (HTTP ${response.status})`,
    );
  }

  const directory = await mkdtemp(resolve(tmpdir(), "lore-update-"));
  const installer = resolve(directory, "install.sh");
  try {
    await writeFile(installer, await response.text(), {
      encoding: "utf8",
      mode: 0o700,
    });
    await runInstaller(installer, {
      ...process.env,
      ...(version === undefined ? {} : { LORE_VERSION: version }),
      ...(IS_STANDALONE_BINARY && process.env.LORE_BIN_DIR === undefined
        ? { LORE_BIN_DIR: dirname(process.execPath) }
        : {}),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
