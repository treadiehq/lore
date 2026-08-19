import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildCleanupCommands,
  collectPreflightFailures,
  matchesReviewComment,
  parseConfiguration,
  parseNameLines,
  parseProviders,
  parseReviewMarker,
  type AcceptanceConfig,
  type PreflightSnapshot,
} from "../scripts/github-pr-live-acceptance.js";

function marker(input: {
  provider: "codex" | "devin";
  repository: string;
  prNumber: number;
  headSha: string;
}): string {
  const key = createHash("sha256")
    .update(
      `${input.provider}\0${input.repository}\0${input.prNumber}\0${input.headSha}`,
    )
    .digest("hex");
  return `<!-- lore-review:v2 key=${key} provider=${input.provider} head=${encodeURIComponent(input.headSha)} pr=${input.prNumber} -->`;
}

function config(): AcceptanceConfig {
  return parseConfiguration({
    LORE_API_URL: "https://lore.example.com/",
    LORE_WORKSPACE_TOKEN: "workspace-token",
    GITHUB_PR_LIVE_REPO: "acme/widgets",
    GITHUB_PR_LIVE_BASE_BRANCH: "main",
    GITHUB_PR_LIVE_PROVIDERS: "both",
  });
}

describe("GitHub live acceptance parsing", () => {
  it("parses providers and name-only command output deterministically", () => {
    expect(parseProviders("devin,codex,devin")).toEqual(["devin", "codex"]);
    expect(parseProviders("both")).toEqual(["codex", "devin"]);
    expect(() => parseProviders("claude")).toThrow(
      "GITHUB_PR_LIVE_PROVIDERS",
    );
    expect(parseNameLines(" B\nA\n\nA\r\n")).toEqual(["B", "A"]);
  });

  it("normalizes configuration without weakening the explicit live gate", () => {
    const parsed = config();

    expect(parsed.loreApiUrl).toBe("https://lore.example.com");
    expect(parsed.cliRepository).toBe("treadiehq/lore");
    expect(parsed.cliVersion).toBe("v0.1.4");
    expect(parsed.cleanup).toBe(true);
    expect(parsed.providers).toEqual(["codex", "devin"]);
  });
});

describe("GitHub review marker matching", () => {
  const identity = {
    provider: "codex" as const,
    repository: "acme/widgets",
    prNumber: 42,
    headSha: "abc123",
  };
  const body = `${marker(identity)}\nNo actionable defects.\n\n---\n<sub>Provenance: provider codex</sub>`;

  it("accepts only the exact provider, PR, head, repository, and bot author", () => {
    expect(parseReviewMarker(body, identity.repository)).toMatchObject({
      provider: identity.provider,
      prNumber: identity.prNumber,
      headSha: identity.headSha,
    });
    expect(
      matchesReviewComment(
        { body, user: { login: "github-actions[bot]" } },
        identity,
      ),
    ).toBe(true);
    expect(
      matchesReviewComment(
        { body, user: { login: "contributor" } },
        identity,
      ),
    ).toBe(false);
    expect(
      matchesReviewComment(
        { body, user: { login: "github-actions[bot]" } },
        { ...identity, headSha: "different" },
      ),
    ).toBe(false);
    expect(parseReviewMarker(body, "other/repository")).toBeUndefined();
  });

  it("rejects a marker whose integrity key was copied or changed", () => {
    const tampered = body.replace("head=abc123", "head=def456");

    expect(parseReviewMarker(tampered, identity.repository)).toBeUndefined();
  });
});

describe("GitHub live acceptance preflight", () => {
  it("reports all missing target setup without proposing implicit mutation", () => {
    const snapshot: PreflightSnapshot = {
      actor: "maintainer",
      repository: {
        fork: false,
        canPush: true,
        defaultBranch: "main",
      },
      baseBranchExists: true,
      workflows: [],
      labels: [],
      secrets: [],
      variables: [],
      loreHealthReachable: true,
      binaryReleaseUsable: true,
      errors: [],
    };

    const failures = collectPreflightFailures(config(), snapshot);

    expect(failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Lore Codex review"),
        expect.stringContaining("Lore Devin review"),
        expect.stringContaining("Lore review correction"),
        expect.stringContaining("lore:codex-review"),
        expect.stringContaining("lore:devin-review"),
        expect.stringContaining("LORE_WORKSPACE_TOKEN"),
        expect.stringContaining("OPENAI_API_KEY"),
        expect.stringContaining("DEVIN_API_KEY"),
        expect.stringContaining("LORE_API_URL"),
        expect.stringContaining("LORE_CLI_VERSION"),
        expect.stringContaining("DEVIN_ORG_ID"),
      ]),
    );
  });

  it("accepts exact workflows, labels, and credential names", () => {
    const snapshot: PreflightSnapshot = {
      actor: "maintainer",
      repository: {
        fork: false,
        canPush: true,
        defaultBranch: "main",
      },
      baseBranchExists: true,
      workflows: [
        {
          name: "Lore Codex review",
          path: ".github/workflows/lore-codex-review.yml",
        },
        {
          name: "Lore Devin review",
          path: ".github/workflows/lore-devin-review.yml",
        },
        {
          name: "Lore review correction",
          path: ".github/workflows/lore-observe-correction.yml",
        },
      ],
      labels: ["lore:codex-review", "lore:devin-review"],
      secrets: ["LORE_WORKSPACE_TOKEN", "OPENAI_API_KEY", "DEVIN_API_KEY"],
      variables: ["LORE_API_URL", "LORE_CLI_VERSION", "DEVIN_ORG_ID"],
      loreHealthReachable: true,
      binaryReleaseUsable: true,
      errors: [],
    };

    expect(collectPreflightFailures(config(), snapshot)).toEqual([]);
  });
});

describe("GitHub live acceptance cleanup", () => {
  it("constructs non-interactive, argument-safe cleanup commands", () => {
    const commands = buildCleanupCommands({
      repository: "acme/widgets",
      branch: "lore-live-123",
      prNumber: 42,
      labels: ["lore:codex-review", "lore:codex-review"],
      commentIds: [100, 101, 100],
    });

    expect(commands).toEqual([
      {
        executable: "gh",
        args: [
          "api",
          "--method",
          "DELETE",
          "repos/acme/widgets/issues/comments/100",
        ],
      },
      {
        executable: "gh",
        args: [
          "api",
          "--method",
          "DELETE",
          "repos/acme/widgets/issues/comments/101",
        ],
      },
      {
        executable: "gh",
        args: [
          "api",
          "--method",
          "DELETE",
          "repos/acme/widgets/issues/42/labels/lore%3Acodex-review",
        ],
      },
      {
        executable: "gh",
        args: [
          "api",
          "--method",
          "PATCH",
          "repos/acme/widgets/pulls/42",
          "-f",
          "state=closed",
        ],
      },
      {
        executable: "gh",
        args: [
          "api",
          "--method",
          "DELETE",
          "repos/acme/widgets/git/refs/heads/lore-live-123",
        ],
      },
    ]);
    expect(commands.every(({ args }) => !args.includes("--prompt"))).toBe(true);
  });
});
