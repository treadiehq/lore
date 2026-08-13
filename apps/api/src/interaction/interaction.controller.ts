import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from "@nestjs/common";
import {
  AgentInteractionSchema,
  ObservationRequestSchema,
  type AgentInteraction,
  type ObservationRequest,
  type ObservationResponse,
  type ObserveResponse,
} from "@lore-co/core";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import {
  requireRequestId,
  requireWorkspace,
  type WorkspaceHttpRequest,
} from "../common/request-context.js";
import { InteractionService } from "./interaction.service.js";

const ObservedInteractionSchema = AgentInteractionSchema;

@Controller("v1/interactions")
export class InteractionController {
  readonly #service: InteractionService;

  constructor(service: InteractionService) {
    this.#service = service;
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  observe(
    @Body(new ZodValidationPipe(ObservedInteractionSchema))
    interaction: AgentInteraction,
    @Req() request: WorkspaceHttpRequest,
  ): Promise<ObserveResponse> {
    return this.#service.observe(
      interaction,
      requireWorkspace(request),
    );
  }
}

@Controller("v1/observations")
export class ObservationController {
  readonly #service: InteractionService;

  constructor(service: InteractionService) {
    this.#service = service;
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  observe(
    @Body(new ZodValidationPipe(ObservationRequestSchema))
    observation: ObservationRequest,
    @Req() request: WorkspaceHttpRequest,
  ): Promise<ObservationResponse> {
    return this.#service.observeEvent(
      observation,
      requireWorkspace(request),
      requireRequestId(request),
    );
  }
}
