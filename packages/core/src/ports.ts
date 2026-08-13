import type {
  AgentInteraction,
  AgentTask,
  CandidateMemory,
  InsertMemoryResult,
  ListMemoriesDto,
  ListMemoriesResponse,
  Memory,
  MemoryScope,
  MemoryUpdate,
  ObserveResponse,
} from "./schemas.js";

export interface FindActiveCandidatesOptions {
  workspaceId?: string;
  keywords?: readonly string[];
  paths?: readonly string[];
  components?: readonly string[];
  limit?: number;
}

export interface SupersedeMemoryResult {
  memory: Memory;
  supersededMemory: Memory;
}

export interface MemoryRepository {
  insert(memory: Memory): Promise<InsertMemoryResult>;
  get(id: string): Promise<Memory | null>;
  list(input?: ListMemoriesDto): Promise<ListMemoriesResponse>;
  update(id: string, update: MemoryUpdate): Promise<Memory | null>;
  softDelete(id: string, deletedAt?: string): Promise<Memory | null>;
  findActiveScopeCandidates(
    scope: MemoryScope,
    options?: FindActiveCandidatesOptions,
  ): Promise<Memory[]>;
  supersede(
    memoryId: string,
    replacement: Memory,
  ): Promise<SupersedeMemoryResult>;
}

export interface MemoryExtractor {
  extract(interaction: AgentInteraction): Promise<CandidateMemory[]>;
}
export interface LearningExtractor extends MemoryExtractor {}

export interface MemoryRetriever {
  retrieve(
    task: AgentTask,
    context?: { workspaceId?: string },
  ): Promise<Memory[]>;
}
export interface LearningRetriever extends MemoryRetriever {}

export interface AgentAdapter<
  TInteraction = unknown,
  TTask = unknown,
  TPreparedTask = unknown,
> {
  readonly id: string;
  observe(input: TInteraction): Promise<ObserveResponse>;
  getContext(input: TTask): Promise<Memory[]>;
  formatContext(memories: readonly Memory[]): string | Promise<string>;
  prepareTask?(
    input: TTask,
  ): TPreparedTask | Promise<TPreparedTask>;
  toInteraction?(
    input: TInteraction,
  ): AgentInteraction | Promise<AgentInteraction>;
  toTask?(input: TTask): AgentTask | Promise<AgentTask>;
}
