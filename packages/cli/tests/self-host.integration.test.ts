import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { SELF_HOST_COMPOSE_ASSET } from "../src/generated-assets.js";

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];
const servers: Server[] = [];
const cliPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../dist/cli.js",
);
const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

interface Fixture {
  home: string;
  stateDirectory: string;
  dockerLog: string;
  apiPort: number;
  environment: NodeJS.ProcessEnv;
}

async function fixture(): Promise<Fixture> {
  const home = await mkdtemp(resolve(tmpdir(), "lore-self-host-"));
  temporaryDirectories.push(home);
  const bin = resolve(home, "bin");
  const docker = resolve(bin, "docker");
  const dockerLog = resolve(home, "docker.log");
  await mkdir(bin, { recursive: true });
  await writeFile(
    docker,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *"ps --format json"*) printf '[]\\n' ;;
  *"lore-reset-password"*) printf '%s\\n' "$FAKE_RESET_URL" ;;
esac
`,
  );
  await chmod(docker, 0o755);

  const server = createServer((request, response) => {
    response.statusCode = request.url === "/health/ready" ? 200 : 404;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        response.statusCode === 200
          ? { status: "ok", check: "readiness" }
          : { message: "Not found" },
      ),
    );
  });
  servers.push(server);
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected local self-host test server");
  }
  return {
    home,
    stateDirectory: resolve(home, ".lore", "self-host"),
    dockerLog,
    apiPort: address.port,
    environment: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_DOCKER_LOG: dockerLog,
      FAKE_RESET_URL:
        "http://localhost:3000/auth/reset#token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  };
}

function parseEnvironment(raw: string): Record<string, string> {
  return Object.fromEntries(
    raw
      .trim()
      .split(/\r?\n/u)
      .map((line) => {
        const separator = line.indexOf("=");
        return [
          line.slice(0, separator),
          JSON.parse(line.slice(separator + 1)) as string,
        ];
      }),
  );
}

afterEach(async () => {
  await Promise.all([
    ...temporaryDirectories.splice(0).map(async (path) =>
      rm(path, { recursive: true, force: true }),
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

describe("self-host lifecycle", () => {
  it("embeds the canonical production Compose asset", async () => {
    expect(SELF_HOST_COMPOSE_ASSET).toBe(
      await readFile(resolve(repositoryRoot, "docker-compose.yml"), "utf8"),
    );
  });

  it("initializes a clean home securely and preserves secrets on repeat up", async () => {
    const test = await fixture();
    const command = [
      cliPath,
      "self-host",
      "up",
      "--api-port",
      String(test.apiPort),
      "--image-tag",
      "0.1.4",
      "--organization",
      "acme",
      "--name",
      "Acme Engineering",
      "--json",
    ];
    const first = await execute(process.execPath, command, {
      env: test.environment,
    });
    const firstResult = JSON.parse(first.stdout) as {
      status: string;
      setupUrl: string;
      bootstrapToken?: string;
    };
    expect(firstResult).toMatchObject({
      status: "ready",
      setupUrl: "http://127.0.0.1:3000/setup",
    });
    expect(firstResult.bootstrapToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const environmentPath = resolve(test.stateDirectory, "lore.env");
    const metadataPath = resolve(test.stateDirectory, "state.json");
    const composePath = resolve(test.stateDirectory, "compose.yml");
    const firstEnvironmentRaw = await readFile(environmentPath, "utf8");
    const values = parseEnvironment(firstEnvironmentRaw);
    expect(values.LORE_WORKSPACE_TOKEN).toMatch(
      /^lore_[A-Za-z0-9_-]{43}$/u,
    );
    expect(values.POSTGRES_PASSWORD).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(values.LORE_OWNER_BOOTSTRAP_TOKEN).toBe(
      firstResult.bootstrapToken,
    );
    expect(
      new Set([
        values.POSTGRES_PASSWORD,
        values.LORE_WORKSPACE_TOKEN,
        values.LORE_OWNER_BOOTSTRAP_TOKEN,
      ]).size,
    ).toBe(3);
    expect((await stat(test.stateDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(environmentPath)).mode & 0o777).toBe(0o600);
    expect((await stat(metadataPath)).mode & 0o777).toBe(0o600);
    expect((await stat(composePath)).mode & 0o777).toBe(0o600);

    const second = await execute(process.execPath, command, {
      env: test.environment,
    });
    const secondResult = JSON.parse(second.stdout) as Record<string, unknown>;
    expect(secondResult.status).toBe("ready");
    expect(secondResult).not.toHaveProperty("bootstrapToken");
    expect(await readFile(environmentPath, "utf8")).toBe(firstEnvironmentRaw);
    const dockerCalls = (await readFile(test.dockerLog, "utf8"))
      .split(/\r?\n/u)
      .filter((line) => line.includes(" up "));
    expect(dockerCalls).toHaveLength(2);
    expect(dockerCalls[0]).toContain("--wait");
  });

  it("keeps down safe by default and gates volume deletion", async () => {
    const test = await fixture();
    await execute(
      process.execPath,
      [
        cliPath,
        "self-host",
        "up",
        "--api-port",
        String(test.apiPort),
        "--json",
      ],
      { env: test.environment },
    );
    const safeDown = await execute(
      process.execPath,
      [cliPath, "self-host", "down", "--json"],
      { env: test.environment },
    );
    expect(JSON.parse(safeDown.stdout)).toMatchObject({
      status: "stopped",
      volumesDeleted: false,
    });
    expect((await readFile(test.dockerLog, "utf8")).split("\n").at(-2)).not.toContain(
      "--volumes",
    );

    await expect(
      execute(
        process.execPath,
        [cliPath, "self-host", "down", "--volumes", "--json"],
        { env: test.environment },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("requires --volumes --yes"),
    });
    const destructiveDown = await execute(
      process.execPath,
      [cliPath, "self-host", "down", "--volumes", "--yes", "--json"],
      { env: test.environment },
    );
    expect(JSON.parse(destructiveDown.stdout)).toMatchObject({
      status: "stopped",
      volumesDeleted: true,
    });
    expect(await readFile(test.dockerLog, "utf8")).toContain(
      "down --remove-orphans --volumes",
    );
  });

  it("returns structured Docker, health, and reset results", async () => {
    const test = await fixture();
    await execute(
      process.execPath,
      [
        cliPath,
        "self-host",
        "up",
        "--api-port",
        String(test.apiPort),
        "--headless",
        "--json",
      ],
      { env: test.environment },
    );
    const status = await execute(
      process.execPath,
      [cliPath, "self-host", "status", "--json"],
      { env: test.environment },
    );
    expect(JSON.parse(status.stdout)).toMatchObject({
      initialized: true,
      docker: { installed: true, compose: true, daemon: true },
      stack: { headless: true, services: [] },
      health: { state: "ready", status: 200 },
    });

    const reset = await execute(
      process.execPath,
      [
        cliPath,
        "self-host",
        "reset-owner-password",
        "--email",
        "OWNER@EXAMPLE.COM",
        "--json",
      ],
      { env: test.environment },
    );
    expect(JSON.parse(reset.stdout)).toMatchObject({
      created: true,
      email: "owner@example.com",
      resetUrl: test.environment.FAKE_RESET_URL,
    });
    expect(await readFile(test.dockerLog, "utf8")).toContain(
      "exec -T api lore-reset-password --email owner@example.com",
    );

    const output = resolve(test.home, "secure", "reset-link.txt");
    const written = await execute(
      process.execPath,
      [
        cliPath,
        "self-host",
        "reset-owner-password",
        "--email",
        "owner@example.com",
        "--output",
        output,
        "--json",
      ],
      { env: test.environment },
    );
    expect(written.stdout).not.toContain("#token=");
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect((await readFile(output, "utf8")).trim()).toBe(
      test.environment.FAKE_RESET_URL,
    );
  });
});
