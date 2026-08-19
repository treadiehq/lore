import type {
  AgentInteraction,
  AgentTask,
  CandidateMemory,
  DetectedMemoryConflict,
  InsertMemoryResult,
  ListMemoriesDto,
  ListMemoriesResponse,
  Memory,
  MemoryConflictAnalysis,
  MemoryConflict,
  MemoryScope,
  MemoryUpdate,
  ObserveResponse,
  ProposalMetadata,
  ProposalRecord,
  ProposeMemoryResult,
  ReviewProposalDto,
  ReviewProposalResponse,
  RetrievalHit,
  UpdateWorkspaceLearningPolicy,
  WorkspaceLearningPolicy,
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

export interface WorkspaceRepositoryContext {
  workspaceId: string;
}

export interface MemoryConflictDetectionInput {
  proposal: Memory;
  deterministicTarget?: Memory;
  policy: WorkspaceLearningPolicy;
}

export interface MemoryConflictDetector {
  detect(
    input: MemoryConflictDetectionInput,
    context: WorkspaceRepositoryContext,
  ): Promise<readonly DetectedMemoryConflict[]>;
}

export interface MemoryConflictAnalyzer {
  analyze(input: {
    proposal: Memory;
    target: Memory;
  }): Promise<MemoryConflictAnalysis>;
}

export interface InsertMemoryConflictResult {
  conflict: MemoryConflict;
  inserted: boolean;
}

export interface MemoryRepository {
  insert(memory: Memory): Promise<InsertMemoryResult>;
  propose(
    memory: Memory,
    metadata: ProposalMetadata,
    conflicts?: readonly MemoryConflict[],
  ): Promise<ProposeMemoryResult>;
  get(id: string, context?: RepositoryContext): Promise<Memory | null>;
  getProposal(
    memoryId: string,
    context?: RepositoryContext,
  ): Promise<ProposalRecord | null>;
  addProposalConflict(
    conflict: MemoryConflict,
    context: WorkspaceRepositoryContext,
  ): Promise<InsertMemoryConflictResult>;
  reviewProposal(
    input: ReviewProposalDto,
    context: WorkspaceRepositoryContext,
  ): Promise<ReviewProposalResponse>;
  getWorkspaceLearningPolicy(
    workspaceId: string,
  ): Promise<WorkspaceLearningPolicy>;
  updateWorkspaceLearningPolicy(
    workspaceId: string,
    update: UpdateWorkspaceLearningPolicy,
  ): Promise<WorkspaceLearningPolicy>;
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
