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
  RetrievalHit,
} from "./schemas.js";

export interface FindActiveCandidatesOptions {
  workspaceId?: string;
  keywords?: readonly string[];
  paths?: readonly string[];
  components?: readonly string[];
  requirePathOrComponentMatch?: boolean;
  limit?: number;
}

export interface SupersedeMemoryResult {
  memory: Memory;
  supersededMemory: Memory;
}

export interface RepositoryContext {
  workspaceId?: string;
}

export interface MemoryRepository {
  insert(memory: Memory): Promise<InsertMemoryResult>;
  get(id: string, context?: RepositoryContext): Promise<Memory | null>;
  list(
    input?: ListMemoriesDto,
    context?: RepositoryContext,
  ): Promise<ListMemoriesResponse>;
  update(
    id: string,
    update: MemoryUpdate,
    context?: RepositoryContext,
  ): Promise<Memory | null>;
  softDelete(
    id: string,
    deletedAt?: string,
    context?: RepositoryContext,
  ): Promise<Memory | null>;
  findActiveScopeCandidates(
    scope: MemoryScope,
    options?: FindActiveCandidatesOptions,
  ): Promise<Memory[]>;
  supersede(
    memoryId: string,
    replacement: Memory,
    context?: RepositoryContext,
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
  ): Promise<RetrievalHit[]>;
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
