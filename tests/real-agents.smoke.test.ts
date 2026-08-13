import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const runRealAgents = process.env.RUN_REAL_AGENT_TESTS === "1";

describe.skipIf(!runRealAgents)("credential-gated real agent smoke tests", () => {
  it("finds the installed Codex CLI", () => {
    expect(execFileSync("codex", ["--version"], { encoding: "utf8" })).toMatch(
      /codex/iu,
    );
  });

  it("finds the installed Claude Code CLI", () => {
    expect(execFileSync("claude", ["--version"], { encoding: "utf8" })).toMatch(
      /\d+\.\d+/u,
    );
  });

  it("authenticates to the configured Devin organization", async () => {
    const apiKey = process.env.DEVIN_API_KEY;
    const organization = process.env.DEVIN_ORG_ID;
    if (apiKey === undefined || organization === undefined) {
      throw new Error(
        "DEVIN_API_KEY and DEVIN_ORG_ID are required for real-agent smoke tests",
      );
    }
    const response = await fetch(
      `https://api.devin.ai/v3/organizations/${encodeURIComponent(organization)}/sessions?first=1`,
      {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    expect(response.status).toBe(200);
  });
});
