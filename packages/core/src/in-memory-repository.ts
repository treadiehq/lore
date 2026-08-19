import {
  ListMemoriesDtoSchema,
  MemoryConflictSchema,
  MemorySchema,
  MemoryUpdateSchema,
  ProposalMetadataSchema,
  ReviewProposalDtoSchema,
  UpdateWorkspaceLearningPolicySchema,
  WorkspaceLearningPolicySchema,
  type InsertMemoryResult,
  type ListMemoriesDto,
  type ListMemoriesResponse,
  type Memory,
  type MemoryConflict,
  type MemoryScope,
  type MemoryUpdate,
  type ProposalMetadata,
  type ProposalRecord,
  type ProposeMemoryResult,
  type ReviewProposalDto,
  type ReviewProposalResponse,
  type UpdateWorkspaceLearningPolicy,
  type WorkspaceLearningPolicy,
} from "./schemas.js";
import type {
  FindActiveCandidatesOptions,
  InsertMemoryConflictResult,
  MemoryRepository,
  RepositoryContext,
  SupersedeMemoryResult,
  WorkspaceRepositoryContext,
} from "./ports.js";
import { createMemoryFingerprint } from "./engine.js";

function copyMemory(memory: Memory): Memory {
  return structuredClone(memory);
}

function copyProposalMetadata(metadata: ProposalMetadata): ProposalMetadata {
  return structuredClone(metadata);
}

function copyConflict(conflict: MemoryConflict): MemoryConflict {
  return structuredClone(conflict);
}

function memoryWorkspaceId(memory: Memory): string | undefined {
  return memory.workspaceId ?? memory.source.workspaceId;
}

function fingerprintKey(memory: Memory): string {
  return `${memoryWorkspaceId(memory) ?? ""}\0${memory.fingerprint}`;
}

function reservesFingerprint(memory: Memory): boolean {
  return (
    memory.status === "active" ||
    memory.status === "suppressed" ||
    memory.status === "proposed"
  );
}

function conflictEdgeKey(conflict: MemoryConflict): string {
  return [
    conflict.workspaceId,
    conflict.proposalMemoryId,
    conflict.targetMemoryId,
    conflict.detector,
  ].join("\0");
}

const DEFAULT_POLICY_UPDATED_AT = "1970-01-01T00:00:00.000Z";

function scopeValueMatches(
  memoryValue: string | undefined,
  taskValue: string | undefined,
): boolean {
  return memoryValue === undefined || memoryValue === taskValue;
}

export function memoryScopeAppliesTo(
  memoryScope: MemoryScope,
  taskScope: MemoryScope,
): boolean {
  return (
    scopeValueMatches(memoryScope.organization, taskScope.organization) &&
    scopeValueMatches(memoryScope.project, taskScope.project) &&
    scopeValueMatches(memoryScope.repo, taskScope.repo) &&
    scopeValueMatches(memoryScope.path, taskScope.path) &&
    scopeValueMatches(memoryScope.component, taskScope.component)
  );
}

function toArray<T>(value: T | T[] | undefined): T[] | undefined {
  return value === undefined ? undefined : Array.isArray(value) ? value : [value];
}

export class InMemoryMemoryRepository implements MemoryRepository {
  readonly #memories = new Map<string, Memory>();
  readonly #fingerprints = new Map<string, string>();
  readonly #proposalMetadata = new Map<string, ProposalMetadata>();
  readonly #conflicts = new Map<string, MemoryConflict>();
  readonly #conflictEdges = new Map<string, string>();
  readonly #policies = new Map<string, WorkspaceLearningPolicy>();

  constructor(initialMemories: readonly Memory[] = []) {
    for (const initialMemory of initialMemories) {
      const memory = MemorySchema.parse(initialMemory);
      if (
        reservesFingerprint(memory) &&
        this.#fingerprints.has(fingerprintKey(memory))
      ) {
        throw new Error(
          `Duplicate initial memory fingerprint: ${memory.fingerprint}`,
        );
      }
      this.#memories.set(memory.id, copyMemory(memory));
      if (reservesFingerprint(memory)) {
        this.#fingerprints.set(fingerprintKey(memory), memory.id);
      }
    }
  }

  async insert(memoryInput: Memory): Promise<InsertMemoryResult> {
    const memory = MemorySchema.parse(memoryInput);
    if (memory.status === "proposed") {
      throw new Error("Proposed memories must be inserted with proposal metadata");
    }
    const existingId = this.#fingerprints.get(fingerprintKey(memory));
    if (existingId !== undefined) {
      const existing = this.#memories.get(existingId);
      if (existing === undefined) {
        throw new Error("In-memory fingerprint index is inconsistent");
      }
      return { memory: copyMemory(existing), inserted: false };
    }

    if (this.#memories.has(memory.id)) {
      throw new Error(`Memory ID already exists: ${memory.id}`);
    }

    this.#memories.set(memory.id, copyMemory(memory));
    if (reservesFingerprint(memory)) {
      this.#fingerprints.set(fingerprintKey(memory), memory.id);
    }
    return { memory: copyMemory(memory), inserted: true };
  }

  async propose(
    memoryInput: Memory,
    metadataInput: ProposalMetadata,
    conflictInputs: readonly MemoryConflict[] = [],
  ): Promise<ProposeMemoryResult> {
    const memory = MemorySchema.parse(memoryInput);
    const metadata = ProposalMetadataSchema.parse(metadataInput);
    const conflicts = conflictInputs.map((conflict) =>
      MemoryConflictSchema.parse(conflict),
    );
    if (memory.status !== "proposed") {
      throw new Error("Proposal insertion requires proposed memory status");
    }
    if (
      metadata.memoryId !== memory.id ||
      metadata.workspaceId !== memoryWorkspaceId(memory)
    ) {
      throw new Error("Proposal metadata does not match its memory");
    }
    if (metadata.decision !== null) {
      throw new Error("New proposal metadata must be pending");
    }
    if (
      JSON.stringify(metadata.provenance) !== JSON.stringify(memory.source)
    ) {
      throw new Error("Proposal provenance does not match its memory source");
    }

    const existingId = this.#fingerprints.get(fingerprintKey(memory));
    if (existingId !== undefined) {
      const existing = this.#memories.get(existingId);
      if (existing === undefined) {
        throw new Error("In-memory fingerprint index is inconsistent");
      }
      const existingMetadata = this.#proposalMetadata.get(existing.id);
      return {
        memory: copyMemory(existing),
        metadata:
          existingMetadata === undefined
            ? null
            : copyProposalMetadata(existingMetadata),
        conflicts: this.#proposalConflicts(existing.id),
        inserted: false,
      };
    }
    if (this.#memories.has(memory.id)) {
      throw new Error(`Memory ID already exists: ${memory.id}`);
    }

    const conflictEdges = new Set<string>();
    for (const conflict of conflicts) {
      this.#validateNewConflict(conflict, memory);
      const edge = conflictEdgeKey(conflict);
      if (conflictEdges.has(edge)) {
        throw new Error("Duplicate conflict edge in proposal");
      }
      if (
        this.#conflicts.has(conflict.id) ||
        this.#conflictEdges.has(edge)
      ) {
        throw new Error("Proposal conflict already exists");
      }
      conflictEdges.add(edge);
    }
    this.#memories.set(memory.id, copyMemory(memory));
    this.#fingerprints.set(fingerprintKey(memory), memory.id);
    this.#proposalMetadata.set(memory.id, copyProposalMetadata(metadata));
    for (const conflict of conflicts) {
      this.#storeConflict(conflict);
    }
    return {
      memory: copyMemory(memory),
      metadata: copyProposalMetadata(metadata),
      conflicts: conflicts.map(copyConflict),
      inserted: true,
    };
  }

  async get(id: string, context: RepositoryContext = {}): Promise<Memory | null> {
    const memory = this.#memories.get(id);
    return memory === undefined ||
      (context.workspaceId !== undefined &&
        memory.workspaceId !== context.workspaceId)
      ? null
      : copyMemory(memory);
  }

  async getProposal(
    memoryId: string,
    context: RepositoryContext = {},
  ): Promise<ProposalRecord | null> {
    const memory = this.#memories.get(memoryId);
    const metadata = this.#proposalMetadata.get(memoryId);
    if (
      memory === undefined ||
      metadata === undefined ||
      (context.workspaceId !== undefined &&
        memoryWorkspaceId(memory) !== context.workspaceId)
    ) {
      return null;
    }
    return {
      memory: copyMemory(memory),
      metadata: copyProposalMetadata(metadata),
      conflicts: this.#proposalConflicts(memoryId),
    };
  }

  async addProposalConflict(
    conflictInput: MemoryConflict,
    context: WorkspaceRepositoryContext,
  ): Promise<InsertMemoryConflictResult> {
    const conflict = MemoryConflictSchema.parse(conflictInput);
    if (conflict.workspaceId !== context.workspaceId) {
      throw new Error("Conflict workspace does not match repository context");
    }
    this.#validateNewConflict(conflict);
    const existingId = this.#conflictEdges.get(conflictEdgeKey(conflict));
    if (existingId !== undefined) {
      const existing = this.#conflicts.get(existingId);
      if (existing === undefined) {
        throw new Error("In-memory conflict index is inconsistent");
      }
      return { conflict: copyConflict(existing), inserted: false };
    }
    this.#storeConflict(conflict);
    return { conflict: copyConflict(conflict), inserted: true };
  }

  async reviewProposal(
    inputValue: ReviewProposalDto,
    context: WorkspaceRepositoryContext,
  ): Promise<ReviewProposalResponse> {
    const input = ReviewProposalDtoSchema.parse(inputValue);
    const current = this.#memories.get(input.proposalMemoryId);
    const metadata = this.#proposalMetadata.get(input.proposalMemoryId);
    if (
      current === undefined ||
      metadata === undefined ||
      memoryWorkspaceId(current) !== context.workspaceId
    ) {
      throw new Error(`Proposal not found: ${input.proposalMemoryId}`);
    }
    if (metadata.decision !== null || current.status !== "proposed") {
      throw new Error(`Proposal has already been resolved: ${current.id}`);
    }

    const openConflicts = this.#proposalConflicts(current.id).filter(
      (conflict) => conflict.resolution === null,
    );
    const blocking = openConflicts.filter(
      (conflict) => conflict.severity === "blocking",
    );
    if (
      input.decision === "approve" &&
      (blocking.length > 0 || current.supersedesMemoryId !== null)
    ) {
      throw new Error("Blocked proposals cannot be approved without resolution");
    }

    let target: Memory | undefined;
    if (input.decision === "use_proposal") {
      const targetId = input.targetMemoryId;
      const deterministicConflict = openConflicts.find(
        (conflict) =>
          conflict.targetMemoryId === targetId &&
          conflict.detector === "deterministic" &&
          conflict.severity === "blocking",
      );
      if (deterministicConflict === undefined) {
        throw new Error(
          "Using a proposal requires an open deterministic blocking conflict",
        );
      }
      if (
        blocking.some((conflict) => conflict.targetMemoryId !== targetId)
      ) {
        throw new Error(
          "Proposal has additional blocking conflicts that require keep_both or reject",
        );
      }
      target = targetId === undefined ? undefined : this.#memories.get(targetId);
      if (
        target === undefined ||
        memoryWorkspaceId(target) !== context.workspaceId ||
        (target.status !== "active" && target.status !== "suppressed")
      ) {
        throw new Error(`Conflict target is not replaceable: ${targetId}`);
      }
      if (
        current.supersedesMemoryId !== null &&
        current.supersedesMemoryId !== target.id
      ) {
        throw new Error("Proposal lineage does not match the conflict target");
      }
    }

    const decidedAt = new Date().toISOString();
    const supersedesMemoryId =
      input.decision === "use_proposal" ? (target?.id ?? null) : null;
    const status = input.decision === "reject" ? "deleted" : "active";
    const next = MemorySchema.parse({
      ...current,
      status,
      scope: input.scope ?? current.scope,
      supersedesMemoryId,
      fingerprint: createMemoryFingerprint({
        content: current.content,
        scope: input.scope ?? current.scope,
        category: current.category,
        supersedesMemoryId,
      }),
      updatedAt: decidedAt,
      suppressedAt: null,
      deletedAt: input.decision === "reject" ? decidedAt : null,
    });
    if (reservesFingerprint(next)) {
      const existingId = this.#fingerprints.get(fingerprintKey(next));
      if (
        existingId !== undefined &&
        existingId !== current.id &&
        existingId !== target?.id
      ) {
        throw new Error(
          `Memory fingerprint already exists: ${next.fingerprint}`,
        );
      }
    }

    let supersededMemory: Memory | null = null;
    if (target !== undefined) {
      supersededMemory = MemorySchema.parse({
        ...target,
        status: "superseded",
        updatedAt: decidedAt,
        suppressedAt: null,
      });
      if (reservesFingerprint(target)) {
        this.#fingerprints.delete(fingerprintKey(target));
      }
      this.#memories.set(target.id, copyMemory(supersededMemory));
    }

    if (reservesFingerprint(current)) {
      this.#fingerprints.delete(fingerprintKey(current));
    }
    if (reservesFingerprint(next)) {
      this.#fingerprints.set(fingerprintKey(next), next.id);
    }
    this.#memories.set(next.id, copyMemory(next));

    const nextMetadata = ProposalMetadataSchema.parse({
      ...metadata,
      decision: input.decision,
      reviewerId: input.reviewerId,
      decisionReason: input.reason,
      decidedAt,
      decisionTargetMemoryId: target?.id ?? null,
    });
    this.#proposalMetadata.set(next.id, copyProposalMetadata(nextMetadata));

    const resolvedConflicts = openConflicts.map((conflict) =>
      MemoryConflictSchema.parse({
        ...conflict,
        resolution: input.decision,
        resolvedAt: decidedAt,
      }),
    );
    for (const conflict of resolvedConflicts) {
      this.#conflicts.set(conflict.id, copyConflict(conflict));
    }

    return {
      proposal: copyMemory(next),
      metadata: copyProposalMetadata(nextMetadata),
      conflicts: this.#proposalConflicts(next.id),
      supersededMemory:
        supersededMemory === null ? null : copyMemory(supersededMemory),
    };
  }

  async getWorkspaceLearningPolicy(
    workspaceId: string,
  ): Promise<WorkspaceLearningPolicy> {
    const stored = this.#policies.get(workspaceId);
    return structuredClone(
      stored ??
        WorkspaceLearningPolicySchema.parse({
          workspaceId,
          learningMode: "trust_tiered",
          llmConflictAnalysisEnabled: false,
          updatedAt: DEFAULT_POLICY_UPDATED_AT,
        }),
    );
  }

  async updateWorkspaceLearningPolicy(
    workspaceId: string,
    updateInput: UpdateWorkspaceLearningPolicy,
  ): Promise<WorkspaceLearningPolicy> {
    const update = UpdateWorkspaceLearningPolicySchema.parse(updateInput);
    const current = await this.getWorkspaceLearningPolicy(workspaceId);
    const next = WorkspaceLearningPolicySchema.parse({
      ...current,
      ...update,
      workspaceId,
      updatedAt: new Date().toISOString(),
    });
    this.#policies.set(workspaceId, structuredClone(next));
    return structuredClone(next);
  }

  #proposalConflicts(proposalMemoryId: string): MemoryConflict[] {
    return [...this.#conflicts.values()]
      .filter((conflict) => conflict.proposalMemoryId === proposalMemoryId)
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      )
      .map(copyConflict);
  }

  #validateNewConflict(
    conflict: MemoryConflict,
    unstoredProposal?: Memory,
  ): void {
    if (conflict.resolution !== null) {
      throw new Error("New conflicts must be unresolved");
    }
    const proposal =
      unstoredProposal?.id === conflict.proposalMemoryId
        ? unstoredProposal
        : this.#memories.get(conflict.proposalMemoryId);
    const target = this.#memories.get(conflict.targetMemoryId);
    if (proposal === undefined || proposal.status !== "proposed") {
      throw new Error(`Proposed memory not found: ${conflict.proposalMemoryId}`);
    }
    if (
      conflict.workspaceId !== memoryWorkspaceId(proposal) ||
      target === undefined ||
      memoryWorkspaceId(target) !== conflict.workspaceId
    ) {
      throw new Error("Conflict memories must belong to the same workspace");
    }
    if (target.status !== "active" && target.status !== "suppressed") {
      throw new Error(`Conflict target is not reviewable: ${target.id}`);
    }
  }

  #storeConflict(conflict: MemoryConflict): void {
    const edge = conflictEdgeKey(conflict);
    const existingId = this.#conflictEdges.get(edge);
    if (existingId !== undefined && existingId !== conflict.id) {
      throw new Error("Conflict edge already exists");
    }
    if (this.#conflicts.has(conflict.id)) {
      throw new Error(`Conflict ID already exists: ${conflict.id}`);
    }
    this.#conflicts.set(conflict.id, copyConflict(conflict));
    this.#conflictEdges.set(edge, conflict.id);
  }

  async list(
    input: ListMemoriesDto = {},
    context: RepositoryContext = {},
  ): Promise<ListMemoriesResponse> {
    const filters = ListMemoriesDtoSchema.parse(input);
    const categories = toArray(filters.category);
    const statuses = toArray(filters.status);
    const query = filters.query?.toLocaleLowerCase();
    const offset = filters.offset ?? 0;
    const limit = filters.limit ?? 50;

    const matching = [...this.#memories.values()]
      .filter((memory) => {
        if (
          context.workspaceId !== undefined &&
          memory.workspaceId !== context.workspaceId
        ) {
          return false;
        }
        if (
          filters.scope !== undefined &&
          !memoryScopeAppliesTo(filters.scope, memory.scope)
        ) {
          return false;
        }
        if (
          categories !== undefined &&
          !categories.includes(memory.category)
        ) {
          return false;
        }
        if (statuses !== undefined && !statuses.includes(memory.status)) {
          return false;
        }
        return (
          query === undefined ||
          memory.content.toLocaleLowerCase().includes(query)
        );
      })
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          left.id.localeCompare(right.id),
      );

    return {
      memories: matching.slice(offset, offset + limit).map(copyMemory),
      total: matching.length,
      limit,
      offset,
    };
  }

  async update(
    id: string,
    updateInput: MemoryUpdate,
    context: RepositoryContext = {},
  ): Promise<Memory | null> {
    const current = this.#memories.get(id);
    if (
      current === undefined ||
      (context.workspaceId !== undefined &&
        current.workspaceId !== context.workspaceId)
    ) {
      return null;
    }

    const update = MemoryUpdateSchema.parse(updateInput);
    if (
      update.status !== undefined &&
      (current.status === "proposed" || update.status === "proposed") &&
      update.status !== current.status
    ) {
      throw new Error("Proposed memories must be resolved with reviewProposal");
    }
    const content = update.content ?? current.content;
    const scope = update.scope ?? current.scope;
    const category = update.category ?? current.category;
    const supersedesMemoryId =
      update.supersedesMemoryId === undefined
        ? current.supersedesMemoryId
        : update.supersedesMemoryId;
    const shouldRecalculateFingerprint =
      update.fingerprint === undefined &&
      (update.content !== undefined ||
        update.scope !== undefined ||
        update.category !== undefined ||
        update.supersedesMemoryId !== undefined);
    const fingerprint = shouldRecalculateFingerprint
      ? createMemoryFingerprint({
          content,
          scope,
          category,
          supersedesMemoryId,
        })
      : (update.fingerprint ?? current.fingerprint);
    const next = MemorySchema.parse({
      ...current,
      ...update,
      id,
      content,
      scope,
      category,
      supersedesMemoryId,
      fingerprint,
      updatedAt: update.updatedAt ?? new Date().toISOString(),
    });
    if (reservesFingerprint(next)) {
      const existingId = this.#fingerprints.get(fingerprintKey(next));
      if (existingId !== undefined && existingId !== id) {
        throw new Error(
          `Memory fingerprint already exists: ${next.fingerprint}`,
        );
      }
    }
    if (reservesFingerprint(current)) {
      this.#fingerprints.delete(fingerprintKey(current));
    }
    if (reservesFingerprint(next)) {
      this.#fingerprints.set(fingerprintKey(next), id);
    }
    this.#memories.set(id, copyMemory(next));
    return copyMemory(next);
  }

  async softDelete(
    id: string,
    deletedAt = new Date().toISOString(),
    context: RepositoryContext = {},
  ): Promise<Memory | null> {
    const current = this.#memories.get(id);
    if (
      current === undefined ||
      (context.workspaceId !== undefined &&
        current.workspaceId !== context.workspaceId)
    ) {
      return null;
    }
    if (current.status === "deleted") {
      return copyMemory(current);
    }

    return this.update(
      id,
      {
        status: "deleted",
        suppressedAt: null,
        deletedAt,
        updatedAt: deletedAt,
      },
      context,
    );
  }

  async findActiveScopeCandidates(
    scope: MemoryScope,
    options: FindActiveCandidatesOptions = {},
  ): Promise<Memory[]> {
    const keywords = options.keywords
      ?.map((keyword) => keyword.trim().toLocaleLowerCase())
      .filter((keyword) => keyword.length > 0);
    const limit = options.limit ?? 100;
    const paths = [
      ...new Set(
        [scope.path, ...(options.paths ?? [])].filter(
          (value): value is string => value !== undefined,
        ),
      ),
    ];
    const components = new Set(
      [scope.component, ...(options.components ?? [])].filter(
        (value): value is string => value !== undefined,
      ),
    );

    return [...this.#memories.values()]
      .filter(
        (memory) =>
          memory.status === "active" &&
          (options.workspaceId === undefined ||
            memory.workspaceId === options.workspaceId) &&
          memory.scope.organization === scope.organization &&
          scopeValueMatches(memory.scope.project, scope.project) &&
          scopeValueMatches(memory.scope.repo, scope.repo) &&
          (memory.scope.path === undefined ||
            paths.some(
              (path) =>
                path === memory.scope.path ||
                path.startsWith(`${memory.scope.path}/`),
            )) &&
          (memory.scope.component === undefined ||
            components.has(memory.scope.component)) &&
          (options.requirePathOrComponentMatch !== true ||
            (memory.scope.path !== undefined &&
              paths.some(
                (path) =>
                  path === memory.scope.path ||
                  path.startsWith(`${memory.scope.path}/`),
              )) ||
            (memory.scope.component !== undefined &&
              components.has(memory.scope.component))) &&
          (keywords === undefined ||
            keywords.length === 0 ||
            keywords.some((keyword) =>
              memory.content.toLocaleLowerCase().includes(keyword),
            )),
      )
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, limit)
      .map(copyMemory);
  }

  async supersede(
    memoryId: string,
    replacementInput: Memory,
    context: RepositoryContext = {},
  ): Promise<SupersedeMemoryResult> {
    const current = this.#memories.get(memoryId);
    if (
      current === undefined ||
      (context.workspaceId !== undefined &&
        current.workspaceId !== context.workspaceId)
    ) {
      throw new Error(`Memory not found: ${memoryId}`);
    }

    const replacement = MemorySchema.parse(replacementInput);
    if (replacement.supersedesMemoryId !== memoryId) {
      throw new Error("Replacement must reference the memory it supersedes");
    }

    const existingId = this.#fingerprints.get(fingerprintKey(replacement));
    if (current.status === "superseded") {
      const existing =
        existingId === undefined ? undefined : this.#memories.get(existingId);
      if (existing?.supersedesMemoryId === memoryId) {
        return {
          memory: copyMemory(existing),
          supersededMemory: copyMemory(current),
        };
      }
      throw new Error(`Memory has already been superseded: ${memoryId}`);
    }
    if (current.status !== "active" && current.status !== "suppressed") {
      throw new Error(
        `Only active or suppressed memories can be superseded: ${memoryId} is ${current.status}`,
      );
    }

    let storedReplacement: Memory;
    if (existingId !== undefined) {
      const existing = this.#memories.get(existingId);
      if (existing === undefined) {
        throw new Error("In-memory fingerprint index is inconsistent");
      }
      if (existing.supersedesMemoryId !== memoryId) {
        throw new Error(
          "Replacement fingerprint belongs to an unrelated memory",
        );
      }
      storedReplacement = existing;
    } else {
      if (this.#memories.has(replacement.id)) {
        throw new Error(`Memory ID already exists: ${replacement.id}`);
      }
      this.#memories.set(replacement.id, copyMemory(replacement));
      this.#fingerprints.set(fingerprintKey(replacement), replacement.id);
      storedReplacement = replacement;
    }

    const timestamp = replacement.createdAt;
    const superseded = MemorySchema.parse({
      ...current,
      status: "superseded",
      updatedAt: timestamp,
      suppressedAt: null,
    });
    this.#fingerprints.delete(fingerprintKey(current));
    this.#memories.set(memoryId, copyMemory(superseded));

    return {
      memory: copyMemory(storedReplacement),
      supersededMemory: copyMemory(superseded),
    };
  }
}
