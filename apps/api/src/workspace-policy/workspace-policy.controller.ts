import {
  Body,
  Controller,
  Get,
  Patch,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  UpdateWorkspaceLearningPolicySchema,
  type UpdateWorkspaceLearningPolicy,
  type WorkspaceLearningPolicy,
} from "@lore-co/core";
import {
  requireWorkspace,
  type WorkspaceHttpRequest,
} from "../common/request-context.js";
import { OwnerOnly } from "../common/owner-only.decorator.js";
import { SessionAuthGuard } from "../common/session-auth.guard.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { WorkspacePolicyService } from "./workspace-policy.service.js";

@Controller("v1/workspace/policy")
export class WorkspacePolicyController {
  readonly #service: WorkspacePolicyService;

  constructor(service: WorkspacePolicyService) {
    this.#service = service;
  }

  @Get()
  @UseGuards(SessionAuthGuard)
  get(@Req() request: WorkspaceHttpRequest): Promise<WorkspaceLearningPolicy> {
    return this.#service.get(requireWorkspace(request));
  }

  @Patch()
  @OwnerOnly()
  update(
    @Body(new ZodValidationPipe(UpdateWorkspaceLearningPolicySchema))
    input: UpdateWorkspaceLearningPolicy,
    @Req() request: WorkspaceHttpRequest,
  ): Promise<WorkspaceLearningPolicy> {
    return this.#service.update(input, requireWorkspace(request));
  }
}
