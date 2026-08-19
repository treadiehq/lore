import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type {
  ForgetMemoryResponse,
  GetMemoryResponse,
  LearningInspectionResponse,
  ListMemoriesDto,
  ListMemoriesResponse,
  MemoryUpdate,
  ProposalDetailResponse,
  RememberResponse,
  ReviewProposalResponse,
  UpdateMemoryResponse,
} from "@lore-co/core";
import {
  CorrectMemoryBodySchema,
  CreateMemoryBodySchema,
  ListMemoriesQuerySchema,
  MemoryIdParamsSchema,
  ReviewProposalBodySchema,
  UpdateMemoryBodySchema,
  correctionInput,
} from "../common/request-schemas.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { SessionAuthGuard } from "../common/session-auth.guard.js";
import {
  requireWorkspace,
  type WorkspaceHttpRequest,
} from "../common/request-context.js";
import { MemoryService } from "./memory.service.js";

@Controller(["v1/learnings", "v1/memories"])
export class MemoryController {
  readonly #service: MemoryService;

  constructor(service: MemoryService) {
    this.#service = service;
  }

  @Post()
  remember(
    @Body(new ZodValidationPipe(CreateMemoryBodySchema))
    body: ReturnType<typeof CreateMemoryBodySchema.parse>,
    @Req() request: WorkspaceHttpRequest,
  ): Promise<RememberResponse> {
    return this.#service.remember(body, requireWorkspace(request));
  }

  @Get()
  list(
    @Query(new ZodValidationPipe(ListMemoriesQuerySchema))
    query: ListMemoriesDto,
    @Req() request: WorkspaceHttpRequest,
  ): Promise<ListMemoriesResponse> {
    return this.#service.list(query, requireWorkspace(request));
  }

  @Get(":id/inspection")
  inspect(
    @Param(new ZodValidationPipe(MemoryIdParamsSchema))
    params: { id: string },
    @Req() request: WorkspaceHttpRequest,
  ): Promise<LearningInspectionResponse> {
    return this.#service.inspect(params.id, requireWorkspace(request));
  }

  @UseGuards(SessionAuthGuard)
  @Get(":id/proposal")
  getProposal(
    @Param(new ZodValidationPipe(MemoryIdParamsSchema))
    params: { id: string },
    @Req() request: WorkspaceHttpRequest,
  ): Promise<ProposalDetailResponse> {
    return this.#service.getProposal(params.id, requireWorkspace(request));
  }

  @UseGuards(SessionAuthGuard)
  @Post(":id/review")
  reviewProposal(
    @Param(new ZodValidationPipe(MemoryIdParamsSchema))
    params: { id: string },
    @Body(new ZodValidationPipe(ReviewProposalBodySchema))
    body: ReturnType<typeof ReviewProposalBodySchema.parse>,
    @Req() request: WorkspaceHttpRequest,
  ): Promise<ReviewProposalResponse> {
    return this.#service.reviewProposal(
      params.id,
      body,
      requireWorkspace(request),
    );
  }

  @Get(":id")
  get(
    @Param(new ZodValidationPipe(MemoryIdParamsSchema))
    params: { id: string },
    @Req() request: WorkspaceHttpRequest,
  ): Promise<GetMemoryResponse> {
    return this.#service.get(params.id, requireWorkspace(request));
  }

  @Patch(":id")
  update(
    @Param(new ZodValidationPipe(MemoryIdParamsSchema))
    params: { id: string },
    @Body(new ZodValidationPipe(UpdateMemoryBodySchema))
    body: MemoryUpdate,
    @Req() request: WorkspaceHttpRequest,
  ): Promise<UpdateMemoryResponse> {
    return this.#service.update(
      params.id,
      body,
      requireWorkspace(request),
    );
  }

  @Delete(":id")
  forget(
    @Param(new ZodValidationPipe(MemoryIdParamsSchema))
    params: { id: string },
    @Req() request: WorkspaceHttpRequest,
  ): Promise<ForgetMemoryResponse> {
    return this.#service.forget(params.id, requireWorkspace(request));
  }

  @Post(":id/corrections")
  correct(
    @Param(new ZodValidationPipe(MemoryIdParamsSchema))
    params: { id: string },
    @Body(new ZodValidationPipe(CorrectMemoryBodySchema))
    body: ReturnType<typeof CorrectMemoryBodySchema.parse>,
    @Req() request: WorkspaceHttpRequest,
  ) {
    return this.#service.correct(
      correctionInput(params.id, body),
      requireWorkspace(request),
    );
  }
}
