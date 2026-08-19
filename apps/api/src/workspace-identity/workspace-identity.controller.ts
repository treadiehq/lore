import { Controller, Get, Req } from "@nestjs/common";
import type { WorkspaceIdentityResponse } from "@lore-co/core";
import {
  requireWorkspace,
  type WorkspaceHttpRequest,
} from "../common/request-context.js";
import { WorkspaceIdentityService } from "./workspace-identity.service.js";

@Controller("v1/workspace/identity")
export class WorkspaceIdentityController {
  readonly #service: WorkspaceIdentityService;

  constructor(service: WorkspaceIdentityService) {
    this.#service = service;
  }

  @Get()
  get(@Req() request: WorkspaceHttpRequest): WorkspaceIdentityResponse {
    return this.#service.get(requireWorkspace(request));
  }
}
