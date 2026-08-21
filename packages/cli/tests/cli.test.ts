import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  LORE_OPENCODE_PLUGIN,
  countLoreOpenCodePlugins,
  countLoreHooks,
  getLorePaths,
  mergeLoreHooks,
  mergeLoreOpenCodePlugin,
  removeLoreOpenCodePlugin,
  removeLoreHooks,
} from "../src/cli.js";

const homes: string[] = [];
const execute = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map(async (home) =>
      rm(home, { recursive: true, force: true }),
    ),
  );
});

describe("native hook configuration", () => {
  const paths = getLorePaths("/tmp/lore-test-home");

  it("preserves unrelated settings and is idempotent", () => {
    const original = {
      theme: "dark",
      hooks: {
        UserPromptSubmit: [
          {
            matcher: "existing",
            hooks: [
              {
                type: "command",
                command: "/usr/local/bin/existing-hook",
              },
            ],
          },
        ],
      },
    };

    const once = mergeLoreHooks(original, "codex", paths);
    const twice = mergeLoreHooks(once, "codex", paths);

    expect(twice).toEqual(once);
    expect(countLoreHooks(twice)).toBe(3);
    expect(twice.theme).toBe("dark");
    expect(JSON.stringify(twice)).toContain("/usr/local/bin/existing-hook");
    expect(original).not.toEqual(once);
  });

  it("disconnect removes Lore handlers only", () => {
    const original = {
      permissions: { allow: ["Bash(git status)"] },
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "other stop hook" },
            ],
          },
        ],
      },
    };
    const connected = mergeLoreHooks(original, "claude", paths);

    expect(removeLoreHooks(connected)).toEqual(original);
    expect(countLoreHooks(removeLoreHooks(connected))).toBe(0);
  });

  it("updates stale Lore-owned handlers without duplicates", () => {
    const stale = {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command:
                  "'/old/node' '/old/.lore/bin/lore-hook.mjs' --agent codex --owner lore",
              },
              { type: "command", command: "keep-me" },
            ],
          },
        ],
      },
    };

    const merged = mergeLoreHooks(stale, "codex", paths);

    expect(countLoreHooks(merged)).toBe(3);
    expect(JSON.stringify(merged)).toContain("keep-me");
    expect(JSON.stringify(merged)).not.toContain("/old/node");
  });

  it("refuses malformed hook fields instead of overwriting them", () => {
    expect(() =>
      mergeLoreHooks({ hooks: "not-an-object" }, "codex", paths),
    ).toThrow("must be a JSON object");
    expect(() =>
      mergeLoreHooks(
        { hooks: { UserPromptSubmit: "not-an-array" } },
        "codex",
        paths,
      ),
    ).toThrow("must be a JSON array");
  });

  it("installs a runnable hook with its local dependencies", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "lore-install-"));
    homes.push(home);
    const cli = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "dist",
      "cli.js",
    );
    const environment = { ...process.env, HOME: home };
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          request.url === "/v1/workspace/identity"
            ? {
                workspaceId: "22222222-2222-4222-8222-222222222222",
                workspaceName: "Test",
                organization: "test",
                credentialType: "workspace_token",
                server: { version: "0.1.5", revision: null },
              }
            : { status: "ok", check: "readiness" },
        ),
      );
    });
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a local test server");
    }

    try {
      await execute(
        process.execPath,
        [
          cli,
          "connect",
          "--url",
          `http://127.0.0.1:${address.port}`,
          "--token",
          "test-token",
          "--agent",
          "claude",
        ],
        { env: environment, encoding: "utf8" },
      );
    } finally {
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolveClose();
          } else {
            reject(error);
          }
        });
      });
    }

    const installed = getLorePaths(home);
    await expect(access(installed.runtimeRepository)).resolves.toBeUndefined();
    await expect(access(installed.runtimePackage)).resolves.toBeUndefined();
    expect(() =>
      execFileSync(
        process.execPath,
        [installed.runtime, "--agent", "claude", "--owner", "lore"],
        {
          env: environment,
          encoding: "utf8",
          input: `${JSON.stringify({
            session_id: "install-test",
            hook_event_name: "SessionEnd",
          })}\n`,
        },
      ),
    ).not.toThrow();
  });
});

describe("OpenCode plugin configuration", () => {
  it("preserves unrelated keys and plugins while reconnecting idempotently", () => {
    const original = {
      $schema: "https://opencode.ai/config.json",
      theme: "system",
      plugin: ["opencode-example-plugin", { local: "./plugin.ts" }],
    };

    const once = mergeLoreOpenCodePlugin(original);
    const twice = mergeLoreOpenCodePlugin(once);

    expect(twice).toEqual(once);
    expect(once).toEqual({
      ...original,
      plugin: [...original.plugin, LORE_OPENCODE_PLUGIN],
    });
    expect(countLoreOpenCodePlugins(twice)).toBe(1);
    expect(original.plugin).toHaveLength(2);
  });

  it("replaces stale Lore entries and disconnects only Lore", () => {
    const original = {
      keybinds: { leader: "ctrl+x" },
      plugin: ["keep-me", "@lore-co/opencode-plugin@0.1.2"],
    };

    const connected = mergeLoreOpenCodePlugin(original);

    expect(connected.plugin).toEqual(["keep-me", LORE_OPENCODE_PLUGIN]);
    expect(removeLoreOpenCodePlugin(connected)).toEqual({
      keybinds: original.keybinds,
      plugin: ["keep-me"],
    });
  });

  it("refuses a malformed plugin field", () => {
    expect(() =>
      mergeLoreOpenCodePlugin({ plugin: "@lore-co/opencode-plugin" }),
    ).toThrow("must be a JSON array");
  });
});
