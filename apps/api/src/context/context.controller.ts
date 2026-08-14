import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import {
  AgentTaskSchema,
  ContextDeliveryRequestSchema,
  DeliveryFeedbackRequestSchema,
  type AgentTask,
  type ContextDeliveryRequest,
  type ContextDeliveryResponse,
  type DeliveryFeedbackRequest,
  type DeliveryFeedbackResponse,
  type DeliveryReceiptDetail,
} from "@lore-co/core";
import { MemoryIdParamsSchema } from "../common/request-schemas.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import {
  requireRequestId,
  requireWorkspace,
  type WorkspaceHttpRequest,
} from "../common/request-context.js";
import {
  ContextService,
  type FormattedContextResponse,
} from "./context.service.js";

@Controller("v1/context")
export class ContextController {
  readonly #service: ContextService;

  constructor(service: ContextService) {
    this.#service = service;
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  getContext(
    @Body(new ZodValidationPipe(AgentTaskSchema)) task: AgentTask,
    @Req() request: WorkspaceHttpRequest,
  ): Promise<FormattedContextResponse> {
    return this.#service.getContext(
      task,
      requireWorkspace(request),
    );
  }

  @Post("deliveries")
  @HttpCode(HttpStatus.OK)
  deliver(
    @Body(new ZodValidationPipe(ContextDeliveryRequestSchema))
    delivery: ContextDeliveryRequest,
    @Req() request: WorkspaceHttpRequest,
  ): Promise<ContextDeliveryResponse> {
    return this.#service.deliver(
      delivery,
      requireWorkspace(request),
      requireRequestId(request),
    );
  }

  @Get("deliveries/:id")
  getDelivery(
    @Param(new ZodValidationPipe(MemoryIdParamsSchema))
    params: { id: string },
    @Req() request: WorkspaceHttpRequest,
  ): Promise<DeliveryReceiptDetail> {
    return this.#service.getDelivery(params.id, requireWorkspace(request));
  }

  @Post("deliveries/:id/feedback")
  @HttpCode(HttpStatus.OK)
  recordFeedback(
    @Param(new ZodValidationPipe(MemoryIdParamsSchema))
    params: { id: string },
    @Body(new ZodValidationPipe(DeliveryFeedbackRequestSchema))
    body: DeliveryFeedbackRequest,
    @Req() request: WorkspaceHttpRequest,
  ): Promise<DeliveryFeedbackResponse> {
    return this.#service.recordFeedback(
      params.id,
      body,
      requireWorkspace(request),
    );
  }
}
