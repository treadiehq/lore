import {
  Controller,
  Get,
  Query,
  Req,
} from "@nestjs/common";
import {
  ActivityQuerySchema,
  type ActivityListResponse,
  type ActivityQuery,
} from "@lore-co/core";
import {
  requireWorkspace,
  type WorkspaceHttpRequest,
} from "../common/request-context.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { ActivityService } from "./activity.service.js";

@Controller("v1/activity")
export class ActivityController {
  readonly #service: ActivityService;

  constructor(service: ActivityService) {
    this.#service = service;
  }

  @Get()
  list(
    @Req() request: WorkspaceHttpRequest,
    @Query(new ZodValidationPipe(ActivityQuerySchema)) query: ActivityQuery,
  ): Promise<ActivityListResponse> {
    const workspace = requireWorkspace(request);
    return this.#service.list(workspace.workspaceId, query);
  }
}
