import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
      learningScope: {},
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
      learningScope: {},
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
});
