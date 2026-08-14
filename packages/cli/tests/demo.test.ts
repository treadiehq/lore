import { describe, expect, it } from "vitest";
import { isolateLoreClaudeHooks } from "../src/demo.js";

describe("Claude-to-Codex demo", () => {
  it("loads only Lore hooks into the isolated Claude fixture", () => {
    const loreHook = {
      type: "command",
      command:
        "'/usr/local/bin/node' '/Users/test/.lore/bin/lore-hook.mjs' --agent claude --owner lore",
      timeout: 25,
    };
    const unrelatedHook = {
      type: "command",
      command: "run-unrelated-hook",
    };

    expect(
      isolateLoreClaudeHooks({
        permissions: { allow: ["Read"] },
        hooks: {
          UserPromptSubmit: [
            { hooks: [unrelatedHook, loreHook], matcher: "all" },
          ],
          Stop: [{ hooks: [loreHook] }],
          SessionEnd: [{ hooks: [loreHook] }],
          Notification: [{ hooks: [unrelatedHook] }],
        },
      }),
    ).toEqual({
      hooks: {
        UserPromptSubmit: [{ hooks: [loreHook], matcher: "all" }],
        Stop: [{ hooks: [loreHook] }],
        SessionEnd: [{ hooks: [loreHook] }],
      },
    });
  });

  it("rejects an incomplete Lore hook installation", () => {
    expect(() =>
      isolateLoreClaudeHooks({
        hooks: {
          UserPromptSubmit: [],
          Stop: [],
          SessionEnd: [],
        },
      }),
    ).toThrow(/UserPromptSubmit hook is not installed/u);
  });
});
