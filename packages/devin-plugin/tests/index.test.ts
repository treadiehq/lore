import { PassThrough, Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_CONTEXT_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_STDIN_BYTES,
  MAX_STDOUT_BYTES,
  handleDevinHookEvent,
  readBoundedHookInput,
  runDevinHook,
  serializeDevinHookOutput,
} from "../src/index.js";

const env = {
  LORE_API_URL: "https://lore.example.test",
  LORE_WORKSPACE_TOKEN: "workspace-token",
};

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: "UserPromptSubmit",
    session_id: "session-123",
    prompt_id: "prompt-456",
    prompt: "Implement the requested behavior",
    cwd: "packages/example/src",
    repository: "acme/example",
    ...overrides,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Devin managed-plugin hook bridge", () => {
  it("injects authenticated pre-turn context in the documented shape", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return jsonResponse({ context: "Use the shared repository rule." });
    });

    const result = await handleDevinHookEvent(event(), {
      env,
      fetch: fetchMock as typeof fetch,
    });

    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "Use the shared repository rule.",
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://lore.example.test/v1/context");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
      "Bearer workspace-token",
    );
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      agent: "devin",
      task: "Implement the requested behavior",
      scope: {
        repo: "acme/example",
        path: "packages/example/src",
      },
    });
  });

  it("uses a stable paired-turn idempotency key and returned context", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return jsonResponse({ context: { text: "Prefer the corrected API." } });
    });
    const pairedEvent = event({
      prior_assistant_message: "The legacy API is required.",
      prior_assistant_message_id: "assistant-789",
      prompt:
        "<<< RELEVANT LORE ENGINEERING KNOWLEDGE >>>\nThe legacy API is required.\n<<< END RELEVANT LORE ENGINEERING KNOWLEDGE >>>\n\nCorrection: use the new API.",
    });

    const first = await handleDevinHookEvent(pairedEvent, {
      env,
      fetch: fetchMock as typeof fetch,
    });
    const second = await handleDevinHookEvent(pairedEvent, {
      env,
      fetch: fetchMock as typeof fetch,
    });

    expect(first).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "Prefer the corrected API.",
      },
    });
    expect(second).toEqual(first);
    expect(requests.map((request) => request.url)).toEqual([
      "https://lore.example.test/v1/turns",
      "https://lore.example.test/v1/turns",
    ]);
    const firstHeaders = new Headers(requests[0]?.init?.headers);
    const secondHeaders = new Headers(requests[1]?.init?.headers);
    const idempotencyKey = firstHeaders.get("idempotency-key");
    expect(idempotencyKey).toMatch(/^devin:[a-f0-9]{64}$/u);
    expect(secondHeaders.get("idempotency-key")).toBe(idempotencyKey);
    const firstBody = JSON.parse(String(requests[0]?.init?.body)) as Record<
      string,
      unknown
    >;
    const secondBody = JSON.parse(String(requests[1]?.init?.body)) as Record<
      string,
      unknown
    >;
    expect(firstBody).toEqual(secondBody);
    expect(firstBody).toMatchObject({
      connector: "lore-devin-plugin",
      eventId: idempotencyKey,
      agent: "devin",
      sessionId: "session-123",
      previousAssistant: {
        content: "The legacy API is required.",
        id: "assistant-789",
      },
      currentUser: {
        content: "Correction: use the new API.",
        id: "prompt-456",
      },
      scope: {
        repo: "acme/example",
        path: "packages/example/src",
      },
      learningScope: {},
      task: "Correction: use the new API.",
    });
  });

  it("preserves delimiter-like text that is not an injected block", async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as unknown);
        return jsonResponse({ context: "" });
      },
    );
    const prompt =
      "Document the literal token <<< RELEVANT ENGINEERING KNOWLEDGE >>> in the parser.";

    await handleDevinHookEvent(event({ prompt }), {
      env,
      fetch: fetchMock as typeof fetch,
    });

    expect(bodies[0]).toMatchObject({ task: prompt });
  });

  it("honors explicit scope and the repository fallback", async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as unknown);
      return jsonResponse({ context: "" });
    });

    await handleDevinHookEvent(
      event({
        repo: "top/repo",
        path: "top/path",
        scope: {
          repo: "scoped/repo",
          path: "scoped/path",
          project: "payments",
          component: "worker",
        },
      }),
      {
        env: { ...env, LORE_DEVIN_REPO: "fallback/repo" },
        fetch: fetchMock as typeof fetch,
      },
    );
    await handleDevinHookEvent(
      event({ repository: undefined }),
      {
        env: { ...env, LORE_DEVIN_REPO: "fallback/repo" },
        fetch: fetchMock as typeof fetch,
      },
    );

    expect(bodies[0]).toMatchObject({
      scope: {
        repo: "scoped/repo",
        path: "scoped/path",
        project: "payments",
        component: "worker",
      },
    });
    expect(bodies[1]).toMatchObject({
      scope: {
        repo: "fallback/repo",
        path: "packages/example/src",
      },
    });
  });

  it("enforces a strict bounded timeout and fails open", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      },
    );
    const startedAt = Date.now();

    const result = await handleDevinHookEvent(event(), {
      env: { ...env, LORE_DEVIN_TIMEOUT_MS: "1" },
      fetch: fetchMock as typeof fetch,
    });

    expect(result).toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(requestSignal?.aborted).toBe(true);
  });

  it("fails open for missing configuration and network errors", async () => {
    const uncalledFetch = vi.fn(async () => jsonResponse({ context: "unused" }));
    await expect(
      handleDevinHookEvent(event(), {
        env: { LORE_API_URL: env.LORE_API_URL },
        fetch: uncalledFetch as typeof fetch,
      }),
    ).resolves.toBeUndefined();
    expect(uncalledFetch).not.toHaveBeenCalled();

    const failedFetch = vi.fn(async () => {
      throw new Error("token=must-not-be-logged");
    });
    await expect(
      handleDevinHookEvent(event(), {
        env,
        fetch: failedFetch as typeof fetch,
      }),
    ).resolves.toBeUndefined();
  });

  it("fails open for malformed or unsupported events", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ context: "unused" }));
    const malformed = [
      null,
      {},
      event({ hook_event_name: "Stop" }),
      event({ session_id: "" }),
      event({ prompt_id: 42 }),
      event({ prompt: "x".repeat(100_001) }),
      event({ cwd: null }),
      event({ scope: "repo/path" }),
    ];

    for (const input of malformed) {
      await expect(
        handleDevinHookEvent(input, {
          env,
          fetch: fetchMock as typeof fetch,
        }),
      ).resolves.toBeUndefined();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exits successfully and stays silent on malformed stdin", async () => {
    const stdout = new PassThrough();
    let written = "";
    stdout.on("data", (chunk: Buffer) => {
      written += chunk.toString("utf8");
    });
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await expect(
      runDevinHook({
        stdin: Readable.from(["{not-json"]),
        stdout,
        env,
      }),
    ).resolves.toBeUndefined();

    expect(written).toBe("");
    expect(stderrWrite).not.toHaveBeenCalled();
    stderrWrite.mockRestore();
  });

  it("bounds stdin, response bodies, context, and serialized output", async () => {
    await expect(
      readBoundedHookInput(
        Readable.from(["x".repeat(MAX_STDIN_BYTES + 1)]),
      ),
    ).rejects.toThrow();

    const oversizedResponse = vi.fn(async () =>
      jsonResponse({ padding: "x".repeat(MAX_RESPONSE_BYTES + 1) }),
    );
    await expect(
      handleDevinHookEvent(event(), {
        env,
        fetch: oversizedResponse as typeof fetch,
      }),
    ).resolves.toBeUndefined();

    const largeContext = "\u0000".repeat(MAX_CONTEXT_BYTES + 1_000);
    const contextResponse = vi.fn(async () =>
      jsonResponse({ context: largeContext }),
    );
    const output = await handleDevinHookEvent(event(), {
      env,
      fetch: contextResponse as typeof fetch,
    });
    expect(
      Buffer.byteLength(
        output?.hookSpecificOutput.additionalContext ?? "",
        "utf8",
      ),
    ).toBe(MAX_CONTEXT_BYTES);

    const serialized = serializeDevinHookOutput(output);
    expect(serialized).toBeDefined();
    expect(Buffer.byteLength(`${serialized}\n`, "utf8")).toBeLessThanOrEqual(
      MAX_STDOUT_BYTES,
    );
    expect(JSON.parse(serialized ?? "{}")).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
      },
    });
  });
});
