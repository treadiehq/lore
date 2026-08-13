import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from "@nestjs/common";
import {
  PairedTurnRequestSchema,
  type PairedTurnRequest,
  type PairedTurnResponse,
} from "@lore-co/core";
import {
  requireRequestId,
  requireWorkspace,
  type WorkspaceHttpRequest,
} from "../common/request-context.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { TurnService } from "./turn.service.js";

@Controller("v1/turns")
export class TurnController {
  readonly #service: TurnService;

  constructor(service: TurnService) {
    this.#service = service;
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  process(
    @Body(new ZodValidationPipe(PairedTurnRequestSchema))
    turn: PairedTurnRequest,
    @Req() request: WorkspaceHttpRequest,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<PairedTurnResponse> {
    return this.#service.process(
      turn,
      requireWorkspace(request),
      requireRequestId(request),
      idempotencyKey,
    );
  }
}
