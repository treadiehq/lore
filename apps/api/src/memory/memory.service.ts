import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import {
  MemoryUpdateSchema,
  ProposalDetailResponseSchema,
  SharedMemoryEngine,
  redactUnknown,
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
  type ProposalDetailResponse,
  type RememberResponse,
  type ReviewProposalDto,
  type ReviewProposalResponse,
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
      workspace === undefined
        ? undefined
        : { workspaceId: workspace.workspaceId },
    );
  }

  async get(
    id: string,
    workspace?: AuthenticatedWorkspace,
  ): Promise<GetMemoryResponse> {
    const result = await this.#engine.getMemory(
      id,
      workspace === undefined
        ? undefined
        : { workspaceId: workspace.workspaceId },
    );
    if (
      result.memory === null ||
      (workspace !== undefined &&
        result.memory.workspaceId !== workspace.workspaceId)
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
      const context =
        workspace === undefined
          ? undefined
          : { workspaceId: workspace.workspaceId };
      const current = await this.#repository.get(id, context);
      if (current === null) {
        throw new NotFoundException(`Memory not found: ${id}`);
      }
      if (current.status !== "active") {
        throw new Error(
          `Only active memories can be edited: ${id} is ${current.status}`,
        );
      }
      const redaction = redactUnknown(update);
      const redactedUpdate = MemoryUpdateSchema.parse(redaction.value);
      const safeUpdate =
        redactedUpdate.source === undefined || !redaction.redacted
          ? redactedUpdate
          : {
              ...redactedUpdate,
              source: { ...redactedUpdate.source, redacted: true },
            };
      const memory = await this.#repository.update(
        id,
        workspace === undefined || safeUpdate.scope === undefined
          ? safeUpdate
          : {
              ...safeUpdate,
              scope: {
                ...safeUpdate.scope,
                organization: workspace.organization,
              },
            },
        context,
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
      const result = await this.#engine.correct(
        tenantInput,
        workspace === undefined
          ? undefined
          : { workspaceId: workspace.workspaceId },
      );
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

  async getProposal(
    id: string,
    workspace: AuthenticatedWorkspace,
  ): Promise<ProposalDetailResponse> {
    const proposal = await this.#engine.getProposal(id, {
      workspaceId: workspace.workspaceId,
    });
    if (proposal === null) {
      throw new NotFoundException("Proposal not found");
    }
    const targets = await Promise.all(
      [
        ...new Set(
          proposal.conflicts.map((conflict) => conflict.targetMemoryId),
        ),
      ].map((targetId) =>
        this.#repository.get(targetId, {
          workspaceId: workspace.workspaceId,
        }),
      ),
    );
    return ProposalDetailResponseSchema.parse({
      ...proposal,
      conflictTargets: targets.filter((target) => target !== null),
    });
  }

  async reviewProposal(
    id: string,
    input: Omit<ReviewProposalDto, "proposalMemoryId" | "reviewerId">,
    workspace: AuthenticatedWorkspace,
  ): Promise<ReviewProposalResponse> {
    if (
      workspace.credentialType !== "session" ||
      workspace.userId === undefined
    ) {
      throw new UnauthorizedException(
        "An authenticated user session is required",
      );
    }
    try {
      const result = await this.#engine.reviewProposal(
        {
          ...input,
          proposalMemoryId: id,
          reviewerId: workspace.userId,
          ...(input.scope === undefined
            ? {}
            : {
                scope: {
                  ...input.scope,
                  organization: workspace.organization,
                },
              }),
        },
        { workspaceId: workspace.workspaceId },
      );
      if (result.proposal.status === "active") {
        await this.#indexer.indexMemories([result.proposal]);
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/proposal not found/iu.test(message)) {
        throw new NotFoundException("Proposal not found");
      }
      if (
        /already been resolved|blocked proposals|conflict target|fingerprint|changed during review/iu.test(
          message,
        )
      ) {
        throw new ConflictException(
          "Proposal cannot be resolved with this decision",
        );
      }
      throw new InternalServerErrorException("Proposal review failed");
    }
  }

  async forget(
    id: string,
    workspace?: AuthenticatedWorkspace,
  ): Promise<ForgetMemoryResponse> {
    try {
      if (workspace !== undefined) {
        await this.get(id, workspace);
      }
      return await this.#engine.forget(
        id,
        workspace === undefined
          ? undefined
          : { workspaceId: workspace.workspaceId },
      );
    } catch (error) {
      throwMappedMemoryError(error);
    }
  }
}
