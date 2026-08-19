import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  access,
  chmod,
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
const servers: Server[] = [];
const cliPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../dist/cli.js",
);

interface LocalLoreServerOptions {
  identityStatus?: number;
  identityDelayMs?: number;
  readinessStatus?: number;
  serverVersion?: string;
}

async function localLoreUrl(
  options: LocalLoreServerOptions = {},
): Promise<string> {
  const server = createServer((request, response) => {
    if (request.url === "/v1/workspace/identity") {
      const sendIdentity = (): void => {
        response.statusCode = options.identityStatus ?? 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify(
            response.statusCode === 200
              ? {
                  workspaceId: "22222222-2222-4222-8222-222222222222",
                  workspaceName: "Test Workspace",
                  organization: "test",
                  credentialType: "workspace_token",
                  server: {
                    version: options.serverVersion ?? "0.1.4",
                    revision: null,
                  },
                }
              : { message: "Unauthorized" },
          ),
        );
      };
      if ((options.identityDelayMs ?? 0) > 0) {
        setTimeout(sendIdentity, options.identityDelayMs);
      } else {
        sendIdentity();
      }
      return;
    }
    if (request.url === "/health/ready") {
      response.statusCode = options.readinessStatus ?? 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok", check: "readiness" }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a local TCP test server");
  }
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all([
    ...homes.splice(0).map(async (home) =>
      rm(home, { recursive: true, force: true }),
    ),
    ...servers.splice(0).map(
      (server) =>
        new Promise<void>((resolveClose, reject) => {
          server.close((error) => {
            if (error === undefined) {
              resolveClose();
            } else {
              reject(error);
            }
          });
        }),
    ),
  ]);
});

describe("connect and disconnect", () => {
  it("backs up, preserves, secures, and idempotently removes config", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "lore-connect-"));
    const apiUrl = await localLoreUrl();
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
      apiUrl,
      "--token",
      "secret-workspace-token",
      "--agent",
      "codex",
      "--json",
    ];

    const first = await execute(process.execPath, connectArgs, {
      env: environment,
    });
    expect(JSON.parse(first.stdout)).toMatchObject({
      connected: true,
      identity: {
        workspaceName: "Test Workspace",
        credentialType: "workspace_token",
      },
    });
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

  it("auto-detects OpenCode config and preserves it across reconnect/disconnect", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "lore-opencode-connect-"));
    const apiUrl = await localLoreUrl();
    homes.push(home);
    const openCodePath = resolve(
      home,
      ".config",
      "opencode",
      "opencode.json",
    );
    const emptyPath = resolve(home, "empty-path");
    await mkdir(dirname(openCodePath), { recursive: true });
    await mkdir(emptyPath, { recursive: true });
    const original = {
      $schema: "https://opencode.ai/config.json",
      theme: "system",
      plugin: ["keep-opencode-plugin"],
      keybinds: { leader: "ctrl+x" },
    };
    await writeFile(openCodePath, `${JSON.stringify(original, null, 2)}\n`);
    const environment = {
      ...process.env,
      HOME: home,
      PATH: emptyPath,
    };
    const connectArgs = [
      cliPath,
      "connect",
      "--url",
      apiUrl,
      "--token",
      "secret-workspace-token",
      "--json",
    ];

    await execute(process.execPath, connectArgs, { env: environment });
    const connectorConfig = JSON.parse(
      await readFile(resolve(home, ".lore", "config.json"), "utf8"),
    ) as { agents: string[] };
    expect(connectorConfig.agents).toEqual(["opencode"]);
    expect(JSON.parse(await readFile(openCodePath, "utf8"))).toEqual({
      ...original,
      plugin: ["keep-opencode-plugin", "@lore-co/opencode"],
    });
    await expect(
      access(resolve(home, ".claude", "settings.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(resolve(home, ".lore", "bin", "lore-hook.mjs")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const status = await execute(
      process.execPath,
      [cliPath, "status", "--json"],
      { env: environment },
    );
    const statusData = JSON.parse(status.stdout) as {
      connected: boolean;
      runtimeRequired: boolean;
      agents: unknown[];
    };
    expect(statusData).toMatchObject({
      connected: true,
      runtimeRequired: false,
    });
    expect(statusData.agents).toEqual(
      expect.arrayContaining([
        {
          agent: "opencode",
          configured: true,
          executable: false,
          configExists: true,
          configFile: openCodePath,
          integration: "plugin",
          installed: 1,
          expected: 1,
        },
      ]),
    );
    const doctor = await execute(
      process.execPath,
      [cliPath, "doctor", "--json"],
      { env: environment },
    );
    const doctorData = JSON.parse(doctor.stdout) as {
      ok: boolean;
      checks: Array<{ name: string; status: string }>;
    };
    expect(doctorData.ok).toBe(true);
    expect(doctorData.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "opencode-plugin",
          status: "ok",
        }),
        expect.objectContaining({ name: "api-readiness", status: "ok" }),
        expect.objectContaining({ name: "api-identity", status: "ok" }),
      ]),
    );
    expect(doctorData.checks.some((check) => check.name === "runtime")).toBe(
      false,
    );

    await execute(process.execPath, connectArgs, { env: environment });
    expect(
      (await readdir(dirname(openCodePath))).filter((entry) =>
        entry.includes(".lore-backup-"),
      ),
    ).toHaveLength(1);

    await execute(
      process.execPath,
      [cliPath, "disconnect", "--json"],
      { env: environment },
    );
    expect(JSON.parse(await readFile(openCodePath, "utf8"))).toEqual(original);
    expect(
      (await readdir(dirname(openCodePath))).filter((entry) =>
        entry.includes(".lore-backup-"),
      ),
    ).toHaveLength(2);
  });

  it("auto-detects the OpenCode executable", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "lore-opencode-executable-"));
    const apiUrl = await localLoreUrl();
    homes.push(home);
    const bin = resolve(home, "bin");
    const executable = resolve(bin, "opencode");
    await mkdir(bin, { recursive: true });
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
    const environment = { ...process.env, HOME: home, PATH: bin };

    await execute(
      process.execPath,
      [
        cliPath,
        "connect",
        "--url",
        apiUrl,
        "--token",
        "secret-workspace-token",
        "--json",
      ],
      { env: environment },
    );

    const config = JSON.parse(
      await readFile(resolve(home, ".lore", "config.json"), "utf8"),
    ) as { agents: string[] };
    expect(config.agents).toEqual(["opencode"]);
    await expect(
      access(resolve(home, ".config", "opencode", "opencode.json")),
    ).resolves.toBeUndefined();
  });

  it("preflights authentication before writing credentials or hooks", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "lore-connect-unauthorized-"));
    const apiUrl = await localLoreUrl({ identityStatus: 401 });
    homes.push(home);
    const hooksPath = resolve(home, ".codex", "hooks.json");
    await mkdir(dirname(hooksPath), { recursive: true });
    await writeFile(hooksPath, '{"custom":"unchanged"}\n');

    await expect(
      execute(
        process.execPath,
        [
          cliPath,
          "connect",
          "--url",
          apiUrl,
          "--token",
          "revoked-workspace-token",
          "--agent",
          "codex",
          "--json",
        ],
        { env: { ...process.env, HOME: home } },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Lore authentication failed"),
    });

    expect(await readFile(hooksPath, "utf8")).toBe('{"custom":"unchanged"}\n');
    await expect(
      access(resolve(home, ".lore", "config.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(resolve(home, ".lore", "bin", "lore-hook.mjs")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("times out preflight without mutating a clean home", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "lore-connect-timeout-"));
    const apiUrl = await localLoreUrl({ identityDelayMs: 1_000 });
    homes.push(home);

    await expect(
      execute(
        process.execPath,
        [
          cliPath,
          "connect",
          "--url",
          apiUrl,
          "--token",
          "workspace-token",
          "--agent",
          "codex",
          "--timeout-ms",
          "250",
        ],
        { env: { ...process.env, HOME: home } },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Lore preflight timed out after 250ms"),
    });
    await expect(access(resolve(home, ".lore"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects an incompatible server before creating local state", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "lore-connect-version-"));
    const apiUrl = await localLoreUrl({ serverVersion: "0.2.0" });
    homes.push(home);

    await expect(
      execute(
        process.execPath,
        [
          cliPath,
          "connect",
          "--url",
          apiUrl,
          "--token",
          "workspace-token",
          "--agent",
          "codex",
        ],
        { env: { ...process.env, HOME: home } },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("incompatible with this CLI"),
    });
    await expect(access(resolve(home, ".lore"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("accepts the canonical token env and rejects conflicting aliases", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "lore-connect-token-env-"));
    const apiUrl = await localLoreUrl();
    homes.push(home);
    const environment = {
      ...process.env,
      HOME: home,
      LORE_API_URL: apiUrl,
      LORE_WORKSPACE_TOKEN: "canonical-token",
      LORE_TOKEN: "different-legacy-token",
    };

    await expect(
      execute(
        process.execPath,
        [cliPath, "connect", "--agent", "codex"],
        { env: environment },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "LORE_WORKSPACE_TOKEN and LORE_TOKEN disagree",
      ),
    });
    await expect(access(resolve(home, ".lore"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    environment.LORE_TOKEN = environment.LORE_WORKSPACE_TOKEN;
    await expect(
      execute(
        process.execPath,
        [cliPath, "connect", "--agent", "codex", "--json"],
        { env: environment },
      ),
    ).resolves.toMatchObject({ stdout: expect.stringContaining('"connected"') });
  });

  it("doctor distinguishes unready and unauthorized API state", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "lore-doctor-api-state-"));
    const options: LocalLoreServerOptions = {};
    const apiUrl = await localLoreUrl(options);
    homes.push(home);
    const environment = { ...process.env, HOME: home };
    await execute(
      process.execPath,
      [
        cliPath,
        "connect",
        "--url",
        apiUrl,
        "--token",
        "workspace-token",
        "--agent",
        "codex",
      ],
      { env: environment },
    );
    options.readinessStatus = 503;
    options.identityStatus = 401;

    let failure: unknown;
    try {
      await execute(process.execPath, [cliPath, "doctor", "--json"], {
        env: environment,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    const output =
      typeof failure === "object" &&
      failure !== null &&
      "stdout" in failure &&
      typeof failure.stdout === "string"
        ? failure.stdout
        : "";
    const doctor = JSON.parse(output) as {
      checks: Array<{ name: string; status: string; detail: string }>;
    };
    expect(doctor.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "api-readiness",
          status: "error",
          detail: expect.stringContaining("unready"),
        }),
        expect.objectContaining({
          name: "api-identity",
          status: "error",
          detail: expect.stringContaining("unauthorized"),
        }),
      ]),
    );
  });
});
