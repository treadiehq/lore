import {
  ListMemoriesDtoSchema,
  MemorySchema,
  MemoryUpdateSchema,
  type InsertMemoryResult,
  type ListMemoriesDto,
  type ListMemoriesResponse,
  type Memory,
  type MemoryScope,
  type MemoryUpdate,
} from "./schemas.js";
import type {
  FindActiveCandidatesOptions,
  MemoryRepository,
  SupersedeMemoryResult,
} from "./ports.js";
import { createMemoryFingerprint } from "./engine.js";

function copyMemory(memory: Memory): Memory {
  return structuredClone(memory);
}

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

  constructor(initialMemories: readonly Memory[] = []) {
    for (const initialMemory of initialMemories) {
      const memory = MemorySchema.parse(initialMemory);
      if (
        memory.status === "active" &&
        this.#fingerprints.has(memory.fingerprint)
      ) {
        throw new Error(
          `Duplicate initial memory fingerprint: ${memory.fingerprint}`,
        );
      }
      this.#memories.set(memory.id, copyMemory(memory));
      if (memory.status === "active") {
        this.#fingerprints.set(memory.fingerprint, memory.id);
      }
    }
  }

  async insert(memoryInput: Memory): Promise<InsertMemoryResult> {
    const memory = MemorySchema.parse(memoryInput);
    const existingId = this.#fingerprints.get(memory.fingerprint);
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
    this.#fingerprints.set(memory.fingerprint, memory.id);
    return { memory: copyMemory(memory), inserted: true };
  }

  async get(id: string): Promise<Memory | null> {
    const memory = this.#memories.get(id);
    return memory === undefined ? null : copyMemory(memory);
  }

  async list(input: ListMemoriesDto = {}): Promise<ListMemoriesResponse> {
    const filters = ListMemoriesDtoSchema.parse(input);
    const categories = toArray(filters.category);
    const statuses = toArray(filters.status);
    const query = filters.query?.toLocaleLowerCase();
    const offset = filters.offset ?? 0;
    const limit = filters.limit ?? 50;

    const matching = [...this.#memories.values()]
      .filter((memory) => {
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

  async update(id: string, updateInput: MemoryUpdate): Promise<Memory | null> {
    const current = this.#memories.get(id);
    if (current === undefined) {
      return null;
    }

    const update = MemoryUpdateSchema.parse(updateInput);
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
    if (next.status === "active") {
      const existingId = this.#fingerprints.get(next.fingerprint);
      if (existingId !== undefined && existingId !== id) {
        throw new Error(
          `Memory fingerprint already exists: ${next.fingerprint}`,
        );
      }
    }
    if (current.status === "active") {
      this.#fingerprints.delete(current.fingerprint);
    }
    if (next.status === "active") {
      this.#fingerprints.set(next.fingerprint, id);
    }
    this.#memories.set(id, copyMemory(next));
    return copyMemory(next);
  }

  async softDelete(
    id: string,
    deletedAt = new Date().toISOString(),
  ): Promise<Memory | null> {
    const current = this.#memories.get(id);
    if (current === undefined) {
      return null;
    }
    if (current.status === "deleted") {
      return copyMemory(current);
    }

    return this.update(id, {
      status: "deleted",
      deletedAt,
      updatedAt: deletedAt,
    });
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
  ): Promise<SupersedeMemoryResult> {
    const current = this.#memories.get(memoryId);
    if (current === undefined) {
      throw new Error(`Memory not found: ${memoryId}`);
    }

    const replacement = MemorySchema.parse(replacementInput);
    if (replacement.supersedesMemoryId !== memoryId) {
      throw new Error("Replacement must reference the memory it supersedes");
    }

    const existingId = this.#fingerprints.get(replacement.fingerprint);
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
    if (current.status !== "active") {
      throw new Error(
        `Only active memories can be superseded: ${memoryId} is ${current.status}`,
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
      this.#fingerprints.set(replacement.fingerprint, replacement.id);
      storedReplacement = replacement;
    }

    const timestamp = replacement.createdAt;
    const superseded = MemorySchema.parse({
      ...current,
      status: "superseded",
      updatedAt: timestamp,
    });
    this.#fingerprints.delete(current.fingerprint);
    this.#memories.set(memoryId, copyMemory(superseded));

    return {
      memory: copyMemory(storedReplacement),
      supersededMemory: copyMemory(superseded),
    };
  }
}
