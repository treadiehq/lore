import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from "@nestjs/common";
import {
  AgentTaskSchema,
  ContextDeliveryRequestSchema,
  type AgentTask,
  type ContextDeliveryRequest,
  type ContextDeliveryResponse,
} from "@lore-co/core";
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
}
