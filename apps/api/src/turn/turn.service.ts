import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from "@nestjs/common";
import {
  AgentInteractionSchema,
  AgentTaskSchema,
  PairedTurnRequestSchema,
  PairedTurnResponseSchema,
  redactUnknown,
  type AuthenticatedWorkspace,
  type PairedTurnRequest,
  type PairedTurnResponse,
} from "@lore-co/core";
import {
  createRequestHash,
  type PostgresPilotRepository,
} from "@lore-co/database";
import {
  packRelevantMemories,
  RETRIEVAL_POLICY_VERSION,
} from "@lore-co/retrieval";
import {
  MEMORY_EMBEDDING_INDEXER,
  PILOT_REPOSITORY,
  SHARED_MEMORY_ENGINE,
} from "../common/tokens.js";
import type { SharedMemoryEngine } from "@lore-co/core";
import type { EmbeddingIndexerService } from "../retrieval/embedding-indexer.service.js";
import { contextPackingOptions } from "../retrieval/context-packing.js";

function validateClientIdempotencyKey(value: string | undefined): void {
  if (value === undefined) {
    return;
  }
  const key = value.trim();
  if (
    key.length < 1 ||
    key.length > 500 ||
    !/^[\x21-\x7E]+$/u.test(key)
  ) {
    throw new BadRequestException(
      "Idempotency-Key must contain 1 to 500 visible ASCII characters",
    );
  }
}

@Injectable()
export class TurnService {
  readonly #engine: SharedMemoryEngine;
  readonly #repository: PostgresPilotRepository;
  readonly #indexer: EmbeddingIndexerService;

  constructor(
    @Inject(SHARED_MEMORY_ENGINE) engine: SharedMemoryEngine,
    @Inject(PILOT_REPOSITORY) repository: PostgresPilotRepository,
    @Inject(MEMORY_EMBEDDING_INDEXER) indexer: EmbeddingIndexerService,
  ) {
    this.#engine = engine;
    this.#repository = repository;
    this.#indexer = indexer;
  }

  async process(
    turnInput: PairedTurnRequest,
    workspace: Pick<AuthenticatedWorkspace, "workspaceId" | "organization">,
    requestId: string,
    clientIdempotencyKey?: string,
  ): Promise<PairedTurnResponse> {
    validateClientIdempotencyKey(clientIdempotencyKey);
    const turn = PairedTurnRequestSchema.parse(turnInput);
    const requestHash = createRequestHash(turn);
    const idempotencyKey = `turn:${turn.connector}:${turn.eventId}`;
    const claim = await this.#repository.beginIdempotency({
      workspaceId: workspace.workspaceId,
      key: idempotencyKey,
      requestHash,
    });
    if (claim.state === "conflict") {
      throw new ConflictException(
        "Connector event ID was reused with a different request",
      );
    }
    if (claim.state === "processing") {
      throw new ConflictException(
        "This connector event is already being processed; retry shortly",
      );
    }
    if (claim.state === "replay") {
      return PairedTurnResponseSchema.parse({
        ...claim.response,
        requestId,
        replayed: true,
      });
    }

    try {
      const redaction = redactUnknown(turn);
      const sanitizedTurn = PairedTurnRequestSchema.parse(redaction.value);
      const event = await this.#repository.recordConnectorEvent({
        workspaceId: workspace.workspaceId,
        requestId,
        turn: sanitizedTurn,
        payload: sanitizedTurn as unknown as Record<string, unknown>,
        redacted: redaction.redacted,
      });
      const taskScope = {
        ...sanitizedTurn.scope,
        organization: workspace.organization,
      };
      const learningScope = {
        ...(sanitizedTurn.learningScope ?? sanitizedTurn.scope),
        organization: workspace.organization,
      };
      const interaction = AgentInteractionSchema.parse({
        agent: sanitizedTurn.agent,
        workspaceId: workspace.workspaceId,
        eventId: event.id,
        scope: learningScope,
        sessionId: sanitizedTurn.sessionId,
        messages: [
          {
            role: "assistant",
            content: sanitizedTurn.previousAssistant.content,
            ...(sanitizedTurn.previousAssistant.id === undefined
              ? {}
              : { id: sanitizedTurn.previousAssistant.id }),
            ...(sanitizedTurn.previousAssistant.timestamp === undefined
              ? {}
              : { timestamp: sanitizedTurn.previousAssistant.timestamp }),
          },
          {
            role: "user",
            content: sanitizedTurn.currentUser.content,
            ...(sanitizedTurn.currentUser.id === undefined
              ? {}
              : { id: sanitizedTurn.currentUser.id }),
            ...(sanitizedTurn.currentUser.timestamp === undefined
              ? {}
              : { timestamp: sanitizedTurn.currentUser.timestamp }),
          },
        ],
      });
      const nativeLearningWithoutRepository =
        sanitizedTurn.connector === "lore-cli" &&
        (sanitizedTurn.agent === "claude" ||
          sanitizedTurn.agent === "codex") &&
        learningScope.repo === undefined;
      const observed = nativeLearningWithoutRepository
        ? {
            memories: [],
            created: 0,
            duplicates: 0,
            reconciled: 0,
            superseded: 0,
          }
        : await this.#engine.observe(interaction);
      await this.#indexer.indexMemories(observed.memories);

      await Promise.all(
        observed.memories.map((memory) =>
          this.#repository.recordProvenance({
            workspaceId: workspace.workspaceId,
            eventId: event.id,
            memory,
            messageRole: "user",
            ...(sanitizedTurn.currentUser.id === undefined
              ? {}
              : { sourceMessageId: sanitizedTurn.currentUser.id }),
            excerpt: sanitizedTurn.currentUser.content,
            redacted: redaction.redacted,
            metadata: {
              connector: sanitizedTurn.connector,
              externalEventId: sanitizedTurn.eventId,
              previousAssistantMessageId:
                sanitizedTurn.previousAssistant.id ?? null,
              redactionFindings: redaction.findings,
            },
          }),
        ),
      );

      const task = AgentTaskSchema.parse({
        agent: sanitizedTurn.agent,
        scope: taskScope,
        task: sanitizedTurn.task ?? sanitizedTurn.currentUser.content,
        ...(sanitizedTurn.diff === undefined
          ? {}
          : { diff: sanitizedTurn.diff }),
        ...(sanitizedTurn.files === undefined
          ? {}
          : { files: sanitizedTurn.files }),
        ...(sanitizedTurn.components === undefined
          ? {}
          : { components: sanitizedTurn.components }),
        ...(sanitizedTurn.symbols === undefined
          ? {}
          : { symbols: sanitizedTurn.symbols }),
      });
      const contextResult = await this.#engine.getContext(task, {
        workspaceId: workspace.workspaceId,
      });
      const packedContext = packRelevantMemories(
        contextResult.memories,
        contextPackingOptions(),
      );
      const includedIds = new Set(
        packedContext.memories.map((memory) => memory.id),
      );
      const hits = (contextResult.hits ?? []).filter((hit) =>
        includedIds.has(hit.memory.id),
      );
      const receipt = await this.#repository.recordDeliveryReceipt({
        workspaceId: workspace.workspaceId,
        eventId: event.id,
        requestId,
        memoryIds: packedContext.memories.map((memory) => memory.id),
        querySha256: createRequestHash(task),
        retrievalPolicyVersion: RETRIEVAL_POLICY_VERSION,
        hits,
        packing: packedContext.packing,
      });
      const response = PairedTurnResponseSchema.parse({
        requestId,
        event,
        replayed: false,
        observation: {
          memories: observed.memories,
          created: observed.created,
          duplicates: observed.duplicates,
          reconciled: observed.reconciled ?? 0,
          superseded: observed.superseded ?? 0,
        },
        context: {
          memories: packedContext.memories,
          hits,
          text: packedContext.text,
          packing: packedContext.packing,
        },
        receipt,
      });
      await this.#repository.completeIdempotency({
        workspaceId: workspace.workspaceId,
        key: idempotencyKey,
        requestHash,
        response,
      });
      return response;
    } catch (error) {
      await this.#repository.abandonIdempotency({
        workspaceId: workspace.workspaceId,
        key: idempotencyKey,
        requestHash,
      });
      throw error;
    }
  }
}
