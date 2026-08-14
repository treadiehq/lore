import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  ContextDeliveryRequestSchema,
  ContextDeliveryResponseSchema,
  SharedMemoryEngine,
  redactSensitiveText,
  redactUnknown,
  type AuthenticatedWorkspace,
  type AgentTask,
  type ContextDeliveryRequest,
  type ContextDeliveryResponse,
  type DeliveryFeedbackRequest,
  type DeliveryFeedbackResponse,
  type DeliveryReceiptDetail,
  type GetContextResponse,
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
  PILOT_REPOSITORY,
  SHARED_MEMORY_ENGINE,
} from "../common/tokens.js";
import { contextPackingOptions } from "../retrieval/context-packing.js";

export type FormattedContextResponse = Required<
  Pick<GetContextResponse, "memories" | "hits" | "context" | "packing">
>;

@Injectable()
export class ContextService {
  readonly #engine: SharedMemoryEngine;
  readonly #repository: PostgresPilotRepository;

  constructor(
    @Inject(SHARED_MEMORY_ENGINE) engine: SharedMemoryEngine,
    @Inject(PILOT_REPOSITORY) repository: PostgresPilotRepository,
  ) {
    this.#engine = engine;
    this.#repository = repository;
  }

  async getContext(
    task: AgentTask,
    workspace?: AuthenticatedWorkspace,
  ): Promise<FormattedContextResponse> {
    const tenantSafeTask =
      workspace === undefined
        ? task
        : (() => {
            const {
              organization: _clientOrganization,
              scope,
              ...rest
            } = task;
            return {
              ...rest,
              scope: { ...scope, organization: workspace.organization },
            };
          })();
    const { memories, hits = [] } = await this.#engine.getContext(
      tenantSafeTask,
      workspace === undefined
        ? undefined
        : { workspaceId: workspace.workspaceId },
    );
    const packed = packRelevantMemories(
      memories,
      contextPackingOptions(task.limit),
    );
    const includedIds = new Set(packed.memories.map((memory) => memory.id));
    return {
      memories: packed.memories,
      hits: hits.filter((hit) => includedIds.has(hit.memory.id)),
      context: packed.text,
      packing: packed.packing,
    };
  }

  async deliver(
    input: ContextDeliveryRequest,
    workspace: AuthenticatedWorkspace,
    requestId: string,
  ): Promise<ContextDeliveryResponse> {
    const parsedInput = ContextDeliveryRequestSchema.parse(input);
    const requestHash = createRequestHash(parsedInput);
    const redaction = redactUnknown(parsedInput);
    const delivery = ContextDeliveryRequestSchema.parse(redaction.value);
    const context = await this.getContext(delivery.task, workspace);
    const storedResponse = {
      memories: context.memories,
      hits: context.hits,
      context: context.context,
      packing: context.packing,
    };
    const recorded = await this.#repository.recordContextDeliveryEvent({
      workspaceId: workspace.workspaceId,
      requestId,
      delivery,
      payload: {
        requestHash,
        request: delivery,
        response: storedResponse,
      },
      redacted: redaction.redacted,
    });
    let replayed = !recorded.inserted;
    let response = storedResponse;
    if (!recorded.inserted) {
      if (recorded.event.type !== "context_delivery") {
        throw new ConflictException(
          "Connector event ID is already used by another event type",
        );
      }
      if (recorded.event.payload.requestHash !== requestHash) {
        throw new ConflictException(
          "Connector event ID was reused with a different context request",
        );
      }
      const parsed = ContextDeliveryResponseSchema.pick({
        memories: true,
        hits: true,
        context: true,
        packing: true,
      }).safeParse(recorded.event.payload.response);
      if (!parsed.success) {
        throw new ConflictException(
          "Stored context delivery response is invalid",
        );
      }
      response = parsed.data;
      replayed = true;
    }
    const receipt = await this.#repository.recordDeliveryReceipt({
      workspaceId: workspace.workspaceId,
      eventId: recorded.event.id,
      requestId: recorded.event.requestId,
      memoryIds: response.memories.map((memory) => memory.id),
      querySha256: createRequestHash(delivery.task),
      retrievalPolicyVersion: RETRIEVAL_POLICY_VERSION,
      hits: response.hits ?? [],
      ...(response.packing === undefined
        ? {}
        : { packing: response.packing }),
    });
    return ContextDeliveryResponseSchema.parse({
      event: recorded.event,
      receipt,
      replayed,
      ...response,
    });
  }

  async getDelivery(
    receiptId: string,
    workspace: AuthenticatedWorkspace,
  ): Promise<DeliveryReceiptDetail> {
    const detail = await this.#repository.getDeliveryReceiptDetail({
      workspaceId: workspace.workspaceId,
      receiptId,
    });
    if (detail === null) {
      throw new NotFoundException("Delivery receipt not found");
    }
    return detail;
  }

  async recordFeedback(
    receiptId: string,
    input: DeliveryFeedbackRequest,
    workspace: AuthenticatedWorkspace,
  ): Promise<DeliveryFeedbackResponse> {
    const reason =
      input.reason === undefined
        ? undefined
        : redactSensitiveText(input.reason).text;
    const result = await this.#repository.recordDeliveryFeedback({
      workspaceId: workspace.workspaceId,
      receiptId,
      memoryId: input.memoryId,
      action: input.action,
      ...(reason === undefined ? {} : { reason }),
      actorId: workspace.tokenId,
    });
    if (result === null) {
      throw new NotFoundException("Delivery receipt or learning not found");
    }
    return result;
  }
}
