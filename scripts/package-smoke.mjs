import { execFile as execFileCallback } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = [
  resolve(root, "packages/core"),
  resolve(root, "packages/sdk"),
  resolve(root, "packages/adapters/generic"),
  resolve(root, "packages/cli"),
];

async function run(command, args, cwd) {
  return execFile(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

const temporary = await mkdtemp(resolve(tmpdir(), "lore-package-smoke-"));
const packedDirectory = resolve(temporary, "packed");
const fixture = resolve(temporary, "consumer");

try {
  await mkdir(packedDirectory, { recursive: true });
  await mkdir(fixture, { recursive: true });

  for (const packageDirectory of packages) {
    await run(
      "pnpm",
      ["pack", "--pack-destination", packedDirectory],
      packageDirectory,
    );
  }

  const tarballs = (await readdir(packedDirectory))
    .filter((name) => name.endsWith(".tgz"))
    .sort()
    .map((name) => resolve(packedDirectory, name));
  if (tarballs.length !== packages.length) {
    throw new Error(
      `Expected ${packages.length} packed packages, found ${tarballs.length}`,
    );
  }

  await writeFile(
    resolve(fixture, "package.json"),
    `${JSON.stringify(
      {
        name: "outside-lore-package-smoke",
        version: "1.0.0",
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
  );
  await run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      ...tarballs,
    ],
    fixture,
  );

  const installedSdk = JSON.parse(
    await readFile(
      resolve(fixture, "node_modules/@lore-co/sdk/package.json"),
      "utf8",
    ),
  );
  const installedAdapter = JSON.parse(
    await readFile(
      resolve(fixture, "node_modules/@lore-co/adapter-generic/package.json"),
      "utf8",
    ),
  );
  const installedCli = JSON.parse(
    await readFile(
      resolve(fixture, "node_modules/@lore-co/cli/package.json"),
      "utf8",
    ),
  );
  if (
    installedSdk.dependencies?.["@lore-co/core"] !== "0.1.0" ||
    installedAdapter.dependencies?.["@lore-co/core"] !== "0.1.0" ||
    installedAdapter.dependencies?.["@lore-co/sdk"] !== "0.1.0" ||
    installedCli.dependencies?.["@lore-co/core"] !== "0.1.0" ||
    installedCli.dependencies?.["@lore-co/sdk"] !== "0.1.0"
  ) {
    throw new Error("pnpm pack did not rewrite workspace dependencies");
  }

  await writeFile(
    resolve(fixture, "smoke.mjs"),
    `import { AgentTaskSchema } from "@lore-co/core";
import { LoreClient } from "@lore-co/sdk";
import { GenericAgentAdapter } from "@lore-co/adapter-generic";

const client = new LoreClient({
  baseUrl: "https://lore.invalid",
  fetch: async () => new Response("{}", { status: 200 }),
});
const adapter = new GenericAgentAdapter({ id: "fixture-host", client });
const task = AgentTaskSchema.parse({
  agent: adapter.id,
  task: "Verify package imports",
  scope: { repo: "acme/example" },
});
if (task.agent !== "fixture-host" || adapter.toTask({ task: task.task }).agent !== "fixture-host") {
  throw new Error("Published API construction failed");
}
`,
  );
  await run(process.execPath, ["smoke.mjs"], fixture);
  const loreExecutable = resolve(
    fixture,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "lore.cmd" : "lore",
  );
  const cliResult = await run(loreExecutable, ["--version"], fixture);
  if (cliResult.stdout.trim() !== "0.1.0") {
    throw new Error(
      `Installed Lore CLI did not execute through its package binary: ${cliResult.stdout.trim() || "<no output>"}`,
    );
  }

  process.stdout.write(
    `package smoke passed: ${tarballs.map((path) => path.split("/").at(-1)).join(", ")}\n`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
