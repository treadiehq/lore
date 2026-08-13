import {
  DEVIN_LORE_CONTEXT_DELIMITERS,
  type AgentAdapter,
  type AgentInteraction,
  type AgentMessage,
  type AgentTask,
  type Memory,
  type ObserveResponse,
} from "@lore-co/core";
import {
  type AdapterScopeInput,
  type AdapterTaskInput,
  createAdapterClient,
  formatMemoryList,
  injectSharedMemory,
  toSharedInteraction,
  toSharedTask,
  type SharedMemoryAdapterOptions,
  type SharedMemoryDelimiters,
} from "@lore-co/adapter-generic";
import { type SharedMemoryClient } from "@lore-co/sdk";

export type DevinMessageRole =
  | AgentMessage["role"]
  | "devin"
  | "human";

export type DevinMessageType =
  | "user_message"
  | "devin_message"
  | "assistant_message"
  | "tool_message"
  | "system_message";

export interface DevinMessage {
  role?: DevinMessageRole;
  type?: DevinMessageType;
  content?: string;
  message?: string;
  id?: string;
  messageId?: string;
  timestamp?: string;
}

export interface DevinSessionInput extends AdapterScopeInput {
  sessionId?: string;
  session_id?: string;
  message?: DevinMessage;
  event?: DevinMessage;
  messages?: readonly DevinMessage[];
  events?: readonly DevinMessage[];
  prompt?: string;
  response?: string;
}

export interface DevinTaskInput extends AdapterTaskInput {
  review?: boolean;
}

export interface DevinPreparedInstruction {
  instruction: string;
  task: AgentTask;
  memories: Memory[];
  kind: "task" | "review";
}

export type DevinAdapterOptions = SharedMemoryAdapterOptions;

export const DEVIN_SHARED_MEMORY_DELIMITERS: SharedMemoryDelimiters = {
  ...DEVIN_LORE_CONTEXT_DELIMITERS,
};

function roleFromType(type: DevinMessageType | undefined): AgentMessage["role"] {
  switch (type) {
    case "user_message":
      return "user";
    case "devin_message":
    case "assistant_message":
      return "assistant";
    case "tool_message":
      return "tool";
    case "system_message":
    case undefined:
      return "system";
  }
}

export function mapDevinMessage(message: DevinMessage): AgentMessage {
  const content = message.content ?? message.message;
  if (content === undefined) {
    throw new Error("A Devin message requires content or message");
  }
  const role =
    message.role === undefined
      ? roleFromType(message.type)
      : message.role === "devin"
        ? "assistant"
        : message.role === "human"
          ? "user"
          : message.role;
  const id = message.id ?? message.messageId;
  return {
    role,
    content,
    ...(id === undefined ? {} : { id }),
    ...(message.timestamp === undefined
      ? {}
      : { timestamp: message.timestamp }),
  };
}

export function devinSessionToInteraction(
  input: DevinSessionInput,
): AgentInteraction {
  const messages = [
    ...(input.message === undefined ? [] : [input.message]),
    ...(input.event === undefined ? [] : [input.event]),
    ...(input.messages ?? []),
    ...(input.events ?? []),
  ].map(mapDevinMessage);
  if (input.prompt !== undefined) {
    messages.push({ role: "user", content: input.prompt });
  }
  if (input.response !== undefined) {
    messages.push({ role: "assistant", content: input.response });
  }
  const sessionId = input.sessionId ?? input.session_id;
  return toSharedInteraction(
    {
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.organization === undefined
        ? {}
        : { organization: input.organization }),
      ...(input.project === undefined ? {} : { project: input.project }),
      ...(input.repo === undefined ? {} : { repo: input.repo }),
      ...(input.path === undefined ? {} : { path: input.path }),
      ...(input.component === undefined ? {} : { component: input.component }),
      ...(sessionId === undefined ? {} : { sessionId }),
      messages,
    },
    "devin",
  );
}

export function devinTaskToSharedTask(input: DevinTaskInput): AgentTask {
  const fallback =
    input.review === true
      ? "Review the provided changes and report actionable correctness issues."
      : undefined;
  return toSharedTask(
    {
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.organization === undefined
        ? {}
        : { organization: input.organization }),
      ...(input.project === undefined ? {} : { project: input.project }),
      ...(input.repo === undefined ? {} : { repo: input.repo }),
      ...(input.path === undefined ? {} : { path: input.path }),
      ...(input.component === undefined ? {} : { component: input.component }),
      ...(input.task === undefined ? {} : { task: input.task }),
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      ...(input.instruction === undefined
        ? {}
        : { instruction: input.instruction }),
      ...(input.task === undefined &&
      input.prompt === undefined &&
      input.instruction === undefined &&
      fallback !== undefined
        ? { task: fallback }
        : {}),
      ...(input.diff === undefined ? {} : { diff: input.diff }),
      ...(input.files === undefined ? {} : { files: input.files }),
      ...(input.components === undefined
        ? {}
        : { components: input.components }),
      ...(input.symbols === undefined ? {} : { symbols: input.symbols }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    },
    "devin",
  );
}

export class DevinAdapter
  implements
    AgentAdapter<DevinSessionInput, DevinTaskInput, DevinPreparedInstruction>
{
  readonly id = "devin";
  readonly #client: SharedMemoryClient;

  constructor(options: DevinAdapterOptions) {
    this.#client = createAdapterClient(options);
  }

  toInteraction(input: DevinSessionInput): AgentInteraction {
    return devinSessionToInteraction(input);
  }

  toTask(input: DevinTaskInput): AgentTask {
    return devinTaskToSharedTask(input);
  }

  async observe(input: DevinSessionInput): Promise<ObserveResponse> {
    return this.#client.observe(this.toInteraction(input));
  }

  async getContext(input: DevinTaskInput): Promise<Memory[]> {
    const response = await this.#client.getContext(this.toTask(input));
    return response.memories;
  }

  formatContext(memories: readonly Memory[]): string {
    return formatMemoryList(memories, (memory) => `- ${memory.content}`);
  }

  async prepareTask(input: DevinTaskInput): Promise<DevinPreparedInstruction> {
    const task = this.toTask(input);
    const response = await this.#client.getContext(task);
    const memories = response.memories;
    return {
      instruction: injectSharedMemory(
        task.task,
        response.context,
        DEVIN_SHARED_MEMORY_DELIMITERS,
      ),
      task,
      memories,
      kind: input.review === true ? "review" : "task",
    };
  }
}
