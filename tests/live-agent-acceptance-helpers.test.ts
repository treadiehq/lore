import { describe, expect, it } from "vitest";
import type { Learning } from "../packages/sdk/src/index.js";
import {
  assertOpenCodeCliCapabilities,
  assertRepositoryScoped,
  boundedInteger,
  buildClaudePrintArgs,
  buildCodexExecArgs,
  buildOpenCodeRunArgs,
  milliseconds,
  parseCodexThreadId,
  parseDevinCliResult,
  parseOpenCodeRunJsonl,
  positiveNumberString,
} from "../scripts/live-agent-acceptance-helpers.js";

const scopedLearning: Learning = {
  id: "11111111-1111-4111-8111-111111111111",
  content: "Use AccountStore.",
  scope: { organization: "acme", repo: "acme/accounts" },
  category: "correction",
  status: "active",
  source: { agent: "claude" },
  confidence: 1,
  confirmation: "explicit",
  fingerprint: "a".repeat(64),
  supersedesMemoryId: null,
  createdAt: "2026-08-18T12:00:00.000Z",
  updatedAt: "2026-08-18T12:00:00.000Z",
  suppressedAt: null,
  deletedAt: null,
};

describe("live agent session command builders", () => {
  it("builds persistent Claude start and resume commands without tools", () => {
    const started = buildClaudePrintArgs({
      sessionId: "11111111-1111-4111-8111-111111111111",
      persistSession: true,
      budgetUsd: "0.40",
      model: "haiku",
      prompt: "initial teaching",
    });
    const resumed = buildClaudePrintArgs({
      resumeSessionId: "11111111-1111-4111-8111-111111111111",
      persistSession: true,
      budgetUsd: "0.40",
      model: "haiku",
      prompt: "later correction",
    });

    expect(started).toEqual([
      "-p",
      "--session-id",
      "11111111-1111-4111-8111-111111111111",
      "--output-format",
      "text",
      "--max-budget-usd",
      "0.40",
      "--model",
      "haiku",
      "--tools",
      "",
      "--permission-mode",
      "dontAsk",
      "--no-chrome",
      "--disable-slash-commands",
      "initial teaching",
    ]);
    expect(resumed).toContain("--resume");
    expect(resumed).not.toContain("--session-id");
    expect(resumed).not.toContain("--no-session-persistence");
    expect(() =>
      buildClaudePrintArgs({
        sessionId: "start",
        resumeSessionId: "resume",
        budgetUsd: "0.40",
        model: "haiku",
        prompt: "invalid",
      }),
    ).toThrow("simultaneously");
  });

  it("builds persistent Codex start and explicit resume commands", () => {
    const started = buildCodexExecArgs({
      prompt: "initial teaching",
      outputPath: "/tmp/initial.txt",
      reasoningEffort: "low",
    });
    const resumed = buildCodexExecArgs({
      prompt: "later correction",
      outputPath: "/tmp/resumed.txt",
      reasoningEffort: "low",
      resumeThreadId: "thread-123",
    });

    expect(started.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(started).toContain("read-only");
    expect(started).not.toContain("--ephemeral");
    expect(resumed.slice(0, 3)).toEqual(["exec", "resume", "--json"]);
    expect(resumed).toEqual(
      expect.arrayContaining([
        'sandbox_mode="read-only"',
        "thread-123",
        "later correction",
      ]),
    );
    expect(() =>
      buildCodexExecArgs({
        prompt: "invalid",
        outputPath: "/tmp/invalid.txt",
        reasoningEffort: "low",
        resumeThreadId: "thread-123",
        ephemeral: true,
      }),
    ).toThrow("cannot be ephemeral");
  });

  it("builds machine-readable OpenCode start and resume commands", () => {
    expect(
      buildOpenCodeRunArgs({
        prompt: "initial teaching",
        model: "anthropic/claude-haiku",
        title: "Lore acceptance",
      }),
    ).toEqual([
      "run",
      "--format",
      "json",
      "--model",
      "anthropic/claude-haiku",
      "--title",
      "Lore acceptance",
      "initial teaching",
    ]);
    expect(
      buildOpenCodeRunArgs({
        prompt: "later correction",
        model: "anthropic/claude-haiku",
        sessionId: "ses_acceptance",
      }),
    ).toEqual([
      "run",
      "--format",
      "json",
      "--model",
      "anthropic/claude-haiku",
      "--session",
      "ses_acceptance",
      "later correction",
    ]);
    expect(() =>
      buildOpenCodeRunArgs({
        prompt: "invalid",
        model: "anthropic/claude-haiku",
        sessionId: "ses_acceptance",
        title: "Cannot retitle",
      }),
    ).toThrow("cannot set a new title");
    expect(() =>
      buildOpenCodeRunArgs({
        prompt: "invalid",
        model: "missing-provider",
      }),
    ).toThrow("provider/model");
  });
});

describe("live agent output parsers", () => {
  it("requires native acceptance learnings to keep repository scope", () => {
    expect(() =>
      assertRepositoryScoped(
        scopedLearning,
        "acme/accounts",
        "native capture",
      ),
    ).not.toThrow();
    expect(() =>
      assertRepositoryScoped(
        { ...scopedLearning, scope: { organization: "acme" } },
        "acme/accounts",
        "native capture",
      ),
    ).toThrow("repository scope");
  });

  it("parses bounded integer cost controls", () => {
    expect(boundedInteger({}, "MAX_ACU", 2, 1, 10)).toBe(2);
    expect(
      boundedInteger({ MAX_ACU: "4" }, "MAX_ACU", 2, 1, 10),
    ).toBe(4);
    expect(() =>
      boundedInteger({ MAX_ACU: "0" }, "MAX_ACU", 2, 1, 10),
    ).toThrow("integer from 1 to 10");
    expect(() =>
      boundedInteger({ MAX_ACU: "1.5" }, "MAX_ACU", 2, 1, 10),
    ).toThrow("integer from 1 to 10");
  });

  it("parses timeout and monetary caps deterministically", () => {
    expect(milliseconds({}, "TIMEOUT_MS", 5_000)).toBe(5_000);
    expect(milliseconds({ TIMEOUT_MS: "2500" }, "TIMEOUT_MS", 5_000)).toBe(
      2_500,
    );
    expect(() =>
      milliseconds({ TIMEOUT_MS: "999" }, "TIMEOUT_MS", 5_000),
    ).toThrow("at least 1000");
    expect(positiveNumberString({}, "BUDGET_USD", "0.50")).toBe("0.50");
    expect(
      positiveNumberString({ BUDGET_USD: "0.25" }, "BUDGET_USD", "0.50"),
    ).toBe("0.25");
    expect(() =>
      positiveNumberString({ BUDGET_USD: "0" }, "BUDGET_USD", "0.50"),
    ).toThrow("positive number");
  });

  it("extracts one stable Codex thread ID from JSONL", () => {
    const output = [
      '{"type":"thread.started","thread_id":"0198abcd-1234-7000-8000-abcdefabcdef"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
    ].join("\n");

    expect(parseCodexThreadId(output)).toBe(
      "0198abcd-1234-7000-8000-abcdefabcdef",
    );
    expect(() => parseCodexThreadId('{"type":"turn.started"}')).toThrow(
      "thread.started",
    );
    expect(() =>
      parseCodexThreadId(
        [
          '{"type":"thread.started","thread_id":"one"}',
          '{"type":"thread.started","thread_id":"two"}',
        ].join("\n"),
      ),
    ).toThrow("multiple thread IDs");
    expect(() => parseCodexThreadId("not-json")).toThrow("invalid JSON");
  });

  it("validates public Devin start and prompt JSON", () => {
    const base = {
      sessionId: "devin-session",
      loreContextInjected: true,
      lorePollingRegistered: true,
      loreDeliveryReceiptId: "receipt-id",
    };

    expect(parseDevinCliResult(JSON.stringify(base), "start")).toEqual(base);
    expect(
      parseDevinCliResult(JSON.stringify({ ...base, sent: true }), "prompt"),
    ).toEqual({ ...base, sent: true });
    expect(() =>
      parseDevinCliResult(JSON.stringify(base), "prompt"),
    ).toThrow("invalid result");
    expect(() => parseDevinCliResult("{", "start")).toThrow("invalid JSON");
  });

  it("parses one completed OpenCode JSONL session, text, and cost", () => {
    const output = [
      '{"type":"step_start","timestamp":1,"sessionID":"ses_acceptance","part":{"type":"step-start"}}',
      '{"type":"text","timestamp":2,"sessionID":"ses_acceptance","part":{"type":"text","text":"first line"}}',
      '{"type":"text","timestamp":3,"sessionID":"ses_acceptance","part":{"type":"text","text":"second line"}}',
      '{"type":"step_finish","timestamp":4,"sessionID":"ses_acceptance","part":{"type":"step-finish","cost":0.0125}}',
    ].join("\n");

    expect(parseOpenCodeRunJsonl(output)).toEqual({
      sessionId: "ses_acceptance",
      text: "first line\nsecond line",
      costUsd: 0.0125,
      completedSteps: 1,
    });
    expect(() => parseOpenCodeRunJsonl("not-json")).toThrow("invalid JSON");
    expect(() =>
      parseOpenCodeRunJsonl(
        [
          '{"type":"text","sessionID":"ses_one","part":{"type":"text","text":"one"}}',
          '{"type":"step_finish","sessionID":"ses_two","part":{"type":"step-finish","cost":0}}',
        ].join("\n"),
      ),
    ).toThrow("multiple session IDs");
    expect(() =>
      parseOpenCodeRunJsonl(
        '{"type":"text","sessionID":"ses_one","part":{"type":"text","text":"unfinished"}}',
      ),
    ).toThrow("completed step");
  });

  it("requires the OpenCode noninteractive and cleanup capabilities", () => {
    const supported = {
      rootHelp: "Commands:\n  opencode run [message..]",
      runHelp:
        "Options:\n  --format default|json\n  --session session id to continue",
      sessionDeleteHelp: "opencode session delete <sessionID>",
    };
    expect(() => assertOpenCodeCliCapabilities(supported)).not.toThrow();
    expect(() =>
      assertOpenCodeCliCapabilities({
        ...supported,
        runHelp: "Options:\n  --format default",
      }),
    ).toThrow("JSON event output");
    expect(() =>
      assertOpenCodeCliCapabilities({
        ...supported,
        sessionDeleteHelp: "opencode session list",
      }),
    ).toThrow("session cleanup");
  });
});
