import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const homes: string[] = [];
const cliPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../dist/cli.js",
);

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map(async (home) =>
      rm(home, { recursive: true, force: true }),
    ),
  );
});

describe("connect and disconnect", () => {
  it("backs up, preserves, secures, and idempotently removes config", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "lore-connect-"));
    homes.push(home);
    const hooksPath = resolve(home, ".codex", "hooks.json");
    await mkdir(dirname(hooksPath), { recursive: true });
    const original = {
      custom: { keep: true },
      hooks: {
        Stop: [
          {
            hooks: [{ type: "command", command: "existing-stop-hook" }],
          },
        ],
      },
    };
    await writeFile(hooksPath, `${JSON.stringify(original, null, 2)}\n`);
    const environment = { ...process.env, HOME: home };
    const connectArgs = [
      cliPath,
      "connect",
      "--url",
      "https://lore.example.test",
      "--token",
      "secret-workspace-token",
      "--agent",
      "codex",
      "--json",
    ];

    await execute(process.execPath, connectArgs, { env: environment });
    const configPath = resolve(home, ".lore", "config.json");
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    const connected = JSON.parse(await readFile(hooksPath, "utf8")) as unknown;
    expect(JSON.stringify(connected)).toContain("existing-stop-hook");
    expect(JSON.stringify(connected)).toContain("--owner lore");
    const firstBackups = (await readdir(dirname(hooksPath))).filter((entry) =>
      entry.includes(".lore-backup-"),
    );
    expect(firstBackups).toHaveLength(1);

    await execute(process.execPath, connectArgs, { env: environment });
    const secondBackups = (await readdir(dirname(hooksPath))).filter((entry) =>
      entry.includes(".lore-backup-"),
    );
    expect(secondBackups).toHaveLength(1);

    await execute(
      process.execPath,
      [cliPath, "disconnect", "--json"],
      { env: environment },
    );
    expect(JSON.parse(await readFile(hooksPath, "utf8"))).toEqual(original);
    await expect(access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
