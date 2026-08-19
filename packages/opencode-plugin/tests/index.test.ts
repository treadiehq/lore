import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GENERIC_SHARED_MEMORY_DELIMITERS,
  injectSharedMemory,
  type GenericDeliveryInput,
  type GenericObservationInput,
  type GenericTurnInput,
} from "@lore-co/adapter-generic";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CONTEXT_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_RESPONSE_BYTES,
  canonicalRepositoryScope,
  createBoundedFetch,
  createLoreOpenCodePlugin,
  resolveLoreCredentials,
  type OpenCodeLoreAdapter,
} from "../src/index.js";

type ChatHook = NonNullable<Hooks["chat.message"]>;
type PluginEvent =
  Parameters<NonNullable<Hooks["event"]>>[0]["event"];

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function adapterFixture(
  context:
    | string
    | ((input: GenericDeliveryInput) => string) = "Use AccountStore.",
  turnContext = "Use the corrected account contract.",
): {
  adapter: OpenCodeLoreAdapter;
  observeEvent: ReturnType<typeof vi.fn>;
  prepareDelivery: ReturnType<typeof vi.fn>;
  processTurn: ReturnType<typeof vi.fn>;
} {
  const observeEvent = vi.fn(
    async (_input: GenericObservationInput): Promise<unknown> => ({
      captured: true,
    }),
  );
  const prepareDelivery = vi.fn(
    async (
      input: GenericDeliveryInput,
    ): Promise<{ readonly context: string }> => ({
      context: typeof context === "string" ? context : context(input),
    }),
  );
  const processTurn = vi.fn(
    async (
      _input: GenericTurnInput,
      _idempotencyKey?: string,
    ): Promise<{ readonly context: { readonly text: string } }> => ({
      context: { text: turnContext },
    }),
  );
  return {
    adapter: { observeEvent, prepareDelivery, processTurn },
    observeEvent,
    prepareDelivery,
    processTurn,
  };
}

function clientResult(data: unknown[]): {
  data: unknown[];
  error: undefined;
  request: Request;
  response: Response;
} {
  return {
    data,
    error: undefined,
    request: new Request("http://opencode.test/session/messages"),
    response: new Response("[]"),
  };
}

function contextFixture(
  messages = vi.fn(async () => clientResult([])),
): { context: PluginInput; messages: typeof messages } {
  const context = {
    client: {
      session: {
        messages,
      },
    },
    project: {
      id: "acme/lore",
      worktree: "/workspace/lore",
      time: { created: 1 },
    },
    directory: "/workspace/lore/packages/example",
    worktree: "/workspace/lore",
    serverUrl: new URL("http://opencode.test"),
    experimental_workspace: {
      register: vi.fn(),
    },
    $: {},
  } as unknown as PluginInput;
  return { context, messages };
}

function chatArguments(input: {
  sessionId?: string;
  messageId?: string;
  text?: string;
  created?: number;
} = {}): {
  input: Parameters<ChatHook>[0];
  output: Parameters<ChatHook>[1];
} {
  const sessionId = input.sessionId ?? "session-1";
  const messageId = input.messageId ?? "message-1";
  return {
    input: {
      sessionID: sessionId,
      agent: "build",
      model: {
        providerID: "anthropic",
        modelID: "claude-test",
      },
      messageID: messageId,
    },
    output: {
      message: {
        id: messageId,
        sessionID: sessionId,
        role: "user",
        time: { created: input.created ?? 1_700_000_000_000 },
        agent: "build",
        model: {
          providerID: "anthropic",
          modelID: "claude-test",
        },
      },
      parts: [
        {
          id: `part-${messageId}`,
          sessionID: sessionId,
          messageID: messageId,
          type: "text",
          text: input.text ?? "Implement the account handler.",
        },
      ],
    },
  };
}

async function pluginHooks(
  adapter: OpenCodeLoreAdapter,
  context = contextFixture().context,
  options?: Record<string, unknown>,
): Promise<Hooks> {
  return createLoreOpenCodePlugin({
    adapter,
    repositoryScope: "acme/lore",
  })(
    context,
    options,
  );
}

async function emit(
  hooks: Hooks,
  event: PluginEvent,
): Promise<void> {
  await hooks.event?.({ event });
}

function textPart(
  sessionId: string,
  messageId: string,
  text: string,
): Record<string, unknown> {
  return {
    id: `part-${messageId}`,
    sessionID: sessionId,
    messageID: messageId,
    type: "text",
    text,
  };
}

function userMessage(
  sessionId: string,
  messageId: string,
  text: string,
  created: number,
): Record<string, unknown> {
  return {
    info: {
      id: messageId,
      sessionID: sessionId,
      role: "user",
      time: { created },
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-test" },
    },
    parts: [textPart(sessionId, messageId, text)],
  };
}

function assistantMessage(
  sessionId: string,
  messageId: string,
  parentId: string,
  text: string,
  created: number,
): Record<string, unknown> {
  return {
    info: {
      id: messageId,
      sessionID: sessionId,
      role: "assistant",
      time: { created, completed: created + 10 },
      parentID: parentId,
      modelID: "claude-test",
      providerID: "anthropic",
      mode: "build",
      path: { cwd: "/workspace/lore", root: "/workspace/lore" },
      cost: 0,
      tokens: {
        input: 1,
        output: 1,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
    parts: [textPart(sessionId, messageId, text)],
  };
}

function incompleteAssistantMessage(
  sessionId: string,
  messageId: string,
  parentId: string,
  text: string,
  created: number,
): Record<string, unknown> {
  const message = assistantMessage(
    sessionId,
    messageId,
    parentId,
    text,
    created,
  );
  return {
    ...message,
    info: {
      ...(message.info as Record<string, unknown>),
      time: { created },
    },
  };
}

describe("Lore OpenCode plugin", () => {
  it("uses the canonical Git origin identity shared by other agents", () => {
    expect(canonicalRepositoryScope("git@github.com:Acme/lore.git")).toBe(
      "Acme/lore",
    );
    expect(
      canonicalRepositoryScope("https://github.com/Acme/lore.git"),
    ).toBe("Acme/lore");
  });

  it("captures and delivers a first chat.message exactly once", async () => {
    const fixture = adapterFixture();
    const hooks = await pluginHooks(fixture.adapter);
    const existingBlock = injectSharedMemory(
      "",
      "This stale Lore context must not be captured.",
    ).trim();
    const chat = chatArguments({
      text: `${existingBlock}\n\nImplement the account handler.`,
    });

    await hooks["chat.message"]?.(chat.input, chat.output);
    await hooks["chat.message"]?.(chat.input, chat.output);

    expect(fixture.observeEvent).toHaveBeenCalledOnce();
    expect(fixture.prepareDelivery).toHaveBeenCalledOnce();
    expect(fixture.processTurn).not.toHaveBeenCalled();
    const firstObservation = fixture.observeEvent.mock.calls[0]?.[0] as
      | GenericObservationInput
      | undefined;
    const firstDelivery = fixture.prepareDelivery.mock.calls[0]?.[0] as
      | GenericDeliveryInput
      | undefined;

    expect(firstObservation).toMatchObject({
      connector: "lore-opencode-plugin",
      sessionId: "session-1",
      task: "Implement the account handler.",
      scope: {
        repo: "acme/lore",
        path: "packages/example",
      },
      messages: [
        {
          role: "user",
          id: "message-1",
          content: "Implement the account handler.",
          timestamp: "2023-11-14T22:13:20.000Z",
        },
      ],
      metadata: {
        source: "chat.message",
        openCodeAgent: "build",
        providerId: "anthropic",
        modelId: "claude-test",
      },
    });
    expect(firstObservation?.eventId).toMatch(
      /^opencode:user:[a-f0-9]{64}$/u,
    );
    expect(firstDelivery).toMatchObject({
      connector: "lore-opencode-plugin",
      sessionId: "session-1",
      task: "Implement the account handler.",
      limit: 10,
    });
    expect(firstDelivery?.eventId).toMatch(
      /^opencode:delivery:[a-f0-9]{64}$/u,
    );
  });

  it("injects exactly one current Lore block into the system prompt", async () => {
    const fixture = adapterFixture("Use the current account contract.");
    const hooks = await pluginHooks(fixture.adapter);
    const chat = chatArguments();
    await hooks["chat.message"]?.(chat.input, chat.output);

    const staleBlock = injectSharedMemory("", "Stale context.").trim();
    const system = ["Base system instruction.", staleBlock, staleBlock];
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "session-1", model: {} as never },
      { system },
    );
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "session-1", model: {} as never },
      { system },
    );

    const joined = system.join("\n");
    expect(joined).toContain("Base system instruction.");
    expect(joined).toContain("Use the current account contract.");
    expect(joined).not.toContain("Stale context.");
    expect(
      joined.split(GENERIC_SHARED_MEMORY_DELIMITERS.start).length - 1,
    ).toBe(1);
    expect(
      joined.split(GENERIC_SHARED_MEMORY_DELIMITERS.end).length - 1,
    ).toBe(1);
  });

  it("keeps contexts isolated and clears deleted sessions", async () => {
    const fixture = adapterFixture(
      (input) => `context-for-${input.sessionId}`,
    );
    const hooks = await pluginHooks(fixture.adapter);
    const first = chatArguments({
      sessionId: "session-a",
      messageId: "message-a",
    });
    const second = chatArguments({
      sessionId: "session-b",
      messageId: "message-b",
    });
    await hooks["chat.message"]?.(first.input, first.output);
    await hooks["chat.message"]?.(second.input, second.output);

    const firstSystem = ["Base A"];
    const secondSystem = ["Base B"];
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "session-a", model: {} as never },
      { system: firstSystem },
    );
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "session-b", model: {} as never },
      { system: secondSystem },
    );
    expect(firstSystem.join("\n")).toContain("context-for-session-a");
    expect(firstSystem.join("\n")).not.toContain("context-for-session-b");
    expect(secondSystem.join("\n")).toContain("context-for-session-b");

    await emit(hooks, {
      type: "session.deleted",
      properties: { info: { id: "session-a" } },
    } as PluginEvent);
    const afterDeletion = ["Base A"];
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "session-a", model: {} as never },
      { system: afterDeletion },
    );
    expect(afterDeletion).toEqual(["Base A"]);

    const stillActive = ["Base B"];
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "session-b", model: {} as never },
      { system: stillActive },
    );
    expect(stillActive.join("\n")).toContain("context-for-session-b");
  });

  it("pairs the next correction with the latest completed idle assistant exactly once", async () => {
    const sessionId = "session-idle";
    const messages = vi.fn(async () =>
      clientResult([
        userMessage(sessionId, "user-1", "First task", 100),
        assistantMessage(sessionId, "assistant-1", "user-1", "First reply", 200),
        userMessage(sessionId, "user-2", "Latest task", 300),
        assistantMessage(
          sessionId,
          "assistant-2",
          "user-2",
          "Latest reply",
          400,
        ),
        incompleteAssistantMessage(
          sessionId,
          "assistant-incomplete",
          "user-2",
          "Partial reply",
          500,
        ),
      ]),
    );
    const context = contextFixture(messages);
    const fixture = adapterFixture(
      "Initial context.",
      "Use the correction-aware context.",
    );
    const hooks = await pluginHooks(fixture.adapter, context.context);
    const first = chatArguments({
      sessionId,
      messageId: "user-2",
      text: "Latest task",
      created: 300,
    });
    await hooks["chat.message"]?.(first.input, first.output);
    fixture.observeEvent.mockClear();
    fixture.prepareDelivery.mockClear();
    const idleEvent = {
      type: "session.idle",
      properties: { sessionID: sessionId },
    } as PluginEvent;

    await emit(hooks, idleEvent);
    await emit(hooks, idleEvent);

    expect(messages).toHaveBeenCalledTimes(2);
    expect(fixture.observeEvent).not.toHaveBeenCalled();
    expect(fixture.prepareDelivery).not.toHaveBeenCalled();
    expect(fixture.processTurn).not.toHaveBeenCalled();

    const correction = chatArguments({
      sessionId,
      messageId: "user-correction",
      text: "Correction: use AccountStore instead.",
      created: 600,
    });
    await hooks["chat.message"]?.(correction.input, correction.output);
    await hooks["chat.message"]?.(correction.input, correction.output);

    expect(fixture.observeEvent).not.toHaveBeenCalled();
    expect(fixture.prepareDelivery).not.toHaveBeenCalled();
    expect(fixture.processTurn).toHaveBeenCalledOnce();
    const turn = fixture.processTurn.mock.calls[0]?.[0] as
      | GenericTurnInput
      | undefined;
    const idempotencyKey = fixture.processTurn.mock.calls[0]?.[1] as
      | string
      | undefined;
    expect(turn).toMatchObject({
      connector: "lore-opencode-plugin",
      sessionId,
      previousAssistant: {
        id: "assistant-2",
        content: "Latest reply",
        timestamp: "1970-01-01T00:00:00.410Z",
      },
      currentUser: {
        id: "user-correction",
        content: "Correction: use AccountStore instead.",
        timestamp: "1970-01-01T00:00:00.600Z",
      },
      scope: {
        repo: "acme/lore",
        path: "packages/example",
      },
      learningScope: { repo: "acme/lore" },
      task: "Correction: use AccountStore instead.",
      occurredAt: "1970-01-01T00:00:00.600Z",
      metadata: {
        source: "chat.message.paired_turn",
        previousAssistantMessageId: "assistant-2",
        currentUserMessageId: "user-correction",
      },
    });
    expect(turn?.eventId).toMatch(/^opencode:turn:[a-f0-9]{64}$/u);
    expect(idempotencyKey).toBe(turn?.eventId);
    expect(messages.mock.calls[0]?.[0]).toMatchObject({
      path: { id: sessionId },
      query: {
        directory: "/workspace/lore/packages/example",
        limit: 20,
      },
    });
    expect(messages.mock.calls[0]?.[0]?.signal.aborted).toBe(true);

    const system: string[] = [];
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: sessionId, model: {} as never },
      { system },
    );
    expect(system.join("\n")).toContain("Use the correction-aware context.");
  });

  it("does not re-stage a consumed stale assistant", async () => {
    const sessionId = "session-stale";
    const messages = vi.fn(async () =>
      clientResult([
        assistantMessage(
          sessionId,
          "assistant-old",
          "user-old",
          "Completed reply",
          200,
        ),
      ]),
    );
    const context = contextFixture(messages);
    const fixture = adapterFixture();
    const hooks = await pluginHooks(fixture.adapter, context.context);
    await emit(hooks, {
      type: "session.idle",
      properties: { sessionID: sessionId },
    } as PluginEvent);
    const correction = chatArguments({
      sessionId,
      messageId: "user-correction",
      text: "Correction",
      created: 300,
    });
    await hooks["chat.message"]?.(correction.input, correction.output);

    await emit(hooks, {
      type: "session.idle",
      properties: { sessionID: sessionId },
    } as PluginEvent);
    fixture.observeEvent.mockClear();
    fixture.prepareDelivery.mockClear();

    const next = chatArguments({
      sessionId,
      messageId: "user-next",
      text: "A new unpaired task",
      created: 400,
    });
    await hooks["chat.message"]?.(next.input, next.output);

    expect(fixture.processTurn).toHaveBeenCalledOnce();
    expect(fixture.observeEvent).toHaveBeenCalledOnce();
    expect(fixture.prepareDelivery).toHaveBeenCalledOnce();
  });

  it("retries a failed paired turn with the same deterministic idempotency key", async () => {
    const sessionId = "session-retry";
    const messages = vi.fn(async () =>
      clientResult([
        assistantMessage(
          sessionId,
          "assistant-retry",
          "user-original",
          "Incorrect answer",
          200,
        ),
      ]),
    );
    const context = contextFixture(messages);
    const fixture = adapterFixture();
    fixture.processTurn.mockRejectedValueOnce(
      new Error("temporary Lore failure"),
    );
    const hooks = await pluginHooks(fixture.adapter, context.context);
    await emit(hooks, {
      type: "session.idle",
      properties: { sessionID: sessionId },
    } as PluginEvent);
    const correction = chatArguments({
      sessionId,
      messageId: "user-retry",
      text: "Use the corrected API.",
      created: 300,
    });

    await hooks["chat.message"]?.(correction.input, correction.output);
    await hooks["chat.message"]?.(correction.input, correction.output);

    expect(fixture.processTurn).toHaveBeenCalledTimes(2);
    const firstTurn = fixture.processTurn.mock.calls[0]?.[0] as
      | GenericTurnInput
      | undefined;
    const secondTurn = fixture.processTurn.mock.calls[1]?.[0] as
      | GenericTurnInput
      | undefined;
    expect(secondTurn?.eventId).toBe(firstTurn?.eventId);
    expect(fixture.processTurn.mock.calls[0]?.[1]).toBe(firstTurn?.eventId);
    expect(fixture.processTurn.mock.calls[1]?.[1]).toBe(firstTurn?.eventId);
    expect(fixture.observeEvent).not.toHaveBeenCalled();
    expect(fixture.prepareDelivery).not.toHaveBeenCalled();
  });

  it("isolates pending assistants and deletes staged session state", async () => {
    const messages = vi.fn(
      async (options: { path: { id: string } }) =>
        clientResult([
          assistantMessage(
            options.path.id,
            `assistant-${options.path.id}`,
            `user-${options.path.id}`,
            `reply-${options.path.id}`,
            200,
          ),
        ]),
    );
    const context = contextFixture(messages);
    const fixture = adapterFixture();
    const hooks = await pluginHooks(fixture.adapter, context.context);
    await emit(hooks, {
      type: "session.idle",
      properties: { sessionID: "session-a" },
    } as PluginEvent);
    await emit(hooks, {
      type: "session.idle",
      properties: { sessionID: "session-b" },
    } as PluginEvent);
    await emit(hooks, {
      type: "session.deleted",
      properties: { info: { id: "session-a" } },
    } as PluginEvent);

    const deleted = chatArguments({
      sessionId: "session-a",
      messageId: "new-a",
    });
    const active = chatArguments({
      sessionId: "session-b",
      messageId: "new-b",
    });
    await hooks["chat.message"]?.(deleted.input, deleted.output);
    await hooks["chat.message"]?.(active.input, active.output);

    expect(fixture.processTurn).toHaveBeenCalledOnce();
    expect(fixture.processTurn.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "session-b",
      previousAssistant: {
        id: "assistant-session-b",
        content: "reply-session-b",
      },
    });
    expect(fixture.observeEvent).toHaveBeenCalledOnce();
    expect(fixture.observeEvent.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "session-a",
    });
  });

  it("bounds captured prompts and delivered context by UTF-8 bytes", async () => {
    const fixture = adapterFixture("é".repeat(MAX_CONTEXT_BYTES));
    const hooks = await pluginHooks(fixture.adapter);
    const chat = chatArguments({
      text: "🙂".repeat(MAX_MESSAGE_BYTES),
    });
    await hooks["chat.message"]?.(chat.input, chat.output);

    const observation = fixture.observeEvent.mock.calls[0]?.[0] as
      | GenericObservationInput
      | undefined;
    expect(
      Buffer.byteLength(observation?.messages[0]?.content ?? "", "utf8"),
    ).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    const system: string[] = [];
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "session-1", model: {} as never },
      { system },
    );
    const injected = system.join("\n");
    const context = injected
      .split(GENERIC_SHARED_MEMORY_DELIMITERS.start)[1]
      ?.split(GENERIC_SHARED_MEMORY_DELIMITERS.end)[0]
      ?.trim();
    expect(Buffer.byteLength(context ?? "", "utf8")).toBe(MAX_CONTEXT_BYTES);
  });

  it("fails open on adapter and OpenCode client timeouts without logging", async () => {
    let clientSignal: AbortSignal | undefined;
    const never = new Promise<never>(() => undefined);
    const adapter: OpenCodeLoreAdapter = {
      observeEvent: vi.fn(async () => never),
      prepareDelivery: vi.fn(async () => never),
      processTurn: vi.fn(async () => never),
    };
    const messages = vi.fn(
      async (options: { signal?: AbortSignal }) => {
        clientSignal = options.signal;
        return never;
      },
    );
    const context = contextFixture(messages);
    const hooks = await pluginHooks(adapter, context.context, {
      timeoutMs: 1,
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const startedAt = Date.now();

    const chat = chatArguments({ sessionId: "session-timeout" });
    await expect(
      hooks["chat.message"]?.(chat.input, chat.output),
    ).resolves.toBeUndefined();
    await expect(
      emit(hooks, {
        type: "session.idle",
        properties: { sessionID: "session-timeout" },
      } as PluginEvent),
    ).resolves.toBeUndefined();

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(clientSignal?.aborted).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("loads environment and ~/.lore credentials without exposing tokens", async () => {
    await expect(
      resolveLoreCredentials({
        env: {
          LORE_API_URL: "https://lore.example.test/",
          LORE_TOKEN: "fallback-token",
        },
      }),
    ).resolves.toEqual({
      apiUrl: "https://lore.example.test",
      token: "fallback-token",
    });
    await expect(
      resolveLoreCredentials({
        env: {
          LORE_API_URL: "https://lore.example.test",
          LORE_WORKSPACE_TOKEN: "",
          LORE_TOKEN: "legacy-token",
        },
      }),
    ).resolves.toMatchObject({ token: "legacy-token" });
    await expect(
      resolveLoreCredentials({
        env: { LORE_API_URL: "https://lore.example.test" },
      }),
    ).rejects.toThrow("LORE_WORKSPACE_TOKEN or LORE_TOKEN");

    const home = await mkdtemp(join(tmpdir(), "lore-opencode-"));
    temporaryDirectories.push(home);
    await mkdir(join(home, ".lore"));
    await writeFile(
      join(home, ".lore", "config.json"),
      JSON.stringify({
        version: 1,
        apiUrl: "http://127.0.0.1:3004/",
        token: "stored-token",
        agents: [],
      }),
      "utf8",
    );
    await expect(
      resolveLoreCredentials({ env: {}, home }),
    ).resolves.toEqual({
      apiUrl: "http://127.0.0.1:3004",
      token: "stored-token",
    });
  });

  it("bounds Lore HTTP responses and aborts timed-out fetches", async () => {
    const oversized = createBoundedFetch(
      vi.fn(async () =>
        new Response("x", {
          headers: {
            "content-length": String(MAX_RESPONSE_BYTES + 1),
          },
        }),
      ) as typeof fetch,
      100,
    );
    await expect(
      oversized("https://lore.example.test/v1/context"),
    ).rejects.toThrow("too large");

    let signal: AbortSignal | undefined;
    const timed = createBoundedFetch(
      vi.fn(
        async (
          _input: string | URL | Request,
          init?: RequestInit,
        ): Promise<Response> => {
          signal = init?.signal ?? undefined;
          return new Promise<Response>(() => undefined);
        },
      ) as typeof fetch,
      100,
    );
    await expect(
      timed("https://lore.example.test/v1/context"),
    ).rejects.toThrow();
    expect(signal?.aborted).toBe(true);
  });
});
