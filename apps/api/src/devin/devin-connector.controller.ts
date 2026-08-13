import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from "@nestjs/common";
import {
  DevinSessionRegistrationSchema,
  type DevinSessionRegistration,
  type DevinSessionRegistrationResponse,
} from "@lore-co/core";
import {
  requireWorkspace,
  type WorkspaceHttpRequest,
} from "../common/request-context.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { DevinConnectorService } from "./devin-connector.service.js";

@Controller("v1/connectors/devin/sessions")
export class DevinConnectorController {
  readonly #service: DevinConnectorService;

  constructor(service: DevinConnectorService) {
    this.#service = service;
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  register(
    @Body(new ZodValidationPipe(DevinSessionRegistrationSchema))
    registration: DevinSessionRegistration,
    @Req() request: WorkspaceHttpRequest,
  ): Promise<DevinSessionRegistrationResponse> {
    return this.#service.register(
      registration,
      requireWorkspace(request),
    );
  }
}
