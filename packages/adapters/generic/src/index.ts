import {
  AgentInteractionSchema,
  AgentTaskSchema,
  ContextDeliveryRequestSchema,
  GENERIC_LORE_CONTEXT_DELIMITERS,
  MemorySchema,
  ObservationRequestSchema,
  PairedTurnRequestSchema,
  TurnScopeSchema,
  type AgentAdapter,
  type AgentInteraction,
  type AgentMessage,
  type AgentTask,
  type ContextDeliveryRequest,
  type ContextDeliveryResponse,
  type Memory,
  type MemoryScope,
  type ObservationRequest,
  type ObservationResponse,
  type ObserveResponse,
  type PairedTurnMessage,
  type PairedTurnRequest,
  type PairedTurnResponse,
  type TurnScope,
} from "@lore-co/core";
import {
  SharedMemoryClient,
  type SharedMemoryClientOptions,
} from "@lore-co/sdk";

export interface AdapterScopeInput {
  scope?: MemoryScope;
  organization?: string;
  project?: string;
  repo?: string;
  path?: string;
  component?: string;
}

export interface AdapterInteractionInput extends AdapterScopeInput {
  agent?: string;
  sessionId?: string;
  messages: readonly AgentMessage[];
}

export interface AdapterTaskInput extends AdapterScopeInput {
  agent?: string;
  task?: string;
  prompt?: string;
  instruction?: string;
  diff?: string;
  files?: readonly string[];
  components?: readonly string[];
  symbols?: readonly string[];
  limit?: number;
}

export interface SharedMemoryAdapterOptions {
  client?: SharedMemoryClient;
  baseUrl?: string;
  fetch?: SharedMemoryClientOptions["fetch"];
  headers?: SharedMemoryClientOptions["headers"];
}

export interface GenericAgentAdapterOptions extends SharedMemoryAdapterOptions {
  id: string;
}

export type GenericInteractionInput = AdapterInteractionInput;
export type GenericTaskInput = AdapterTaskInput;

export interface GenericHostIdentity {
  connector: string;
  eventId: string;
  sessionId: string;
  conversationId?: string;
}

export interface GenericHostScopeInput {
  scope?: TurnScope;
  project?: string;
  repo?: string;
  path?: string;
  component?: string;
}

export interface GenericHostTaskInput extends GenericHostScopeInput {
  task?: string;
  prompt?: string;
  instruction?: string;
  diff?: string;
  files?: readonly string[];
  components?: readonly string[];
  symbols?: readonly string[];
  limit?: number;
}

export interface GenericObservationInput
  extends GenericHostIdentity,
    GenericHostScopeInput {
  task?: string;
  prompt?: string;
  instruction?: string;
  messages: readonly AgentMessage[];
  occurredAt: string;
  metadata?: Record<string, unknown>;
}

export interface GenericDeliveryInput extends GenericHostTaskInput {
  connector: string;
  eventId: string;
  sessionId: string;
}

export interface GenericTurnInput
  extends GenericHostIdentity,
    GenericHostTaskInput {
  previousAssistant: PairedTurnMessage | string;
  currentUser?: PairedTurnMessage | string;
  currentUserPrompt?: string;
  learningScope?: TurnScope;
  occurredAt?: string;
  metadata?: Record<string, unknown>;
}

export interface GenericPromptPayload {
  prompt: string;
  task: AgentTask;
  memories: Memory[];
}

export type GenericPreparedDelivery = ContextDeliveryResponse & {
  prompt: string;
  task: AgentTask;
};

export type GenericProcessedTurn = PairedTurnResponse & {
  prompt: string;
  turn: PairedTurnRequest;
  memories: Memory[];
};

export interface SharedMemoryDelimiters {
  start: string;
  end: string;
}

export const GENERIC_SHARED_MEMORY_DELIMITERS: SharedMemoryDelimiters = {
  ...GENERIC_LORE_CONTEXT_DELIMITERS,
};

function present<T>(value: T | undefined): value is T {
  return value !== undefined;
}

export function createAdapterClient(
  options: SharedMemoryAdapterOptions,
): SharedMemoryClient {
  if (options.client !== undefined) {
    if (options.baseUrl !== undefined) {
      throw new Error("Provide either client or baseUrl, not both");
    }
    return options.client;
  }
  if (options.baseUrl === undefined) {
    throw new Error("An injected SharedMemoryClient or baseUrl is required");
  }
  return new SharedMemoryClient({
    baseUrl: options.baseUrl,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });
}

export function toSharedInteraction(
  input: AdapterInteractionInput,
  agent: string,
): AgentInteraction {
  return AgentInteractionSchema.parse({
    agent,
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    ...(input.organization === undefined
      ? {}
      : { organization: input.organization }),
    ...(input.project === undefined ? {} : { project: input.project }),
    ...(input.repo === undefined ? {} : { repo: input.repo }),
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.component === undefined ? {} : { component: input.component }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    messages: input.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.id === undefined ? {} : { id: message.id }),
      ...(message.timestamp === undefined
        ? {}
        : { timestamp: message.timestamp }),
    })),
  });
}

export function taskText(input: AdapterTaskInput): string {
  const value = input.task ?? input.prompt ?? input.instruction;
  if (value === undefined) {
    throw new Error("Task text is required in task, prompt, or instruction");
  }
  return value;
}

function optionalTaskText(input: {
  task?: string;
  prompt?: string;
  instruction?: string;
}): string | undefined {
  return input.task ?? input.prompt ?? input.instruction;
}

export function normalizeHostScope(input: GenericHostScopeInput): TurnScope {
  for (const field of ["project", "repo", "path", "component"] as const) {
    const nested = input.scope?.[field];
    const flat = input[field];
    if (nested !== undefined && flat !== undefined && nested !== flat) {
      throw new Error(`Conflicting ${field} values were provided`);
    }
  }
  return TurnScopeSchema.parse({
    ...input.scope,
    ...(input.project === undefined ? {} : { project: input.project }),
    ...(input.repo === undefined ? {} : { repo: input.repo }),
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.component === undefined ? {} : { component: input.component }),
  });
}

export function toHostTask(
  input: GenericHostTaskInput,
  agent: string,
): AgentTask {
  return AgentTaskSchema.parse({
    agent,
    scope: normalizeHostScope(input),
    task: taskText(input),
    ...(input.diff === undefined ? {} : { diff: input.diff }),
    ...(input.files === undefined ? {} : { files: [...input.files] }),
    ...(input.components === undefined
      ? {}
      : { components: [...input.components] }),
    ...(input.symbols === undefined ? {} : { symbols: [...input.symbols] }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
}

export function toSharedTask(
  input: AdapterTaskInput,
  agent: string,
): AgentTask {
  return AgentTaskSchema.parse({
    agent,
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    ...(input.organization === undefined
      ? {}
      : { organization: input.organization }),
    ...(input.project === undefined ? {} : { project: input.project }),
    ...(input.repo === undefined ? {} : { repo: input.repo }),
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.component === undefined ? {} : { component: input.component }),
    task: taskText(input),
    ...(input.diff === undefined ? {} : { diff: input.diff }),
    ...(input.files === undefined ? {} : { files: [...input.files] }),
    ...(input.components === undefined
      ? {}
      : { components: [...input.components] }),
    ...(input.symbols === undefined ? {} : { symbols: [...input.symbols] }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
}

export function formatMemoryList(
  memories: readonly Memory[],
  formatMemory: (memory: Memory) => string = (memory) =>
    `- [${memory.category}] ${memory.content}`,
): string {
  return memories
    .map((memory) => MemorySchema.parse(memory))
    .map(formatMemory)
    .filter(present)
    .join("\n");
}

export function injectSharedMemory(
  originalTask: string,
  context: string,
  delimiters: SharedMemoryDelimiters = GENERIC_SHARED_MEMORY_DELIMITERS,
): string {
  const formatted = context.trim();
  if (formatted === "") {
    return originalTask;
  }
  return `${delimiters.start}\n${formatted}\n${delimiters.end}\n\n${originalTask}`;
}

export class GenericAgentAdapter
  implements
    AgentAdapter<
      GenericInteractionInput,
      GenericTaskInput,
      GenericPromptPayload
    >
{
  readonly id: string;
  protected readonly client: SharedMemoryClient;

  constructor(options: GenericAgentAdapterOptions) {
    const id = options.id.trim();
    if (id === "") {
      throw new Error("GenericAgentAdapter id is required");
    }
    this.id = id;
    this.client = createAdapterClient(options);
  }

  toInteraction(input: GenericInteractionInput): AgentInteraction {
    return toSharedInteraction(input, this.id);
  }

  toTask(input: GenericTaskInput): AgentTask {
    return toSharedTask(input, this.id);
  }

  toObservation(input: GenericObservationInput): ObservationRequest {
    const normalizedTask = optionalTaskText(input);
    return ObservationRequestSchema.parse({
      connector: input.connector,
      eventId: input.eventId,
      agent: this.id,
      sessionId: input.sessionId,
      ...(input.conversationId === undefined
        ? {}
        : { conversationId: input.conversationId }),
      scope: normalizeHostScope(input),
      ...(normalizedTask === undefined ? {} : { task: normalizedTask }),
      messages: input.messages.map((message) => ({ ...message })),
      occurredAt: input.occurredAt,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    });
  }

  toDelivery(input: GenericDeliveryInput): ContextDeliveryRequest {
    return ContextDeliveryRequestSchema.parse({
      connector: input.connector,
      eventId: input.eventId,
      sessionId: input.sessionId,
      task: toHostTask(input, this.id),
    });
  }

  toTurn(input: GenericTurnInput): PairedTurnRequest {
    const normalizedTask = optionalTaskText(input);
    return PairedTurnRequestSchema.parse({
      connector: input.connector,
      eventId: input.eventId,
      agent: this.id,
      sessionId: input.sessionId,
      ...(input.conversationId === undefined
        ? {}
        : { conversationId: input.conversationId }),
      previousAssistant: input.previousAssistant,
      ...(input.currentUser === undefined
        ? {}
        : { currentUser: input.currentUser }),
      ...(input.currentUserPrompt === undefined
        ? {}
        : { currentUserPrompt: input.currentUserPrompt }),
      scope: normalizeHostScope(input),
      ...(input.learningScope === undefined
        ? {}
        : { learningScope: TurnScopeSchema.parse(input.learningScope) }),
      ...(normalizedTask === undefined ? {} : { task: normalizedTask }),
      ...(input.files === undefined ? {} : { files: [...input.files] }),
      ...(input.components === undefined
        ? {}
        : { components: [...input.components] }),
      ...(input.symbols === undefined ? {} : { symbols: [...input.symbols] }),
      ...(input.occurredAt === undefined
        ? {}
        : { occurredAt: input.occurredAt }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    });
  }

  async observe(input: GenericInteractionInput): Promise<ObserveResponse> {
    return this.client.observe(this.toInteraction(input));
  }

  async observeEvent(
    input: GenericObservationInput,
  ): Promise<ObservationResponse> {
    return this.client.observeEvent(this.toObservation(input));
  }

  async getContext(input: GenericTaskInput): Promise<Memory[]> {
    const response = await this.client.getContext(this.toTask(input));
    return response.memories.map((memory) => MemorySchema.parse(memory));
  }

  formatContext(memories: readonly Memory[]): string {
    return formatMemoryList(memories);
  }

  /** @deprecated Use prepareDelivery for an audited host integration. */
  async prepareTask(input: GenericTaskInput): Promise<GenericPromptPayload> {
    const task = this.toTask(input);
    const response = await this.client.getContext(task);
    const memories = response.memories.map((memory) =>
      MemorySchema.parse(memory),
    );
    return {
      prompt: injectSharedMemory(task.task, response.context),
      task,
      memories,
    };
  }

  async prepareDelivery(
    input: GenericDeliveryInput,
  ): Promise<GenericPreparedDelivery> {
    const delivery = this.toDelivery(input);
    const response = await this.client.deliverContext(delivery);
    return {
      ...response,
      prompt: injectSharedMemory(delivery.task.task, response.context),
      task: delivery.task,
    };
  }

  async processTurn(
    input: GenericTurnInput,
    idempotencyKey?: string,
  ): Promise<GenericProcessedTurn> {
    const turn = this.toTurn(input);
    const response = await this.client.processTurn(turn, idempotencyKey);
    return {
      ...response,
      prompt: injectSharedMemory(
        turn.currentUser.content,
        response.context.text,
      ),
      turn,
      memories: response.context.memories,
    };
  }
}
