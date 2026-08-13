import { ConflictException, Inject, Injectable } from "@nestjs/common";
import {
  ContextDeliveryRequestSchema,
  ContextDeliveryResponseSchema,
  SharedMemoryEngine,
  redactUnknown,
  type AuthenticatedWorkspace,
  type AgentTask,
  type ContextDeliveryRequest,
  type ContextDeliveryResponse,
  type GetContextResponse,
} from "@lore-co/core";
import {
  createRequestHash,
  type PostgresPilotRepository,
} from "@lore-co/database";
import { packRelevantMemories } from "@lore-co/retrieval";
import {
  PILOT_REPOSITORY,
  SHARED_MEMORY_ENGINE,
} from "../common/tokens.js";
import { contextPackingOptions } from "../retrieval/context-packing.js";

export type FormattedContextResponse = Required<
  Pick<GetContextResponse, "memories" | "context" | "packing">
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
    const { memories } = await this.#engine.getContext(
      tenantSafeTask,
      workspace === undefined
        ? undefined
        : { workspaceId: workspace.workspaceId },
    );
    const packed = packRelevantMemories(
      memories,
      contextPackingOptions(task.limit),
    );
    return {
      memories: packed.memories,
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
}
