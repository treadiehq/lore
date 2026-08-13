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

export type CodexMessageRole = AgentMessage["role"] | "developer";

export interface CodexMessage {
  role: CodexMessageRole;
  content: string;
  id?: string;
  timestamp?: string;
}

export interface CodexObservationInput extends AdapterScopeInput {
  sessionId?: string;
  threadId?: string;
  messages?: readonly CodexMessage[];
  prompt?: string;
  response?: string;
}

export interface CodexTaskInput extends AdapterTaskInput {
  review?: boolean;
}

export interface CodexReviewTaskInput extends AdapterScopeInput {
  task?: string;
  diff?: string;
  files?: readonly string[];
  components?: readonly string[];
  symbols?: readonly string[];
  limit?: number;
}

export interface CodexPreparedPrompt {
  prompt: string;
  task: AgentTask;
  memories: Memory[];
  kind: "task" | "review";
}

export type CodexAdapterOptions = SharedMemoryAdapterOptions;

export const CODEX_SHARED_MEMORY_DELIMITERS: SharedMemoryDelimiters = {
  start: "<relevant_engineering_knowledge>",
  end: "</relevant_engineering_knowledge>",
};

function mapCodexMessage(message: CodexMessage): AgentMessage {
  return {
    role: message.role === "developer" ? "system" : message.role,
    content: message.content,
    ...(message.id === undefined ? {} : { id: message.id }),
    ...(message.timestamp === undefined
      ? {}
      : { timestamp: message.timestamp }),
  };
}

export function codexObservationToInteraction(
  input: CodexObservationInput,
): AgentInteraction {
  const messages = (input.messages ?? []).map(mapCodexMessage);
  if (input.prompt !== undefined) {
    messages.push({ role: "user", content: input.prompt });
  }
  if (input.response !== undefined) {
    messages.push({ role: "assistant", content: input.response });
  }
  const sessionId = input.sessionId ?? input.threadId;
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
    "codex",
  );
}

export function codexTaskToSharedTask(input: CodexTaskInput): AgentTask {
  const fallback =
    input.review === true
      ? "Review the provided changes for actionable correctness issues."
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
    "codex",
  );
}

export function createCodexReviewTask(
  input: CodexReviewTaskInput,
): AgentTask {
  return codexTaskToSharedTask({
    ...input,
    review: true,
  });
}

export class CodexAdapter
  implements
    AgentAdapter<CodexObservationInput, CodexTaskInput, CodexPreparedPrompt>
{
  readonly id = "codex";
  readonly #client: SharedMemoryClient;

  constructor(options: CodexAdapterOptions) {
    this.#client = createAdapterClient(options);
  }

  toInteraction(input: CodexObservationInput): AgentInteraction {
    return codexObservationToInteraction(input);
  }

  toTask(input: CodexTaskInput): AgentTask {
    return codexTaskToSharedTask(input);
  }

  async observe(input: CodexObservationInput): Promise<ObserveResponse> {
    return this.#client.observe(this.toInteraction(input));
  }

  async getContext(input: CodexTaskInput): Promise<Memory[]> {
    const response = await this.#client.getContext(this.toTask(input));
    return response.memories;
  }

  formatContext(memories: readonly Memory[]): string {
    return formatMemoryList(
      memories,
      (memory) => `- [${memory.category}] ${memory.content}`,
    );
  }

  async prepareTask(input: CodexTaskInput): Promise<CodexPreparedPrompt> {
    const task = this.toTask(input);
    const response = await this.#client.getContext(task);
    const memories = response.memories;
    return {
      prompt: injectSharedMemory(
        task.task,
        response.context,
        CODEX_SHARED_MEMORY_DELIMITERS,
      ),
      task,
      memories,
      kind: input.review === true ? "review" : "task",
    };
  }
}
