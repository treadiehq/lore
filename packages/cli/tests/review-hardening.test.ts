import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseReviewOutput,
  REVIEW_OUTPUT_SCHEMA,
  reviewEventKey,
  reviewMarker,
  runGithubCommand,
  type ReviewIdentity,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.GH_TOKEN;
  delete process.env.LORE_API_URL;
  delete process.env.LORE_WORKSPACE_TOKEN;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory(): Promise<string> {
  const parent = resolve(process.cwd(), ".tmp");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, "lore-review-hardening-"));
  temporaryDirectories.push(directory);
  return directory;
}

function reviewMetadata(sessionId = "devin-session-1", headSha = "abc123") {
  return {
    provider: "devin" as const,
    repository: "acme/api",
    owner: "acme",
    repo: "api",
    prNumber: 42,
    prUrl: "https://github.com/acme/api/pull/42",
    headSha,
    marker: `<!-- lore-review:v1 provider=devin session=${sessionId} head=${headSha} pr=42 -->`,
    sessionId,
  };
}

async function writePostInputs(raw: string): Promise<{
  metadataPath: string;
  outputPath: string;
}> {
  const root = await temporaryDirectory();
  const metadataPath = resolve(root, "metadata.json");
  const outputPath = resolve(root, "output.json");
  await Promise.all([
    writeFile(metadataPath, JSON.stringify(reviewMetadata()), "utf8"),
    writeFile(outputPath, raw, "utf8"),
  ]);
  return { metadataPath, outputPath };
}

function postArgs(metadataPath: string, outputPath: string): string[] {
  return [
    "post-review",
    "--metadata",
    metadataPath,
    "--output",
    outputPath,
  ];
}

describe("review identity hardening", () => {
  it("keeps v2 markers stable across Devin sessions and distinct per head", () => {
    const identity: ReviewIdentity = {
      provider: "devin",
      repository: "acme/api",
      prNumber: 42,
      headSha: "abc123",
    };
    const first = { ...identity, sessionId: "devin-session-1" };
    const second = { ...identity, sessionId: "devin-session-2" };

    expect(reviewMarker(first)).toBe(reviewMarker(second));
    expect(reviewMarker(first)).toContain(reviewEventKey(identity));
    expect(reviewMarker(first)).toContain("lore-review:v2");
    expect(reviewMarker(first)).not.toContain("devin-session");
    expect(reviewMarker({ ...identity, headSha: "def456" })).not.toBe(
      reviewMarker(first),
    );
  });

  it("updates a bot review on page two and ignores a copied user marker", async () => {
    const { metadataPath, outputPath } = await writePostInputs(
      JSON.stringify({ summary: "No actionable defects.", findings: [] }),
    );
    const marker = reviewMarker(reviewMetadata());
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    process.env.GH_TOKEN = "github-test-token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        requests.push({
          url,
          method,
          ...(typeof init?.body === "string" ? { body: init.body } : {}),
        });
        if (url.endsWith("comments?per_page=100&page=1")) {
          return Response.json(
            Array.from({ length: 100 }, (_, index) =>
              index === 0
                ? {
                    id: 100,
                    body: `I copied this: ${marker}`,
                    user: { login: "contributor" },
                  }
                : {
                    id: 100 + index,
                    body: "Unrelated comment",
                    user: { login: "contributor" },
                  },
            ),
          );
        }
        if (url.endsWith("comments?per_page=100&page=2")) {
          return Response.json([
            {
              id: 222,
              body: marker,
              user: { login: "github-actions[bot]" },
            },
          ]);
        }
        if (url.endsWith("/issues/comments/222") && method === "PATCH") {
          return Response.json({ id: 222 });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    await runGithubCommand(postArgs(metadataPath, outputPath));

    expect(
      requests
        .filter((request) => request.method === "GET")
        .map((request) => request.url),
    ).toEqual([
      "https://api.github.com/repos/acme/api/issues/42/comments?per_page=100&page=1",
      "https://api.github.com/repos/acme/api/issues/42/comments?per_page=100&page=2",
    ]);
    expect(
      requests.some(
        (request) =>
          request.method === "PATCH" &&
          request.url.endsWith("/issues/comments/222"),
      ),
    ).toBe(true);
    expect(requests.some((request) => request.method === "POST")).toBe(false);
  });
});

describe("strict review output", () => {
  it.each([
    ["blank output", "", "Review output is blank"],
    ["malformed JSON", "{", "Review output must be valid JSON"],
    [
      "fallback prose",
      "No actionable findings.",
      "Review output must be valid JSON",
    ],
    [
      "missing summary",
      JSON.stringify({ findings: [] }),
      "does not match the required schema",
    ],
    [
      "blank summary",
      JSON.stringify({ summary: "  ", findings: [] }),
      "does not match the required schema",
    ],
    [
      "additional properties",
      JSON.stringify({ summary: "Clean.", findings: [], fallback: true }),
      "does not match the required schema",
    ],
  ])("rejects %s before calling GitHub", async (_name, raw, error) => {
    const { metadataPath, outputPath } = await writePostInputs(raw);
    process.env.GH_TOKEN = "github-test-token";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      runGithubCommand(postArgs(metadataPath, outputPath)),
    ).rejects.toThrow(error);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a missing output file before calling GitHub", async () => {
    const { metadataPath, outputPath } = await writePostInputs("{}");
    await rm(outputPath);
    process.env.GH_TOKEN = "github-test-token";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      runGithubCommand(postArgs(metadataPath, outputPath)),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts explicit valid output with empty findings", async () => {
    const output = { summary: "No actionable defects.", findings: [] };
    const { metadataPath, outputPath } = await writePostInputs(
      JSON.stringify(output),
    );
    let postedBody = "";
    process.env.GH_TOKEN = "github-test-token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("comments?per_page=100&page=1")) {
          return Response.json([]);
        }
        if (init?.method === "POST") {
          postedBody = JSON.parse(String(init.body)).body as string;
          return Response.json({ id: 123 });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    expect(parseReviewOutput(JSON.stringify(output))).toEqual(output);
    await runGithubCommand(postArgs(metadataPath, outputPath));

    expect(postedBody).toContain("No actionable defects.");
    expect(postedBody).toContain("lore-review:v2");
    expect(postedBody).toContain("Provenance:");
    expect(postedBody).toContain("session `devin-session-1`");
  });

  it("keeps the runtime and workflow JSON schemas aligned", async () => {
    const schemaPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "templates",
      "github",
      "review-output.schema.json",
    );
    const schema = JSON.parse(await readFile(schemaPath, "utf8")) as Record<
      string,
      unknown
    >;
    delete schema.$schema;

    expect(schema).toEqual(REVIEW_OUTPUT_SCHEMA);
  });
});

describe("review correction compatibility", () => {
  it("recognizes a current v2 marker with separate session provenance", async () => {
    const root = await temporaryDirectory();
    const eventPath = resolve(root, "event.json");
    const identity: ReviewIdentity = {
      provider: "devin",
      repository: "acme/api",
      prNumber: 42,
      headSha: "abc123",
    };
    await writeFile(
      eventPath,
      JSON.stringify({
        repository: { full_name: "acme/api" },
        issue: { number: 42, pull_request: {} },
        sender: { login: "maintainer" },
        comment: {
          id: 222,
          created_at: "2026-08-12T20:00:00.000Z",
          body: [
            "/lore correct https://github.com/acme/api/pull/42#issuecomment-111",
            "",
            "Use AccountStore instead.",
          ].join("\n"),
        },
      }),
    );
    process.env.GH_TOKEN = "github-test-token";
    process.env.LORE_API_URL = "https://lore.example.com";
    process.env.LORE_WORKSPACE_TOKEN = "workspace-test-token";
    let turnBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/collaborators/maintainer/permission")) {
          return Response.json({ permission: "write" });
        }
        if (url.includes("/issues/comments/111")) {
          return Response.json({
            id: 111,
            user: { login: "github-actions[bot]" },
            body: [
              reviewMarker(identity),
              "<!-- lore-review-provenance:v1 session=devin-session-1 -->",
              "Review body.",
            ].join("\n"),
          });
        }
        if (url === "https://lore.example.com/v1/turns") {
          turnBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json({ ok: true });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    await runGithubCommand([
      "observe-correction",
      "--event",
      eventPath,
    ]);

    expect(turnBody?.agent).toBe("devin");
    expect(turnBody?.sessionId).toBe("devin-session-1");
    expect(turnBody?.metadata).toEqual({ prNumber: 42, headSha: "abc123" });
    expect(turnBody).not.toHaveProperty("idempotencyKey");
  });
});

describe("Devin review workflow hardening", () => {
  it("serializes by repository and PR and always cleans up known sessions", async () => {
    const workflowPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "templates",
      "github",
      "lore-devin-review.yml",
    );
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("concurrency:");
    expect(workflow).toContain(
      "lore-devin-review-${{ github.repository }}-${{ github.event.pull_request.number }}",
    );
    expect(workflow).toContain("cancel-in-progress: true");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain(".sessionId // empty");
    expect(workflow).toContain("devin terminate --session \"$SESSION_ID\"");
    expect(workflow).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("pull-requests: write");
    expect(workflow).not.toContain("issues: write");
  });
});

describe("customer workflow binary configuration", () => {
  it.each([
    ["lore-codex-review.yml", 2],
    ["lore-devin-review.yml", 1],
    ["lore-observe-correction.yml", 1],
  ])(
    "uses a pinned, configurable binary and initializes every job in %s",
    async (file, jobCount) => {
      const workflowPath = resolve(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "templates",
        "github",
        file,
      );
      const workflow = await readFile(workflowPath, "utf8");

      expect(workflow).toContain(
        "LORE_CLI_REPOSITORY: ${{ vars.LORE_CLI_REPOSITORY || 'treadiehq/lore' }}",
      );
      expect(workflow).toContain(
        "LORE_CLI_VERSION: ${{ vars.LORE_CLI_VERSION || 'v0.1.2' }}",
      );
      expect(workflow).toContain("scripts/install.sh");
      expect(workflow).toContain("lore ");
      expect(workflow).toContain("run-name:");
      expect(workflow).not.toContain("LORE_CLI_PACKAGE");
      expect(workflow).not.toContain("npx");
      expect(workflow.match(/uses: actions\/checkout@v5/gu)).toHaveLength(
        jobCount,
      );
      expect(workflow.match(/name: Install Lore CLI/gu)).toHaveLength(
        jobCount,
      );
      expect(workflow).not.toContain("actions/setup-node");
    },
  );
});
