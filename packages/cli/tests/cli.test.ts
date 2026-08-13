import { execFileSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  countLoreHooks,
  getLorePaths,
  mergeLoreHooks,
  removeLoreHooks,
} from "../src/cli.js";

const homes: string[] = [];

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

    execFileSync(
      process.execPath,
      [
        cli,
        "connect",
        "--url",
        "http://127.0.0.1:3004",
        "--token",
        "test-token",
        "--agent",
        "claude",
      ],
      { env: environment, encoding: "utf8" },
    );

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
