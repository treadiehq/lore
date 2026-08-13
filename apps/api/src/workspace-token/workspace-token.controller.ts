import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from "@nestjs/common";
import {
  CreateWorkspaceTokenRequestSchema,
  type CreateWorkspaceTokenRequest,
  type CreateWorkspaceTokenResponse,
  type ListWorkspaceTokensResponse,
  type RevokeWorkspaceTokenResponse,
} from "@lore-co/core";
import {
  requireWorkspace,
  type WorkspaceHttpRequest,
} from "../common/request-context.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { WorkspaceTokenService } from "./workspace-token.service.js";

@Controller("v1/workspace-tokens")
export class WorkspaceTokenController {
  readonly #service: WorkspaceTokenService;

  constructor(service: WorkspaceTokenService) {
    this.#service = service;
  }

  @Get()
  list(
    @Req() request: WorkspaceHttpRequest,
  ): Promise<ListWorkspaceTokensResponse> {
    return this.#service.list(requireWorkspace(request));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(CreateWorkspaceTokenRequestSchema))
    input: CreateWorkspaceTokenRequest,
    @Req() request: WorkspaceHttpRequest,
  ): Promise<CreateWorkspaceTokenResponse> {
    return this.#service.create(requireWorkspace(request), input);
  }

  @Delete(":tokenId")
  revoke(
    @Param("tokenId", new ParseUUIDPipe({ version: "4" })) tokenId: string,
    @Req() request: WorkspaceHttpRequest,
  ): Promise<RevokeWorkspaceTokenResponse> {
    return this.#service.revoke(requireWorkspace(request), tokenId);
  }
}
