import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import {
  GenericAgentAdapter,
  injectSharedMemory,
  type GenericDeliveryInput,
  type GenericObservationInput,
  type GenericTurnInput,
} from "@lore-co/adapter-generic";
import { stripLoreInjectedContext, type TurnScope } from "@lore-co/core";
import type {
  Hooks,
  Plugin,
  PluginInput,
  PluginOptions,
} from "@opencode-ai/plugin";
import {
  boundedTimeout,
  createBoundedFetch,
  resolveLoreCredentials,
  withTimeout,
  type LoreEnvironment,
} from "./config.js";
import {
  canonicalRepositoryScope,
  repositoryScopeFromWorktree,
} from "./repository.js";

export {
  DEFAULT_TIMEOUT_MS,
  MAX_CONFIG_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  boundedTimeout,
  createBoundedFetch,
  resolveLoreCredentials,
  type LoreCredentials,
  type LoreEnvironment,
  type ResolveLoreCredentialsOptions,
} from "./config.js";
export {
  canonicalRepositoryScope,
  repositoryScopeFromWorktree,
} from "./repository.js";

export const MAX_CONTEXT_BYTES = 12_000;
export const MAX_MESSAGE_BYTES = 100_000;
export const MAX_SESSIONS = 256;

const MAX_ID_BYTES = 500;
const MAX_SCOPE_BYTES = 1_000;
const MAX_PATH_BYTES = 2_000;
const MAX_METADATA_BYTES = 500;
const MAX_PARTS_PER_MESSAGE = 200;
const MAX_MESSAGE_SCAN = 20;
const CONNECTOR = "lore-opencode-plugin";

type OpenCodePart =
  Parameters<NonNullable<Hooks["chat.message"]>>[1]["parts"][number];

interface PendingAssistant {
  id: string;
  content: string;
  timestamp: string;
  completedAt: number;
  fingerprint: string;
}

interface CompletedChat {
  fingerprint: string;
  context: string;
}

interface SessionState {
  active: boolean;
  context: string;
  pendingAssistant?: PendingAssistant;
  lastConsumedAssistant?: Pick<
    PendingAssistant,
    "completedAt" | "fingerprint"
  >;
  lastChat?: CompletedChat;
  chatTail?: Promise<void>;
  idle?: Promise<void>;
  idleAbort?: AbortController;
}

export interface OpenCodeLoreAdapter {
  observeEvent(input: GenericObservationInput): Promise<unknown>;
  prepareDelivery(
    input: GenericDeliveryInput,
  ): Promise<{ readonly context: string }>;
  processTurn(
    input: GenericTurnInput,
    idempotencyKey?: string,
  ): Promise<{ readonly context: { readonly text: string } }>;
}

export interface CreateLoreOpenCodePluginOptions {
  adapter?: OpenCodeLoreAdapter;
  env?: LoreEnvironment;
  home?: string;
  fetch?: typeof globalThis.fetch;
  repositoryScope?: string;
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Length(value) <= maxBytes) {
    return value;
  }
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = utf8Length(character);
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    output += character;
    bytes += characterBytes;
  }
  return output;
}

function boundedIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (normalized === "" || utf8Length(normalized) > MAX_ID_BYTES) {
    return undefined;
  }
  return normalized;
}

function boundedScopeValue(
  value: unknown,
  maxBytes: number,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = truncateUtf8(value.trim(), maxBytes);
  return normalized === "" ? undefined : normalized;
}

function isoTimestamp(value: number | undefined): string {
  const timestamp =
    value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0;
  return new Date(timestamp).toISOString();
}

function stableEventId(
  kind: "delivery" | "turn" | "user",
  ...values: readonly string[]
): string {
  const hash = createHash("sha256")
    .update(["@lore-co/opencode", kind, ...values].join("\0"))
    .digest("hex");
  return `opencode:${kind}:${hash}`;
}

function messageFingerprint(id: string, content: string): string {
  return createHash("sha256")
    .update(["@lore-co/opencode", id, content].join("\0"))
    .digest("hex");
}

function partText(parts: readonly OpenCodePart[]): string {
  const values: string[] = [];
  let remainingBytes = MAX_MESSAGE_BYTES;
  for (const part of parts.slice(0, MAX_PARTS_PER_MESSAGE)) {
    if (
      part.type !== "text" ||
      part.synthetic === true ||
      part.ignored === true ||
      remainingBytes <= 0
    ) {
      continue;
    }
    const bounded = truncateUtf8(
      part.text,
      MAX_MESSAGE_BYTES + MAX_CONTEXT_BYTES,
    );
    const clean = stripLoreInjectedContext(bounded).trim();
    if (clean === "") {
      continue;
    }
    const separatorBytes = values.length === 0 ? 0 : 1;
    if (remainingBytes <= separatorBytes) {
      break;
    }
    const value = truncateUtf8(clean, remainingBytes - separatorBytes);
    if (value === "") {
      break;
    }
    values.push(value);
    remainingBytes -= utf8Length(value) + separatorBytes;
  }
  return truncateUtf8(
    stripLoreInjectedContext(values.join("\n")).trim(),
    MAX_MESSAGE_BYTES,
  );
}

function contextText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return truncateUtf8(value.trim(), MAX_CONTEXT_BYTES);
}

function scopeFromContext(
  context: PluginInput,
  repositoryScope: string,
): TurnScope {
  const repo = boundedScopeValue(repositoryScope, MAX_SCOPE_BYTES);
  const relativePath = relative(context.worktree, context.directory);
  const path =
    relativePath.startsWith("..") || isAbsolute(relativePath)
      ? undefined
      : boundedScopeValue(relativePath, MAX_PATH_BYTES);
  return {
    ...(repo === undefined ? {} : { repo }),
    ...(path === undefined ? {} : { path }),
  };
}

function learningScopeFromContext(repositoryScope: string): TurnScope {
  const repo = boundedScopeValue(repositoryScope, MAX_SCOPE_BYTES);
  return repo === undefined ? {} : { repo };
}

function metadataFromChat(
  input: Parameters<NonNullable<Hooks["chat.message"]>>[0],
  context: PluginInput,
): Record<string, unknown> {
  return {
    source: "chat.message",
    directory: truncateUtf8(context.directory, MAX_PATH_BYTES),
    ...(input.agent === undefined
      ? {}
      : { openCodeAgent: truncateUtf8(input.agent, MAX_METADATA_BYTES) }),
    ...(input.model === undefined
      ? {}
      : {
          providerId: truncateUtf8(
            input.model.providerID,
            MAX_METADATA_BYTES,
          ),
          modelId: truncateUtf8(input.model.modelID, MAX_METADATA_BYTES),
        }),
  };
}

function pluginTimeout(
  options: PluginOptions | undefined,
  env: LoreEnvironment,
): number {
  const optionValue = options?.timeoutMs;
  if (optionValue !== undefined) {
    return boundedTimeout(optionValue);
  }
  const environmentValue = env.LORE_OPENCODE_TIMEOUT_MS;
  return boundedTimeout(
    environmentValue === undefined ? undefined : Number(environmentValue),
  );
}

class LoreOpenCodeRuntime {
  readonly #context: PluginInput;
  readonly #adapter: OpenCodeLoreAdapter | undefined;
  readonly #repositoryScope: string;
  readonly #timeoutMs: number;
  readonly #sessions = new Map<string, SessionState>();

  constructor(
    context: PluginInput,
    adapter: OpenCodeLoreAdapter | undefined,
    timeoutMs: number,
    repositoryScope: string,
  ) {
    this.#context = context;
    this.#adapter = adapter;
    this.#timeoutMs = timeoutMs;
    this.#repositoryScope = repositoryScope;
  }

  hooks(): Hooks {
    return {
      "chat.message": async (input, output) => {
        try {
          await this.#captureAndDeliver(input, output);
        } catch {
          // OpenCode must continue even when Lore receives malformed host data.
        }
      },
      "experimental.chat.system.transform": async (input, output) => {
        try {
          this.#injectContext(input.sessionID, output.system);
        } catch {
          // Context injection is optional and must never block a model request.
        }
      },
      event: async ({ event }) => {
        try {
          if (event.type === "session.idle") {
            await this.#stageLatestAssistant(event.properties.sessionID);
          } else if (event.type === "session.deleted") {
            this.#deleteSession(event.properties.info.id);
          }
        } catch {
          // Event capture is best-effort and must never disrupt OpenCode.
        }
      },
      dispose: async () => {
        try {
          for (const sessionId of this.#sessions.keys()) {
            this.#deleteSession(sessionId);
          }
        } catch {
          // Disposal remains fail-open during host shutdown.
        }
      },
    };
  }

  #session(sessionId: string): SessionState | undefined {
    const normalizedId = boundedIdentifier(sessionId);
    if (normalizedId === undefined) {
      return undefined;
    }
    const existing = this.#sessions.get(normalizedId);
    if (existing !== undefined) {
      this.#sessions.delete(normalizedId);
      this.#sessions.set(normalizedId, existing);
      return existing;
    }
    if (this.#sessions.size >= MAX_SESSIONS) {
      const oldestId = this.#sessions.keys().next().value as string | undefined;
      if (oldestId !== undefined) {
        this.#deleteSession(oldestId);
      }
    }
    const state: SessionState = {
      active: true,
      context: "",
    };
    this.#sessions.set(normalizedId, state);
    return state;
  }

  async #attempt<T>(operation: () => Promise<T>): Promise<T | undefined> {
    try {
      return await withTimeout(this.#timeoutMs, operation);
    } catch {
      return undefined;
    }
  }

  async #captureAndDeliver(
    input: Parameters<NonNullable<Hooks["chat.message"]>>[0],
    output: Parameters<NonNullable<Hooks["chat.message"]>>[1],
  ): Promise<void> {
    if (this.#adapter === undefined) {
      return;
    }
    const sessionId = boundedIdentifier(input.sessionID);
    const messageId = boundedIdentifier(output.message.id ?? input.messageID);
    const content = partText(output.parts);
    if (sessionId === undefined || messageId === undefined || content === "") {
      return;
    }
    const state = this.#session(sessionId);
    if (state === undefined) {
      return;
    }
    const timestamp = isoTimestamp(output.message.time.created);
    const fingerprint = messageFingerprint(messageId, content);
    const previous = state.chatTail ?? Promise.resolve();
    const chat = previous
      .catch(() => undefined)
      .then(async () => {
        await this.#processChatMessage(
          state,
          sessionId,
          messageId,
          content,
          timestamp,
          fingerprint,
          input,
        );
      });
    state.chatTail = chat;
    try {
      await chat;
    } finally {
      if (state.chatTail === chat) {
        delete state.chatTail;
      }
    }
  }

  async #processChatMessage(
    state: SessionState,
    sessionId: string,
    messageId: string,
    content: string,
    timestamp: string,
    fingerprint: string,
    input: Parameters<NonNullable<Hooks["chat.message"]>>[0],
  ): Promise<void> {
    if (!state.active) {
      return;
    }
    if (state.lastChat?.fingerprint === fingerprint) {
      state.context = state.lastChat.context;
      return;
    }
    if (state.idle !== undefined) {
      await state.idle;
      if (!state.active) {
        return;
      }
    }
    state.context = "";

    const scope = scopeFromContext(this.#context, this.#repositoryScope);
    const metadata = metadataFromChat(input, this.#context);
    const pendingAssistant = state.pendingAssistant;
    if (pendingAssistant !== undefined) {
      const eventId = stableEventId(
        "turn",
        sessionId,
        pendingAssistant.fingerprint,
        fingerprint,
      );
      const processed = await this.#attempt(() =>
        this.#adapter!.processTurn(
          {
            connector: CONNECTOR,
            eventId,
            sessionId,
            previousAssistant: {
              id: pendingAssistant.id,
              content: pendingAssistant.content,
              timestamp: pendingAssistant.timestamp,
            },
            currentUser: {
              id: messageId,
              content,
              timestamp,
            },
            scope,
            learningScope: learningScopeFromContext(this.#repositoryScope),
            task: content,
            occurredAt: timestamp,
            metadata: {
              ...metadata,
              source: "chat.message.paired_turn",
              previousAssistantMessageId: pendingAssistant.id,
              currentUserMessageId: messageId,
            },
          },
          eventId,
        ),
      );
      if (processed === undefined || !state.active) {
        return;
      }
      const context = contextText(processed.context.text);
      state.context = context;
      state.lastChat = { fingerprint, context };
      state.lastConsumedAssistant = {
        completedAt: pendingAssistant.completedAt,
        fingerprint: pendingAssistant.fingerprint,
      };
      if (state.pendingAssistant?.fingerprint === pendingAssistant.fingerprint) {
        delete state.pendingAssistant;
      }
      return;
    }

    const observationId = stableEventId(
      "user",
      sessionId,
      messageId,
      content,
    );
    const deliveryId = stableEventId(
      "delivery",
      sessionId,
      messageId,
      content,
    );
    const observation: GenericObservationInput = {
      connector: CONNECTOR,
      eventId: observationId,
      sessionId,
      scope,
      task: content,
      messages: [{ role: "user", content, id: messageId, timestamp }],
      occurredAt: timestamp,
      metadata,
    };
    const delivery: GenericDeliveryInput = {
      connector: CONNECTOR,
      eventId: deliveryId,
      sessionId,
      scope,
      task: content,
      limit: 10,
    };

    const [observed, prepared] = await Promise.all([
      this.#attempt(() => this.#adapter!.observeEvent(observation)),
      this.#attempt(() => this.#adapter!.prepareDelivery(delivery)),
    ]);
    if (!state.active) {
      return;
    }
    const context = contextText(prepared?.context);
    state.context = context;
    if (observed !== undefined && prepared !== undefined) {
      state.lastChat = { fingerprint, context };
    }
  }

  #injectContext(sessionId: string | undefined, system: string[]): void {
    if (sessionId === undefined) {
      return;
    }
    const state = this.#sessions.get(sessionId);
    if (state === undefined || !state.active) {
      return;
    }
    const cleaned = system
      .map((entry) => stripLoreInjectedContext(entry).trim())
      .filter((entry) => entry !== "");
    const context = contextText(state.context);
    if (context !== "") {
      cleaned.push(injectSharedMemory("", context).trim());
    }
    system.splice(0, system.length, ...cleaned);
  }

  async #stageLatestAssistant(sessionIdValue: string): Promise<void> {
    if (this.#adapter === undefined) {
      return;
    }
    const sessionId = boundedIdentifier(sessionIdValue);
    if (sessionId === undefined) {
      return;
    }
    const state = this.#session(sessionId);
    if (state === undefined) {
      return;
    }
    if (state.idle !== undefined) {
      await state.idle;
      return;
    }
    const idle = this.#loadAndStageAssistant(sessionId, state);
    state.idle = idle;
    try {
      await idle;
    } finally {
      if (state.idle === idle) {
        delete state.idle;
      }
    }
  }

  async #loadAndStageAssistant(
    sessionId: string,
    state: SessionState,
  ): Promise<void> {
    const controller = new AbortController();
    state.idleAbort = controller;
    let result: Awaited<
      ReturnType<PluginInput["client"]["session"]["messages"]>
    >;
    try {
      result = await withTimeout(this.#timeoutMs, () =>
        this.#context.client.session.messages({
          path: { id: sessionId },
          query: {
            directory: this.#context.directory,
            limit: MAX_MESSAGE_SCAN,
          },
          signal: controller.signal,
        }),
      );
    } catch {
      return;
    } finally {
      controller.abort();
      if (state.idleAbort === controller) {
        delete state.idleAbort;
      }
    }
    if (!state.active || result.data === undefined) {
      return;
    }

    const messages = result.data.slice(-MAX_MESSAGE_SCAN);
    let assistant:
      | (typeof messages)[number]
      | undefined;
    let completedAt = -1;
    for (const message of messages) {
      if (
        message.info.role !== "assistant" ||
        message.info.error !== undefined ||
        message.info.time.completed === undefined ||
        !Number.isFinite(message.info.time.completed)
      ) {
        continue;
      }
      if (message.info.time.completed >= completedAt) {
        assistant = message;
        completedAt = message.info.time.completed;
      }
    }
    if (assistant === undefined || assistant.info.role !== "assistant") {
      return;
    }
    const assistantInfo = assistant.info;
    const assistantId = boundedIdentifier(assistantInfo.id);
    const assistantContent = partText(assistant.parts);
    if (assistantId === undefined || assistantContent === "") {
      return;
    }
    const fingerprint = messageFingerprint(assistantId, assistantContent);
    if (
      state.lastConsumedAssistant !== undefined &&
      (completedAt < state.lastConsumedAssistant.completedAt ||
        (completedAt === state.lastConsumedAssistant.completedAt &&
          fingerprint === state.lastConsumedAssistant.fingerprint))
    ) {
      return;
    }
    if (
      state.pendingAssistant !== undefined &&
      (completedAt < state.pendingAssistant.completedAt ||
        (completedAt === state.pendingAssistant.completedAt &&
          fingerprint === state.pendingAssistant.fingerprint))
    ) {
      return;
    }

    state.pendingAssistant = {
      id: assistantId,
      content: assistantContent,
      timestamp: isoTimestamp(completedAt),
      completedAt,
      fingerprint,
    };
  }

  #deleteSession(sessionId: string): void {
    const state = this.#sessions.get(sessionId);
    if (state === undefined) {
      return;
    }
    state.active = false;
    state.context = "";
    delete state.pendingAssistant;
    delete state.lastChat;
    state.idleAbort?.abort();
    delete state.idleAbort;
    this.#sessions.delete(sessionId);
  }
}

async function createAdapter(
  dependencies: CreateLoreOpenCodePluginOptions,
  timeoutMs: number,
): Promise<OpenCodeLoreAdapter | undefined> {
  if (dependencies.adapter !== undefined) {
    return dependencies.adapter;
  }
  try {
    const env = dependencies.env ?? process.env;
    const credentials = await resolveLoreCredentials({
      env,
      ...(dependencies.home === undefined ? {} : { home: dependencies.home }),
    });
    const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
    return new GenericAgentAdapter({
      id: "opencode",
      baseUrl: credentials.apiUrl,
      headers: {
        authorization: `Bearer ${credentials.token}`,
      },
      fetch: createBoundedFetch(fetchImplementation, timeoutMs),
    });
  } catch {
    return undefined;
  }
}

export function createLoreOpenCodePlugin(
  dependencies: CreateLoreOpenCodePluginOptions = {},
): Plugin {
  return async (context, options) => {
    const env = dependencies.env ?? process.env;
    const timeoutMs = pluginTimeout(options, env);
    const adapter = await createAdapter(dependencies, timeoutMs);
    const repositoryScope =
      dependencies.repositoryScope === undefined
        ? await repositoryScopeFromWorktree(context.worktree)
        : canonicalRepositoryScope(dependencies.repositoryScope);
    return new LoreOpenCodeRuntime(
      context,
      adapter,
      timeoutMs,
      repositoryScope,
    ).hooks();
  };
}

export const LoreOpenCodePlugin: Plugin = createLoreOpenCodePlugin();

export default LoreOpenCodePlugin;
