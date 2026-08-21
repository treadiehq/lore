import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleHookEvent, redactSecrets } from "../src/runtime.js";

const homes: string[] = [];

async function configuredHome(): Promise<string> {
  const home = await mkdtemp(resolve(tmpdir(), "lore-cli-"));
  homes.push(home);
  await mkdir(resolve(home, ".lore"), { recursive: true });
  await writeFile(
    resolve(home, ".lore", "config.json"),
    JSON.stringify({
      version: 1,
      apiUrl: "https://lore.example.test",
      token: "workspace-token",
      agents: ["codex", "claude"],
      timeoutMs: 500,
    }),
    { mode: 0o600 },
  );
  return home;
}

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map(async (home) =>
      rm(home, { recursive: true, force: true }),
    ),
  );
});

describe("native hook runtime", () => {
  it("captures and enriches the first prompt without prior assistant state", async () => {
    const home = await configuredHome();
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as unknown,
      });
      if (String(url).endsWith("/v1/observations")) {
        return Response.json({
          event: {},
          replayed: false,
          memories: [],
          created: 0,
          duplicates: 0,
          reconciled: 0,
          superseded: 0,
        });
      }
      return Response.json({
        context: "Use the workspace-wide rule.",
      });
    });

    const output = await handleHookEvent(
      {
        session_id: "fresh-session",
        hook_event_name: "UserPromptSubmit",
        prompt_id: "prompt-1",
        cwd: "/work/project",
        prompt: "Always use AccountStore for accounts.",
      },
      "claude",
      {
        home,
        fetch: fetchMock as typeof fetch,
        now: () => new Date("2026-08-12T20:00:00.000Z"),
      },
    );

    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "Use the workspace-wide rule.",
      },
    });
    expect(requests.map(({ url }) => url)).toEqual([
      "https://lore.example.test/v1/observations",
      "https://lore.example.test/v1/context/deliveries",
    ]);
    expect(requests[0]?.body).toMatchObject({
      connector: "lore-cli",
      eventId: expect.any(String),
      agent: "claude",
      sessionId: "fresh-session",
      scope: { repo: "project" },
      learningScope: { repo: "project" },
      task: "Always use AccountStore for accounts.",
      messages: [
        {
          role: "user",
          content: "Always use AccountStore for accounts.",
          id: "prompt-1",
        },
      ],
      occurredAt: "2026-08-12T20:00:00.000Z",
    });
    expect(requests[1]?.body).toMatchObject({
      connector: "lore-cli",
      eventId: expect.any(String),
      sessionId: "fresh-session",
      task: {
        agent: "claude",
        task: "Always use AccountStore for accounts.",
        scope: { repo: "project" },
      },
    });
    expect(
      (requests[1]?.body as { eventId?: string }).eventId,
    ).not.toBe((requests[0]?.body as { eventId?: string }).eventId);
  });

  it("keeps rename-aware file evidence out of repository learning scope", async () => {
    const home = await configuredHome();
    const repository = await mkdtemp(resolve(tmpdir(), "lore-runtime-repo-"));
    homes.push(repository);
    await mkdir(resolve(repository, "src"), { recursive: true });
    await writeFile(resolve(repository, "src", "old.ts"), "export const value = 1;\n");
    execFileSync("git", ["init", "-q", "--template="], { cwd: repository });
    execFileSync("git", ["config", "user.email", "lore@example.invalid"], {
      cwd: repository,
    });
    execFileSync("git", ["config", "user.name", "Lore Test"], {
      cwd: repository,
    });
    execFileSync("git", ["add", "."], { cwd: repository });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repository });
    execFileSync("git", ["mv", "src/old.ts", "src/new.ts"], {
      cwd: repository,
    });

    const requests: unknown[] = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as unknown);
      return String(url).endsWith("/v1/observations")
        ? Response.json({
            event: {},
            replayed: false,
            memories: [],
            created: 0,
            duplicates: 0,
            reconciled: 0,
            superseded: 0,
          })
        : Response.json({ context: "", hits: [] });
    });

    await handleHookEvent(
      {
        session_id: "renamed-session",
        hook_event_name: "UserPromptSubmit",
        cwd: resolve(repository, "src"),
        prompt: "Use the new file convention.",
      },
      "claude",
      { home, fetch: fetchMock as typeof fetch },
    );

    expect(requests[0]).toMatchObject({
      scope: {
        repo: expect.stringMatching(/^lore-runtime-repo-/u),
        path: "src",
      },
      learningScope: {
        repo: expect.stringMatching(/^lore-runtime-repo-/u),
      },
      files: ["src/new.ts"],
      diff: expect.stringContaining("rename from src/old.ts"),
    });
    expect(requests[1]).toMatchObject({
      task: {
        files: ["src/new.ts"],
        diff: expect.stringContaining("rename to src/new.ts"),
      },
    });
  });

  it("shows an exact receipt link for non-empty injection and stays silent otherwise", async () => {
    const home = await configuredHome();
    const configPath = resolve(home, ".lore", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      configPath,
      JSON.stringify({
        ...config,
        dashboardUrl: "https://app.lore.example.test",
      }),
    );
    const memory = {
      id: "33333333-3333-4333-8333-333333333333",
      content: "Account writes must use AccountStore.",
    };
    let deliveryCount = 0;
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/v1/observations")) {
        return Response.json({
          event: {},
          replayed: false,
          memories: [],
          created: 0,
          duplicates: 0,
        });
      }
      deliveryCount += 1;
      return deliveryCount === 1
        ? Response.json({
            context: "Use AccountStore.",
            hits: [{ memory, reasons: ["repository", "lexical"] }],
            receipt: {
              id: "55555555-5555-4555-8555-555555555555",
            },
          })
        : Response.json({ context: "", hits: [], receipt: { id: "empty" } });
    });

    const injected = await handleHookEvent(
      {
        session_id: "receipt-session",
        hook_event_name: "UserPromptSubmit",
        cwd: "/work/project",
        prompt: "Update account writes with AccountStore.",
      },
      "codex",
      { home, fetch: fetchMock as typeof fetch },
    );
    expect(injected?.systemMessage).toContain(
      "Lore taught Codex: Account writes must use AccountStore.",
    );
    expect(injected?.systemMessage).toContain("Why: repository, lexical");
    expect(injected?.systemMessage).toContain(
      "https://app.lore.example.test/receipts/55555555-5555-4555-8555-555555555555",
    );

    const silent = await handleHookEvent(
      {
        session_id: "silent-session",
        hook_event_name: "UserPromptSubmit",
        cwd: "/work/project",
        prompt: "Unrelated task.",
      },
      "codex",
      { home, fetch: fetchMock as typeof fetch },
    );
    expect(silent).toBeUndefined();
  });

  it("labels governed captures as proposed until activation", async () => {
    const home = await configuredHome();
    const configPath = resolve(home, ".lore", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      configPath,
      JSON.stringify({
        ...config,
        dashboardUrl: "https://app.lore.example.test",
      }),
    );
    await handleHookEvent(
      {
        session_id: "proposal-session",
        hook_event_name: "Stop",
        last_assistant_message: "Use the old store.",
      },
      "codex",
      { home },
    );
    const output = await handleHookEvent(
      {
        session_id: "proposal-session",
        hook_event_name: "UserPromptSubmit",
        prompt: "No, use AccountStore instead.",
      },
      "codex",
      {
        home,
        fetch: vi.fn(async () =>
          Response.json({
            observation: {
              memories: [
                {
                  id: "33333333-3333-4333-8333-333333333333",
                  content: "Use AccountStore instead.",
                  status: "proposed",
                },
              ],
            },
            context: { text: "", memories: [], hits: [] },
          }),
        ) as typeof fetch,
      },
    );

    expect(output?.systemMessage).toContain(
      "Lore proposed: Use AccountStore instead.",
    );
    expect(output?.systemMessage).toContain(
      "Review proposal: https://app.lore.example.test/memories/33333333-3333-4333-8333-333333333333",
    );
    expect(output?.systemMessage).not.toContain("Lore learned");
  });

  it("pairs Stop with the next prompt and returns hook JSON", async () => {
    const home = await configuredHome();
    const requests: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as unknown);
      return new Response(
        JSON.stringify({ context: { text: "Use the shared rule." } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });

    await handleHookEvent(
      {
        session_id: "session-1",
        hook_event_name: "Stop",
        turn_id: "turn-1",
        cwd: "/work/project",
        last_assistant_message: "Use token sk-abcdefghijklmnopqrst in code.",
      },
      "codex",
      { home, fetch: fetchMock as typeof fetch },
    );
    await handleHookEvent(
      {
        session_id: "session-1",
        hook_event_name: "SessionEnd",
      },
      "codex",
      { home, fetch: fetchMock as typeof fetch },
    );
    const output = await handleHookEvent(
      {
        session_id: "session-1",
        hook_event_name: "UserPromptSubmit",
        turn_id: "turn-2",
        cwd: "/work/project",
        prompt: "No, password=hunterhunter is not allowed.",
      },
      "codex",
      {
        home,
        fetch: fetchMock as typeof fetch,
        now: () => new Date("2026-08-12T20:00:00.000Z"),
      },
    );

    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "Use the shared rule.",
      },
    });
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).not.toContain("sk-abcdefghijklmnopqrst");
    expect(JSON.stringify(requests[0])).not.toContain("hunterhunter");
    expect(requests[0]).toMatchObject({
      connector: "lore-cli",
      agent: "codex",
      sessionId: "session-1",
      learningScope: { repo: "project" },
      previousAssistant: {
        content: "Use token [REDACTED_API_KEY] in code.",
        id: "turn-1",
      },
      currentUser: {
        content: "No, password=[REDACTED] is not allowed.",
        id: "turn-2",
      },
    });
  });

  it("fails open and queues an unavailable turn", async () => {
    const home = await configuredHome();
    const fetchMock = vi.fn(async () => {
      throw new Error("offline");
    });

    await handleHookEvent(
      {
        session_id: "session-2",
        hook_event_name: "Stop",
        last_assistant_message: "The old behavior is correct.",
      },
      "claude",
      { home, fetch: fetchMock as typeof fetch },
    );
    const output = await handleHookEvent(
      {
        session_id: "session-2",
        hook_event_name: "UserPromptSubmit",
        prompt: "Actually, the new behavior is required.",
      },
      "claude",
      { home, fetch: fetchMock as typeof fetch },
    );

    expect(output).toBeUndefined();
    const queue = await readdir(resolve(home, ".lore", "queue"));
    expect(queue).toHaveLength(1);
    const queued = await readFile(
      resolve(home, ".lore", "queue", queue[0] as string),
      "utf8",
    );
    expect(JSON.parse(queued)).toMatchObject({
      kind: "turn",
      request: {
        agent: "claude",
        sessionId: "session-2",
      },
    });
  });

  it("queues first-prompt teaching while still retrieving context", async () => {
    const home = await configuredHome();
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/v1/observations")) {
        throw new Error("observation unavailable");
      }
      return Response.json({ context: "Previously remembered context." });
    });

    const output = await handleHookEvent(
      {
        session_id: "session-3",
        hook_event_name: "UserPromptSubmit",
        prompt_id: "prompt-1",
        prompt: "Always prefer bounded retries.",
      },
      "codex",
      { home, fetch: fetchMock as typeof fetch },
    );

    expect(output?.hookSpecificOutput.additionalContext).toBe(
      "Previously remembered context.",
    );
    const queue = await readdir(resolve(home, ".lore", "queue"));
    expect(queue).toHaveLength(1);
    const queued = JSON.parse(
      await readFile(
        resolve(home, ".lore", "queue", queue[0] as string),
        "utf8",
      ),
    ) as unknown;
    expect(queued).toMatchObject({
      kind: "prompt",
      request: {
        agent: "codex",
        sessionId: "session-3",
        prompt: "Always prefer bounded retries.",
      },
    });
  });

  it("uses an audited context delivery when a paired turn fails", async () => {
    const home = await configuredHome();
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const request = {
        url: String(url),
        body: JSON.parse(String(init?.body)) as unknown,
      };
      requests.push(request);
      if (request.url.endsWith("/v1/turns")) {
        throw new Error("turn unavailable");
      }
      return Response.json({ context: "Fallback context." });
    });
    await handleHookEvent(
      {
        session_id: "session-4",
        hook_event_name: "Stop",
        turn_id: "turn-1",
        last_assistant_message: "Use the old store.",
      },
      "codex",
      { home, fetch: fetchMock as typeof fetch },
    );

    const output = await handleHookEvent(
      {
        session_id: "session-4",
        hook_event_name: "UserPromptSubmit",
        turn_id: "turn-2",
        prompt: "Use AccountStore.",
      },
      "codex",
      { home, fetch: fetchMock as typeof fetch },
    );

    expect(output?.hookSpecificOutput.additionalContext).toBe(
      "Fallback context.",
    );
    expect(requests[1]).toMatchObject({
      url: "https://lore.example.test/v1/context/deliveries",
      body: {
        connector: "lore-cli",
        eventId: expect.any(String),
        sessionId: "session-4",
        task: {
          agent: "codex",
          task: "Use AccountStore.",
        },
      },
    });
  });

  it("redacts common credential formats", () => {
    expect(
      redactSecrets(
        "Authorization: Bearer abcdefghijklmnop github_pat_abcdefghijklmnopqrst",
      ),
    ).toBe(
      "Authorization: Bearer [REDACTED] [REDACTED_GITHUB_TOKEN]",
    );
  });

  it("redacts credentials with quoted JSON keys", () => {
    expect(
      redactSecrets(
        'Use this config: {"password": "super-secret-value", "api_key": "another-secret-value"}',
      ),
    ).toBe(
      'Use this config: {"password": "[REDACTED]", "api_key": "[REDACTED]"}',
    );
  });
});
