import { ConflictException, Inject, Injectable } from "@nestjs/common";
import {
  AgentInteractionSchema,
  ObservationRequestSchema,
  ObservationResponseSchema,
  SharedMemoryEngine,
  TurnObservationSchema,
  isNativeCodingAgent,
  redactUnknown,
  type AuthenticatedWorkspace,
  type AgentInteraction,
  type ObservationRequestInput,
  type ObservationResponse,
  type ObserveResponse,
} from "@lore-co/core";
import {
  createRequestHash,
  type PostgresPilotRepository,
} from "@lore-co/database";
import {
  MEMORY_EMBEDDING_INDEXER,
  PILOT_REPOSITORY,
  SHARED_MEMORY_ENGINE,
} from "../common/tokens.js";
import type { EmbeddingIndexerService } from "../retrieval/embedding-indexer.service.js";

@Injectable()
export class InteractionService {
  readonly #engine: SharedMemoryEngine;
  readonly #indexer: EmbeddingIndexerService;
  readonly #repository: PostgresPilotRepository;

  constructor(
    @Inject(SHARED_MEMORY_ENGINE) engine: SharedMemoryEngine,
    @Inject(MEMORY_EMBEDDING_INDEXER) indexer: EmbeddingIndexerService,
    @Inject(PILOT_REPOSITORY) repository: PostgresPilotRepository,
  ) {
    this.#engine = engine;
    this.#indexer = indexer;
    this.#repository = repository;
  }

  async observe(
    interaction: AgentInteraction,
    workspace?: AuthenticatedWorkspace,
  ): Promise<ObserveResponse> {
    let observed: ObserveResponse;
    if (workspace === undefined) {
      observed = await this.#engine.observe(interaction);
    } else {
      const {
        organization: _clientOrganization,
        workspaceId: _clientWorkspaceId,
        scope,
        ...tenantSafeInteraction
      } = interaction;
      observed = await this.#engine.observe({
        ...tenantSafeInteraction,
        workspaceId: workspace.workspaceId,
        scope: { ...scope, organization: workspace.organization },
      });
    }
    await this.#indexer.indexMemories(observed.memories);
    return observed;
  }

  async observeEvent(
    input: ObservationRequestInput,
    workspace: AuthenticatedWorkspace,
    requestId: string,
  ): Promise<ObservationResponse> {
    const observation = ObservationRequestSchema.parse(input);
    const requestHash = createRequestHash(observation);
    const idempotencyKey =
      `observation:${observation.connector}:${observation.eventId}`;
    const claim = await this.#repository.beginObservationIdempotency({
      workspaceId: workspace.workspaceId,
      key: idempotencyKey,
      requestHash,
    });
    if (claim.state === "conflict") {
      throw new ConflictException(
        "Connector event ID was reused with a different observation",
      );
    }
    if (claim.state === "processing") {
      throw new ConflictException(
        "This observation is already being processed; retry shortly",
      );
    }
    if (claim.state === "replay") {
      return ObservationResponseSchema.parse({
        ...claim.response,
        replayed: true,
      });
    }

    try {
      const redaction = redactUnknown(observation);
      const sanitized = ObservationRequestSchema.parse(redaction.value);
      const recorded = await this.#repository.recordObservationEvent({
        workspaceId: workspace.workspaceId,
        requestId,
        observation: sanitized,
        payload: {
          requestHash,
          request: sanitized,
          redactionFindings: redaction.findings,
        },
        redacted: redaction.redacted,
      });
      if (!recorded.inserted) {
        if (recorded.event.type !== "observation") {
          throw new ConflictException(
            "Connector event ID is already used by another event type",
          );
        }
        if (recorded.event.payload.requestHash !== requestHash) {
          throw new ConflictException(
            "Connector event ID was reused with a different observation",
          );
        }
        const stored = TurnObservationSchema.safeParse(
          recorded.event.payload.response,
        );
        if (stored.success) {
          const replay = ObservationResponseSchema.parse({
            ...stored.data,
            event: recorded.event,
            replayed: true,
          });
          await this.#repository.completeObservationIdempotency({
            workspaceId: workspace.workspaceId,
            key: idempotencyKey,
            requestHash,
            response: replay,
          });
          return replay;
        }
      }

      const learningScope = {
        ...sanitized.scope,
        ...sanitized.learningScope,
        organization: workspace.organization,
      };
      const interaction = AgentInteractionSchema.parse({
        agent: sanitized.agent,
        workspaceId: workspace.workspaceId,
        eventId: recorded.event.id,
        scope: learningScope,
        sessionId: sanitized.sessionId,
        messages: sanitized.messages,
      });
      const observed =
        isNativeCodingAgent(sanitized.agent) &&
        learningScope.repo === undefined
          ? {
              memories: [],
              created: 0,
              duplicates: 0,
              reconciled: 0,
              superseded: 0,
            }
          : await this.#engine.observe(interaction);
      await this.#indexer.indexMemories(observed.memories);

      const userMessages = sanitized.messages.filter(
        (message) => message.role === "user",
      );
      await Promise.all(
        observed.memories.map((memory) => {
          const triggeringMessage =
            (memory.source.messageId === undefined ||
            memory.source.messageId === null
              ? undefined
              : userMessages.find(
                  (message) => message.id === memory.source.messageId,
                )) ??
            (memory.source.rawText === undefined ||
            memory.source.rawText === null
              ? undefined
              : [...userMessages]
                  .reverse()
                  .find(
                    (message) =>
                      message.content === memory.source.rawText,
                  )) ??
            userMessages.at(-1);
          return this.#repository.recordProvenance({
            workspaceId: workspace.workspaceId,
            eventId: recorded.event.id,
            memory,
            messageRole: "user",
            ...(triggeringMessage?.id === undefined
              ? {}
              : { sourceMessageId: triggeringMessage.id }),
            excerpt:
              memory.source.rawText ??
              triggeringMessage?.content ??
              memory.content,
            redacted:
              redaction.redacted || memory.source.redacted === true,
            ...(memory.confidence === undefined
              ? {}
              : { confidence: memory.confidence }),
            ...(memory.confirmation === undefined
              ? {}
              : { confirmation: memory.confirmation }),
            metadata: {
              connector: sanitized.connector,
              externalEventId: sanitized.eventId,
              task: sanitized.task ?? null,
              redactionFindings: redaction.findings,
            },
          });
        }),
      );

      const observationResult = TurnObservationSchema.parse({
        memories: observed.memories,
        created: observed.created,
        duplicates: observed.duplicates,
        reconciled: observed.reconciled ?? 0,
        superseded: observed.superseded ?? 0,
      });
      const event = await this.#repository.completeObservationEvent({
        workspaceId: workspace.workspaceId,
        eventId: recorded.event.id,
        response: observationResult,
      });
      const response = ObservationResponseSchema.parse({
        ...observationResult,
        event,
        replayed: false,
      });
      await this.#repository.completeObservationIdempotency({
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
