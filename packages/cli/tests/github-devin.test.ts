import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectGithub,
  reviewEventKey,
  runDevinCommand,
  runGithubCommand,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.DEVIN_API_KEY;
  delete process.env.DEVIN_ORG_ID;
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
  const directory = await mkdtemp(resolve(parent, "lore-github-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("GitHub connector", () => {
  it("installs all trusted workflow templates", async () => {
    const root = await temporaryDirectory();

    await connectGithub(["--repo-root", root]);

    await expect(
      readFile(
        resolve(root, ".github/workflows/lore-codex-review.yml"),
        "utf8",
      ),
    ).resolves.toContain("openai/codex-action@52fe01ec");
    await expect(
      readFile(
        resolve(root, ".github/workflows/lore-devin-review.yml"),
        "utf8",
      ),
    ).resolves.toContain("devin run-review");
    await expect(
      readFile(
        resolve(root, ".github/workflows/lore-observe-correction.yml"),
        "utf8",
      ),
    ).resolves.toContain("/lore correct");
  });

  it("creates a stable review event identity", () => {
    const metadata = {
      provider: "codex" as const,
      repository: "acme/api",
      owner: "acme",
      repo: "api",
      prNumber: 42,
      prUrl: "https://github.com/acme/api/pull/42",
      headSha: "abc123",
      marker: "<!-- lore-review:v1 -->",
    };

    expect(reviewEventKey(metadata)).toBe(reviewEventKey(metadata));
    expect(reviewEventKey({ ...metadata, headSha: "def456" })).not.toBe(
      reviewEventKey(metadata),
    );
  });

  it("prepares a bounded review prompt with dynamic Lore context", async () => {
    const root = await temporaryDirectory();
    execFileSync("git", ["init", "-q", "--template="], { cwd: root });
    execFileSync("git", ["config", "user.email", "lore@example.com"], {
      cwd: root,
    });
    execFileSync("git", ["config", "user.name", "Lore Test"], { cwd: root });
    await writeFile(resolve(root, "file.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    await writeFile(resolve(root, "file.ts"), "export const value = 2;\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "change"], { cwd: root });
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const eventPath = resolve(root, "event.json");
    const promptPath = resolve(root, ".lore", "prompt.md");
    const metadataPath = resolve(root, ".lore", "metadata.json");
    const schemaPath = resolve(root, ".lore", "schema.json");
    await writeFile(
      eventPath,
      JSON.stringify({
        repository: { full_name: "acme/api" },
        pull_request: {
          number: 42,
          title: "Change value",
          body: "Updates behavior.",
          html_url: "https://github.com/acme/api/pull/42",
          draft: false,
          base: { sha: baseSha },
          head: { sha: headSha, repo: { full_name: "acme/api" } },
        },
      }),
    );
    process.env.LORE_API_URL = "https://lore.example.com";
    process.env.LORE_WORKSPACE_TOKEN = "test-workspace-token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            context: "Account handlers must use AccountStore.",
            memories: [],
            packing: { contextSha256: "a".repeat(64) },
            receipt: {
              id: "11111111-1111-4111-8111-111111111111",
              deliveredAt: "2026-08-12T00:00:00.000Z",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await runGithubCommand([
      "prepare-review",
      "--provider",
      "codex",
      "--event",
      eventPath,
      "--checkout",
      root,
      "--prompt-out",
      promptPath,
      "--metadata-out",
      metadataPath,
      "--schema-out",
      schemaPath,
    ]);

    await expect(readFile(promptPath, "utf8")).resolves.toContain(
      "Account handlers must use AccountStore.",
    );
    await expect(readFile(metadataPath, "utf8")).resolves.toContain(headSha);
    await expect(readFile(schemaPath, "utf8")).resolves.toContain(
      '"findings"',
    );
  });

  it("accepts only an authorized correction to a marked Lore comment", async () => {
    const root = await temporaryDirectory();
    const eventPath = resolve(root, "event.json");
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
            "No, RepositoryFactory is deprecated. Use AccountStore instead.",
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
              "<!-- lore-review:v1 provider=devin session=devin-1 head=abc123 pr=42 -->",
              "RepositoryFactory is safe to use.",
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
    expect(turnBody?.scope).toEqual({ repo: "acme/api" });
    expect(turnBody?.learningScope).toEqual({});
    expect(JSON.stringify(turnBody)).toContain("Use AccountStore instead");
  });
});

describe("Devin review connector", () => {
  it("writes structured output from a completed normal session", async () => {
    const root = await temporaryDirectory();
    const prompt = resolve(root, "prompt.md");
    const metadata = resolve(root, "metadata.json");
    const output = resolve(root, "output.json");
    await Promise.all([
      writeFile(prompt, "Review this pull request.", "utf8"),
      writeFile(
        metadata,
        JSON.stringify({
          provider: "devin",
          repository: "acme/api",
          owner: "acme",
          repo: "api",
          prNumber: 42,
          prUrl: "https://github.com/acme/api/pull/42",
          headSha: "abc123",
          marker: "pending",
        }),
        "utf8",
      ),
    ]);
    process.env.DEVIN_API_KEY = "cog_test";
    process.env.DEVIN_ORG_ID = "org-test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            session_id: "devin-test",
            url: "https://app.devin.ai/sessions/devin-test",
            status: "exit",
            status_detail: "finished",
            structured_output: { summary: "Clean", findings: [] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await runDevinCommand([
      "run-review",
      "--prompt",
      prompt,
      "--metadata",
      metadata,
      "--output",
      output,
    ]);

    await expect(readFile(output, "utf8")).resolves.toContain('"summary": "Clean"');
    await expect(readFile(metadata, "utf8")).resolves.toContain(
      '"sessionId": "devin-test"',
    );
  });

  it("archives the session when persisting its metadata fails", async () => {
    const root = await temporaryDirectory();
    const prompt = resolve(root, "prompt.md");
    const metadata = resolve(root, "metadata.json");
    const output = resolve(root, "output.json");
    await Promise.all([
      writeFile(prompt, "Review this pull request.", "utf8"),
      writeFile(
        metadata,
        JSON.stringify({
          provider: "devin",
          repository: "acme/api",
          owner: "acme",
          repo: "api",
          prNumber: 42,
          prUrl: "https://github.com/acme/api/pull/42",
          headSha: "abc123",
          marker: "pending",
        }),
        "utf8",
      ),
    ]);
    process.env.DEVIN_API_KEY = "cog_test";
    process.env.DEVIN_ORG_ID = "org-test";
    const methods: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        methods.push(init?.method ?? "GET");
        if (init?.method === "POST") {
          await rm(root, { recursive: true, force: true });
          return Response.json({
            session_id: "devin-test",
            url: "https://app.devin.ai/sessions/devin-test",
            status: "running",
          });
        }
        return new Response(null, { status: 204 });
      }),
    );

    await expect(
      runDevinCommand([
        "run-review",
        "--prompt",
        prompt,
        "--metadata",
        metadata,
        "--output",
        output,
      ]),
    ).rejects.toThrow(/ENOENT/u);

    expect(methods).toEqual(["POST", "DELETE"]);
  });
});
