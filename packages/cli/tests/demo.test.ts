import { describe, expect, it } from "vitest";
import { DEMO_SCENARIO, isolateLoreClaudeHooks } from "../src/demo.js";

describe("Claude-to-Codex demo", () => {
  it("uses the same natural language a customer would use", () => {
    expect(DEMO_SCENARIO).toEqual({
      greeting: "Hello from Lore",
      correction:
        'No. For src/greeting.ts specifically, set the greeting constant to exactly "Hello from Lore", never "legacy-greeting". Remember that rule for this file.',
      relevantPrompt:
        "Update src/greeting.ts so the greeting constant follows our repository rule. Make the edit and briefly confirm.",
      irrelevantPrompt:
        "Inspect only src/unrelated.ts and tell me the exported boolean. Do not modify files.",
    });
    expect(JSON.stringify(DEMO_SCENARIO)).not.toMatch(/\bLORE_[A-Z0-9_-]+\b/u);
  });

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
