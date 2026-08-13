import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  SharedMemoryEngine,
  type AuthenticatedWorkspace,
  type CorrectMemoryDto,
  type CorrectMemoryResponse,
  type CreateMemoryDto,
  type ForgetMemoryResponse,
  type GetMemoryResponse,
  type LearningInspectionResponse,
  type ListMemoriesDto,
  type ListMemoriesResponse,
  type MemoryRepository,
  type MemoryUpdate,
  type RememberResponse,
  type UpdateMemoryResponse,
} from "@lore-co/core";
import type { PostgresPilotRepository } from "@lore-co/database";
import {
  MEMORY_REPOSITORY,
  MEMORY_EMBEDDING_INDEXER,
  PILOT_REPOSITORY,
  SHARED_MEMORY_ENGINE,
} from "../common/tokens.js";
import type { EmbeddingIndexerService } from "../retrieval/embedding-indexer.service.js";

function throwMappedMemoryError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/memory not found|memory disappeared/iu.test(message)) {
    throw new NotFoundException(message);
  }
  if (
    /only active|already been superseded|fingerprint|duplicate|unique/iu.test(
      message,
    )
  ) {
    throw new ConflictException(message);
  }
  throw error;
}

@Injectable()
export class MemoryService {
  readonly #engine: SharedMemoryEngine;
  readonly #repository: MemoryRepository;
  readonly #pilotRepository: PostgresPilotRepository;
  readonly #indexer: EmbeddingIndexerService;

  constructor(
    @Inject(SHARED_MEMORY_ENGINE) engine: SharedMemoryEngine,
    @Inject(MEMORY_REPOSITORY) repository: MemoryRepository,
    @Inject(PILOT_REPOSITORY) pilotRepository: PostgresPilotRepository,
    @Inject(MEMORY_EMBEDDING_INDEXER) indexer: EmbeddingIndexerService,
  ) {
    this.#engine = engine;
    this.#repository = repository;
    this.#pilotRepository = pilotRepository;
    this.#indexer = indexer;
  }

  async remember(
    input: CreateMemoryDto,
    workspace?: AuthenticatedWorkspace,
  ): Promise<RememberResponse> {
    const result = await this.#engine.remember(
      workspace === undefined
        ? input
        : {
            ...input,
            scope: { ...input.scope, organization: workspace.organization },
            source: { ...input.source, workspaceId: workspace.workspaceId },
          },
    );
    await this.#indexer.indexMemories([result.memory]);
    return result;
  }

  list(
    input: ListMemoriesDto,
    workspace?: AuthenticatedWorkspace,
  ): Promise<ListMemoriesResponse> {
    return this.#engine.listMemories(
      workspace === undefined
        ? input
        : {
            ...input,
            scope: {
              ...input.scope,
              organization: workspace.organization,
            },
          },
    );
  }

  async get(
    id: string,
    workspace?: AuthenticatedWorkspace,
  ): Promise<GetMemoryResponse> {
    const result = await this.#engine.getMemory(id);
    if (
      result.memory === null ||
      (workspace !== undefined &&
        result.memory.scope.organization !== workspace.organization)
    ) {
      throw new NotFoundException(`Memory not found: ${id}`);
    }
    return result;
  }

  async update(
    id: string,
    update: MemoryUpdate,
    workspace?: AuthenticatedWorkspace,
  ): Promise<UpdateMemoryResponse> {
    try {
      const current = await this.#repository.get(id);
      if (current === null) {
        throw new NotFoundException(`Memory not found: ${id}`);
      }
      if (
        workspace !== undefined &&
        current.scope.organization !== workspace.organization
      ) {
        throw new NotFoundException(`Memory not found: ${id}`);
      }
      if (current.status !== "active") {
        throw new Error(
          `Only active memories can be edited: ${id} is ${current.status}`,
        );
      }
      const memory = await this.#repository.update(
        id,
        workspace === undefined || update.scope === undefined
          ? update
          : {
              ...update,
              scope: {
                ...update.scope,
                organization: workspace.organization,
              },
            },
      );
      if (memory === null) {
        throw new NotFoundException(`Memory not found: ${id}`);
      }
      await this.#indexer.indexMemories([memory]);
      return { memory };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throwMappedMemoryError(error);
    }
  }

  async correct(
    input: CorrectMemoryDto,
    workspace?: AuthenticatedWorkspace,
  ): Promise<CorrectMemoryResponse> {
    try {
      let tenantInput = input;
      if (workspace !== undefined) {
        const current = (await this.get(input.memoryId, workspace)).memory;
        if (current === null) {
          throw new NotFoundException(`Memory not found: ${input.memoryId}`);
        }
        tenantInput = {
          ...input,
          scope: {
            ...(input.scope ?? current.scope),
            organization: workspace.organization,
          },
          ...(input.source === undefined
            ? {}
            : {
                source: {
                  ...input.source,
                  workspaceId: workspace.workspaceId,
                },
              }),
        };
      }
      const result = await this.#engine.correct(tenantInput);
      await this.#indexer.indexMemories([result.memory]);
      return result;
    } catch (error) {
      throwMappedMemoryError(error);
    }
  }

  async inspect(
    id: string,
    workspace: AuthenticatedWorkspace,
  ): Promise<LearningInspectionResponse> {
    const inspection = await this.#pilotRepository.inspectLearning({
      workspaceId: workspace.workspaceId,
      learningId: id,
    });
    if (inspection === null) {
      throw new NotFoundException(`Memory not found: ${id}`);
    }
    return inspection;
  }

  async forget(
    id: string,
    workspace?: AuthenticatedWorkspace,
  ): Promise<ForgetMemoryResponse> {
    try {
      if (workspace !== undefined) {
        await this.get(id, workspace);
      }
      return await this.#engine.forget(id);
    } catch (error) {
      throwMappedMemoryError(error);
    }
  }
}
