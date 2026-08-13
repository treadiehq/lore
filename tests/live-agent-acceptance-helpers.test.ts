import { describe, expect, it } from "vitest";
import {
  boundedInteger,
  buildClaudePrintArgs,
  buildCodexExecArgs,
  milliseconds,
  parseCodexThreadId,
  parseDevinCliResult,
  positiveNumberString,
} from "../scripts/live-agent-acceptance-helpers.js";

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
});

describe("live agent output parsers", () => {
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
});
