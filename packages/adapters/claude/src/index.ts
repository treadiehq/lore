import {
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

export type ClaudeMessageRole =
  | AgentMessage["role"]
  | "human"
  | "developer";

export interface ClaudeDevelopmentMessage {
  role: ClaudeMessageRole;
  content: string;
  id?: string;
  timestamp?: string;
}

export interface ClaudeDevelopmentSessionInput extends AdapterScopeInput {
  sessionId?: string;
  session_id?: string;
  conversationId?: string;
  messages?: readonly ClaudeDevelopmentMessage[];
  transcript?: readonly ClaudeDevelopmentMessage[];
  prompt?: string;
  response?: string;
}

export type ClaudeTaskInput = AdapterTaskInput;

export interface ClaudePreparedPrompt {
  prompt: string;
  task: AgentTask;
  memories: Memory[];
}

export type ClaudeAdapterOptions = SharedMemoryAdapterOptions;

export const CLAUDE_SHARED_MEMORY_DELIMITERS: SharedMemoryDelimiters = {
  start: "<relevant_engineering_knowledge>",
  end: "</relevant_engineering_knowledge>",
};

export function mapClaudeDevelopmentMessage(
  message: ClaudeDevelopmentMessage,
): AgentMessage {
  const role =
    message.role === "human"
      ? "user"
      : message.role === "developer"
        ? "system"
        : message.role;
  return {
    role,
    content: message.content,
    ...(message.id === undefined ? {} : { id: message.id }),
    ...(message.timestamp === undefined
      ? {}
      : { timestamp: message.timestamp }),
  };
}

export function claudeSessionToInteraction(
  input: ClaudeDevelopmentSessionInput,
): AgentInteraction {
  const messages = [
    ...(input.messages ?? []),
    ...(input.transcript ?? []),
  ].map(mapClaudeDevelopmentMessage);
  if (input.prompt !== undefined) {
    messages.push({ role: "user", content: input.prompt });
  }
  if (input.response !== undefined) {
    messages.push({ role: "assistant", content: input.response });
  }
  const sessionId =
    input.sessionId ?? input.session_id ?? input.conversationId;
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
    "claude",
  );
}

export function claudeTaskToSharedTask(input: ClaudeTaskInput): AgentTask {
  return toSharedTask(input, "claude");
}

export class ClaudeAdapter
  implements
    AgentAdapter<
      ClaudeDevelopmentSessionInput,
      ClaudeTaskInput,
      ClaudePreparedPrompt
    >
{
  readonly id = "claude";
  readonly #client: SharedMemoryClient;

  constructor(options: ClaudeAdapterOptions) {
    this.#client = createAdapterClient(options);
  }

  toInteraction(input: ClaudeDevelopmentSessionInput): AgentInteraction {
    return claudeSessionToInteraction(input);
  }

  toTask(input: ClaudeTaskInput): AgentTask {
    return claudeTaskToSharedTask(input);
  }

  async observe(
    input: ClaudeDevelopmentSessionInput,
  ): Promise<ObserveResponse> {
    return this.#client.observe(this.toInteraction(input));
  }

  async getContext(input: ClaudeTaskInput): Promise<Memory[]> {
    const response = await this.#client.getContext(this.toTask(input));
    return response.memories;
  }

  formatContext(memories: readonly Memory[]): string {
    return formatMemoryList(
      memories,
      (memory) => `- ${memory.content} [${memory.category}]`,
    );
  }

  async prepareTask(input: ClaudeTaskInput): Promise<ClaudePreparedPrompt> {
    const task = this.toTask(input);
    const response = await this.#client.getContext(task);
    const memories = response.memories;
    return {
      prompt: injectSharedMemory(
        task.task,
        response.context,
        CLAUDE_SHARED_MEMORY_DELIMITERS,
      ),
      task,
      memories,
    };
  }
}
