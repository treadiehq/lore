import { z } from "zod";

export const MemoryCategorySchema = z.enum([
  "architecture",
  "convention",
  "correction",
  "gotcha",
  "known_gotcha",
  "deprecated",
  "behavior",
  "review_feedback",
  "other",
]);
export type MemoryCategory = z.infer<typeof MemoryCategorySchema>;
export const LearningCategorySchema = MemoryCategorySchema;
export type LearningCategory = MemoryCategory;

export const MemoryStatusSchema = z.enum([
  "active",
  "proposed",
  "suppressed",
  "superseded",
  "deleted",
]);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;
export const LearningStatusSchema = MemoryStatusSchema;
export type LearningStatus = MemoryStatus;

export const WorkspaceLearningModeSchema = z.enum([
  "trust_tiered",
  "proposal_only",
]);
export type WorkspaceLearningMode = z.infer<
  typeof WorkspaceLearningModeSchema
>;

export const WorkspaceLearningPolicySchema = z
  .object({
    workspaceId: z.uuid(),
    learningMode: WorkspaceLearningModeSchema,
    llmConflictAnalysisEnabled: z.boolean(),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type WorkspaceLearningPolicy = z.infer<
  typeof WorkspaceLearningPolicySchema
>;

export const UpdateWorkspaceLearningPolicySchema = z
  .object({
    learningMode: WorkspaceLearningModeSchema.optional(),
    llmConflictAnalysisEnabled: z.boolean().optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.learningMode !== undefined ||
      input.llmConflictAnalysisEnabled !== undefined,
    { message: "At least one learning policy field is required" },
  );
export type UpdateWorkspaceLearningPolicy = z.infer<
  typeof UpdateWorkspaceLearningPolicySchema
>;

export const ProposalReviewDecisionSchema = z.enum([
  "approve",
  "use_proposal",
  "keep_both",
  "reject",
]);
export type ProposalReviewDecision = z.infer<
  typeof ProposalReviewDecisionSchema
>;

export const MemoryConflictDetectorSchema = z.enum([
  "deterministic",
  "lexical",
  "semantic",
  "llm",
]);
export type MemoryConflictDetectorKind = z.infer<
  typeof MemoryConflictDetectorSchema
>;

export const MemoryConflictSeveritySchema = z.enum(["blocking", "warning"]);
export type MemoryConflictSeverity = z.infer<
  typeof MemoryConflictSeveritySchema
>;

export const MemoryConflictEvidenceSchema = z
  .object({
    summary: z.string().trim().min(1).max(2_000),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type MemoryConflictEvidence = z.infer<
  typeof MemoryConflictEvidenceSchema
>;

export function normalizeRepositoryPath(value: string): string {
  const segments: string[] = [];
  for (const segment of value.trim().replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

export const RepositoryPathSchema = z
  .string()
  .trim()
  .min(1)
  .transform(normalizeRepositoryPath)
  .pipe(z.string().min(1));

export const MemoryScopeSchema = z
  .object({
    organization: z.string().trim().min(1).optional(),
    project: z.string().trim().min(1).optional(),
    repo: z.string().trim().min(1).optional(),
    path: RepositoryPathSchema.optional(),
    component: z.string().trim().min(1).optional(),
  })
  .strict();
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;
export const LearningScopeSchema = MemoryScopeSchema;
export type LearningScope = MemoryScope;

export const MemorySourceSchema = z
  .object({
    agent: z.string().trim().min(1),
    sessionId: z.string().trim().min(1).optional(),
    messageId: z.string().trim().min(1).nullable().optional(),
    rawText: z.string().nullable().optional(),
    workspaceId: z.uuid().optional(),
    eventId: z.uuid().optional(),
    redacted: z.boolean().optional(),
  })
  .strict();
export type MemorySource = z.infer<typeof MemorySourceSchema>;
export const LearningSourceSchema = MemorySourceSchema;
export type LearningSource = MemorySource;

export const ProposalMetadataSchema = z
  .object({
    memoryId: z.uuid(),
    workspaceId: z.uuid(),
    policyMode: WorkspaceLearningModeSchema,
    reason: z.string().trim().min(1).max(1_000),
    provenance: MemorySourceSchema,
    proposedAt: z.iso.datetime({ offset: true }),
    decision: ProposalReviewDecisionSchema.nullable(),
    reviewerId: z.string().trim().min(1).max(500).nullable(),
    decisionReason: z.string().trim().min(1).max(2_000).nullable(),
    decidedAt: z.iso.datetime({ offset: true }).nullable(),
    decisionTargetMemoryId: z.uuid().nullable(),
  })
  .strict()
  .superRefine((input, context) => {
    const pendingFieldsAreNull =
      input.reviewerId === null &&
      input.decisionReason === null &&
      input.decidedAt === null &&
      input.decisionTargetMemoryId === null;
    if (input.decision === null && !pendingFieldsAreNull) {
      context.addIssue({
        code: "custom",
        message: "Pending proposals cannot contain decision metadata",
      });
      return;
    }
    if (
      input.decision !== null &&
      (input.reviewerId === null ||
        input.decisionReason === null ||
        input.decidedAt === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Resolved proposals require complete decision metadata",
      });
    }
    if (
      input.decision === "use_proposal" &&
      input.decisionTargetMemoryId === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["decisionTargetMemoryId"],
        message: "Using a proposal requires a deterministic conflict target",
      });
    }
    if (
      input.decision !== null &&
      input.decision !== "use_proposal" &&
      input.decisionTargetMemoryId !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["decisionTargetMemoryId"],
        message: "Only use_proposal decisions may record a target",
      });
    }
  });
export type ProposalMetadata = z.infer<typeof ProposalMetadataSchema>;

export const MemoryConflictSchema = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    proposalMemoryId: z.uuid(),
    targetMemoryId: z.uuid(),
    detector: MemoryConflictDetectorSchema,
    severity: MemoryConflictSeveritySchema,
    evidence: MemoryConflictEvidenceSchema,
    createdAt: z.iso.datetime({ offset: true }),
    resolution: ProposalReviewDecisionSchema.nullable(),
    resolvedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.proposalMemoryId === input.targetMemoryId) {
      context.addIssue({
        code: "custom",
        path: ["targetMemoryId"],
        message: "A proposal cannot conflict with itself",
      });
    }
    if ((input.resolution === null) !== (input.resolvedAt === null)) {
      context.addIssue({
        code: "custom",
        message:
          "Conflict resolution and resolution timestamp must be set together",
      });
    }
  });
export type MemoryConflict = z.infer<typeof MemoryConflictSchema>;

export const DetectedMemoryConflictSchema = z
  .object({
    targetMemoryId: z.uuid(),
    detector: MemoryConflictDetectorSchema,
    severity: MemoryConflictSeveritySchema,
    evidence: MemoryConflictEvidenceSchema,
  })
  .strict();
export type DetectedMemoryConflict = z.infer<
  typeof DetectedMemoryConflictSchema
>;

export const MemoryConflictAnalysisSchema = z
  .object({
    classification: z.enum(["conflict", "related", "not_conflict"]),
    explanation: z.string().trim().min(1).max(2_000),
  })
  .strict();
export type MemoryConflictAnalysis = z.infer<
  typeof MemoryConflictAnalysisSchema
>;

export const AgentMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string(),
    id: z.string().trim().min(1).optional(),
    timestamp: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

function addScopeConflictIssues(
  input: {
    scope?: MemoryScope | undefined;
    organization?: string | undefined;
    project?: string | undefined;
    repo?: string | undefined;
    path?: string | undefined;
    component?: string | undefined;
  },
  context: z.RefinementCtx,
): void {
  for (const field of [
    "organization",
    "project",
    "repo",
    "path",
    "component",
  ] as const) {
    const nested = input.scope?.[field];
    const flat = input[field];
    if (nested !== undefined && flat !== undefined && nested !== flat) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: `Conflicting ${field} values were provided`,
      });
    }
  }
}

export const AgentInteractionSchema = z
  .object({
    agent: z.string().trim().min(1),
    workspaceId: z.uuid().optional(),
    eventId: z.uuid().optional(),
    scope: MemoryScopeSchema.optional(),
    organization: z.string().trim().min(1).optional(),
    project: z.string().trim().min(1).optional(),
    repo: z.string().trim().min(1).optional(),
    path: z.string().trim().min(1).optional(),
    component: z.string().trim().min(1).optional(),
    sessionId: z.string().trim().min(1).optional(),
    messages: z.array(AgentMessageSchema),
  })
  .strict()
  .superRefine(addScopeConflictIssues);
export type AgentInteraction = z.infer<typeof AgentInteractionSchema>;

export const AgentTaskSchema = z
  .object({
    agent: z.string().trim().min(1),
    scope: MemoryScopeSchema.optional(),
    organization: z.string().trim().min(1).optional(),
    project: z.string().trim().min(1).optional(),
    repo: z.string().trim().min(1).optional(),
    path: z.string().trim().min(1).optional(),
    component: z.string().trim().min(1).optional(),
    task: z.string().trim().min(1),
    diff: z.string().optional(),
    files: z.array(RepositoryPathSchema).optional(),
    components: z.array(z.string()).optional(),
    symbols: z.array(z.string()).optional(),
    limit: z.number().int().positive().max(20).optional(),
  })
  .strict()
  .superRefine(addScopeConflictIssues);
export type AgentTask = z.infer<typeof AgentTaskSchema>;

export const CandidateScopeIntentSchema = z.enum([
  "organization",
  "repository",
  "uncertain",
]);
export type CandidateScopeIntent = z.infer<
  typeof CandidateScopeIntentSchema
>;

export const CandidateScopeEvidenceSchema = z
  .object({
    basis: z.enum([
      "explicit_user_statement",
      "interaction_repository",
      "extractor_inference",
    ]),
    excerpt: z.string().trim().min(1).max(500),
  })
  .strict();
export type CandidateScopeEvidence = z.infer<
  typeof CandidateScopeEvidenceSchema
>;

export const CandidateMemorySchema = z
  .object({
    content: z.string().trim().min(1),
    category: MemoryCategorySchema,
    confidence: z.number().min(0).max(1),
    triggeringMessageId: z.string().trim().min(1).optional(),
    rawText: z.string().optional(),
    supersedesMemoryId: z.uuid().optional(),
    confirmation: z
      .enum(["unconfirmed", "implicit", "explicit"])
      .optional(),
    confirmationReason: z.string().trim().min(1).max(1_000).optional(),
    reconciliationKey: z.string().trim().min(1).max(500).optional(),
    supersedesContent: z.string().trim().min(1).max(100_000).optional(),
    scopeIntent: CandidateScopeIntentSchema.optional(),
    scopeEvidence: CandidateScopeEvidenceSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.scopeIntent === "organization" &&
      input.scopeEvidence?.basis !== "explicit_user_statement"
    ) {
      context.addIssue({
        code: "custom",
        path: ["scopeEvidence"],
        message:
          "Organization scope intent requires explicit user-statement evidence",
      });
    }
    if (input.scopeIntent === undefined && input.scopeEvidence !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["scopeIntent"],
        message: "Scope evidence requires a bounded scope intent",
      });
    }
  });
export type CandidateMemory = z.infer<typeof CandidateMemorySchema>;

export const MemorySchema = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid().optional(),
    content: z.string().trim().min(1),
    scope: MemoryScopeSchema,
    category: MemoryCategorySchema,
    status: MemoryStatusSchema,
    source: MemorySourceSchema,
    confidence: z.number().min(0).max(1).optional(),
    confirmation: z
      .enum(["unconfirmed", "implicit", "explicit"])
      .optional(),
    reconciliationKey: z.string().trim().min(1).max(500).optional(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    supersedesMemoryId: z.uuid().nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    suppressedAt: z.iso.datetime({ offset: true }).nullable().default(null),
    deletedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();
export type Memory = z.infer<typeof MemorySchema>;
export const LearningSchema = MemorySchema;
export type Learning = Memory;

export const RecordProposalConflictDtoSchema = z
  .object({
    proposalMemoryId: z.uuid(),
    targetMemoryId: z.uuid(),
    detector: MemoryConflictDetectorSchema,
    severity: MemoryConflictSeveritySchema,
    evidence: MemoryConflictEvidenceSchema,
  })
  .strict()
  .refine((input) => input.proposalMemoryId !== input.targetMemoryId, {
    path: ["targetMemoryId"],
    message: "A proposal cannot conflict with itself",
  });
export type RecordProposalConflictDto = z.infer<
  typeof RecordProposalConflictDtoSchema
>;

export const ReviewProposalDtoSchema = z
  .object({
    proposalMemoryId: z.uuid(),
    decision: ProposalReviewDecisionSchema,
    reviewerId: z.string().trim().min(1).max(500),
    reason: z.string().trim().min(1).max(2_000),
    targetMemoryId: z.uuid().optional(),
    scope: MemoryScopeSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.decision === "use_proposal" && input.targetMemoryId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["targetMemoryId"],
        message: "Using a proposal requires a deterministic conflict target",
      });
    }
    if (input.decision !== "use_proposal" && input.targetMemoryId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["targetMemoryId"],
        message: "Only use_proposal decisions accept a target",
      });
    }
    if (input.scope !== undefined && input.decision === "reject") {
      context.addIssue({
        code: "custom",
        path: ["scope"],
        message: "Rejected proposals cannot change scope",
      });
    }
  });
export type ReviewProposalDto = z.infer<typeof ReviewProposalDtoSchema>;

export const ProposalRecordSchema = z
  .object({
    memory: MemorySchema,
    metadata: ProposalMetadataSchema,
    conflicts: z.array(MemoryConflictSchema),
  })
  .strict();
export type ProposalRecord = z.infer<typeof ProposalRecordSchema>;

export const ProposalDetailResponseSchema = ProposalRecordSchema.extend({
  conflictTargets: z.array(MemorySchema),
}).strict();
export type ProposalDetailResponse = z.infer<
  typeof ProposalDetailResponseSchema
>;

export const ProposeMemoryResultSchema = z
  .object({
    memory: MemorySchema,
    metadata: ProposalMetadataSchema.nullable(),
    conflicts: z.array(MemoryConflictSchema),
    inserted: z.boolean(),
  })
  .strict();
export type ProposeMemoryResult = z.infer<typeof ProposeMemoryResultSchema>;

export const ReviewProposalResponseSchema = z
  .object({
    proposal: MemorySchema,
    metadata: ProposalMetadataSchema,
    conflicts: z.array(MemoryConflictSchema),
    supersededMemory: MemorySchema.nullable(),
  })
  .strict();
export type ReviewProposalResponse = z.infer<
  typeof ReviewProposalResponseSchema
>;

export const CreateMemoryDtoSchema = z
  .object({
    content: z.string().trim().min(1),
    scope: MemoryScopeSchema,
    category: MemoryCategorySchema.optional(),
    source: MemorySourceSchema,
  })
  .strict();
export type CreateMemoryDto = z.infer<typeof CreateMemoryDtoSchema>;
export const CreateLearningDtoSchema = CreateMemoryDtoSchema;
export type CreateLearningDto = CreateMemoryDto;
export const CreateMemoryInputSchema = CreateMemoryDtoSchema;
export type CreateMemoryInput = CreateMemoryDto;
export const CreateMemoryRequestSchema = CreateMemoryDtoSchema;
export type CreateMemoryRequest = CreateMemoryDto;

export const MemoryUpdateSchema = z
  .object({
    content: z.string().trim().min(1).optional(),
    scope: MemoryScopeSchema.optional(),
    category: MemoryCategorySchema.optional(),
    status: MemoryStatusSchema.optional(),
    source: MemorySourceSchema.optional(),
    confidence: z.number().min(0).max(1).optional(),
    confirmation: z
      .enum(["unconfirmed", "implicit", "explicit"])
      .optional(),
    reconciliationKey: z.string().trim().min(1).max(500).optional(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    supersedesMemoryId: z.uuid().nullable().optional(),
    updatedAt: z.iso.datetime({ offset: true }).optional(),
    suppressedAt: z.iso.datetime({ offset: true }).nullable().optional(),
    deletedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .strict();
export type MemoryUpdate = z.infer<typeof MemoryUpdateSchema>;

export const UpdateMemoryDtoSchema = MemoryUpdateSchema.extend({
  id: z.uuid(),
});
export type UpdateMemoryDto = z.infer<typeof UpdateMemoryDtoSchema>;
export const UpdateMemoryInputSchema = UpdateMemoryDtoSchema;
export type UpdateMemoryInput = UpdateMemoryDto;

export const ListMemoriesDtoSchema = z
  .object({
    scope: MemoryScopeSchema.optional(),
    category: z
      .union([MemoryCategorySchema, z.array(MemoryCategorySchema).min(1)])
      .optional(),
    status: z
      .union([MemoryStatusSchema, z.array(MemoryStatusSchema).min(1)])
      .optional(),
    query: z.string().trim().min(1).optional(),
    limit: z.number().int().positive().max(100).optional(),
    offset: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ListMemoriesDto = z.infer<typeof ListMemoriesDtoSchema>;
export const ListLearningsDtoSchema = ListMemoriesDtoSchema;
export type ListLearningsDto = ListMemoriesDto;
export const ListMemoriesInputSchema = ListMemoriesDtoSchema;
export type ListMemoriesInput = ListMemoriesDto;

export const GetContextDtoSchema = AgentTaskSchema;
export type GetContextDto = AgentTask;
export const ContextDtoSchema = GetContextDtoSchema;
export type ContextDto = GetContextDto;
export const MemoryContextDtoSchema = GetContextDtoSchema;
export type MemoryContextDto = GetContextDto;

export const CorrectMemoryDtoSchema = z
  .object({
    memoryId: z.uuid(),
    content: z.string().trim().min(1),
    category: MemoryCategorySchema.optional(),
    scope: MemoryScopeSchema.optional(),
    source: MemorySourceSchema.optional(),
  })
  .strict();
export type CorrectMemoryDto = z.infer<typeof CorrectMemoryDtoSchema>;
export const CorrectLearningDtoSchema = CorrectMemoryDtoSchema;
export type CorrectLearningDto = CorrectMemoryDto;
export const CorrectMemoryInputSchema = CorrectMemoryDtoSchema;
export type CorrectMemoryInput = CorrectMemoryDto;

export const ForgetMemoryDtoSchema = z
  .object({
    id: z.uuid(),
  })
  .strict();
export type ForgetMemoryDto = z.infer<typeof ForgetMemoryDtoSchema>;

export const GetMemoryDtoSchema = ForgetMemoryDtoSchema;
export type GetMemoryDto = ForgetMemoryDto;

export const InsertMemoryResultSchema = z
  .object({
    memory: MemorySchema,
    inserted: z.boolean(),
  })
  .strict();
export type InsertMemoryResult = z.infer<typeof InsertMemoryResultSchema>;

export const ListMemoriesResponseSchema = z
  .object({
    memories: z.array(MemorySchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  })
  .strict();
export type ListMemoriesResponse = z.infer<typeof ListMemoriesResponseSchema>;
export const ListLearningsResponseSchema = ListMemoriesResponseSchema;
export type ListLearningsResponse = ListMemoriesResponse;

export const ObserveResponseSchema = z
  .object({
    memories: z.array(MemorySchema),
    created: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    reconciled: z.number().int().nonnegative().optional(),
    superseded: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ObserveResponse = z.infer<typeof ObserveResponseSchema>;
export const ObserveLearningsResponseSchema = ObserveResponseSchema;

export const ContextPackingSchema = z
  .object({
    policyVersion: z.literal("context-pack-v1"),
    estimator: z.literal("utf8-bytes-div-3-v1"),
    limits: z
      .object({
        requestedItems: z.number().int().positive().nullable(),
        effectiveItems: z.number().int().positive(),
        maxCharacters: z.number().int().positive(),
        maxEstimatedTokens: z.number().int().positive(),
      })
      .strict(),
    usage: z
      .object({
        retrievedItems: z.number().int().nonnegative(),
        includedItems: z.number().int().nonnegative(),
        omittedItems: z.number().int().nonnegative(),
        characters: z.number().int().nonnegative(),
        utf8Bytes: z.number().int().nonnegative(),
        estimatedTokens: z.number().int().nonnegative(),
      })
      .strict(),
    includedMemoryIds: z.array(z.uuid()),
    omitted: z.array(
      z
        .object({
          memoryId: z.uuid(),
          reason: z.enum(["items", "characters", "estimated_tokens"]),
        })
        .strict(),
    ),
    contextSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type ContextPacking = z.infer<typeof ContextPackingSchema>;

export const RetrievalMatchReasonSchema = z.enum([
  "repository",
  "path",
  "component",
  "symbol",
  "lexical",
  "semantic",
]);
export type RetrievalMatchReason = z.infer<
  typeof RetrievalMatchReasonSchema
>;

export const RetrievalHitSchema = z
  .object({
    memory: MemorySchema,
    score: z.number().nonnegative(),
    reasons: z.array(RetrievalMatchReasonSchema).min(1),
    matchedTerms: z.array(z.string()).default([]),
    lexicalRank: z.number().int().positive().nullable(),
    semanticRank: z.number().int().positive().nullable(),
  })
  .strict();
export type RetrievalHit = z.infer<typeof RetrievalHitSchema>;

export const GetContextResponseSchema = z
  .object({
    memories: z.array(MemorySchema),
    hits: z.array(RetrievalHitSchema).optional(),
    context: z.string().optional(),
    packing: ContextPackingSchema.optional(),
  })
  .strict();
export type GetContextResponse = z.infer<typeof GetContextResponseSchema>;
export const LearningContextResponseSchema = GetContextResponseSchema;

export const RememberResponseSchema = InsertMemoryResultSchema;
export type RememberResponse = InsertMemoryResult;
export const CreateMemoryResponseSchema = RememberResponseSchema;
export type CreateMemoryResponse = RememberResponse;

export const UpdateMemoryResponseSchema = z
  .object({
    memory: MemorySchema,
  })
  .strict();
export type UpdateMemoryResponse = z.infer<typeof UpdateMemoryResponseSchema>;

export const CorrectMemoryResponseSchema = z
  .object({
    memory: MemorySchema,
    supersededMemory: MemorySchema,
  })
  .strict();
export type CorrectMemoryResponse = z.infer<
  typeof CorrectMemoryResponseSchema
>;
export const CorrectResponseSchema = CorrectMemoryResponseSchema;
export type CorrectResponse = CorrectMemoryResponse;

export const ForgetMemoryResponseSchema = z
  .object({
    memory: MemorySchema,
  })
  .strict();
export type ForgetMemoryResponse = z.infer<typeof ForgetMemoryResponseSchema>;

export const GetMemoryResponseSchema = z
  .object({
    memory: MemorySchema.nullable(),
  })
  .strict();
export type GetMemoryResponse = z.infer<typeof GetMemoryResponseSchema>;

export const ContextResponseSchema = GetContextResponseSchema;
export type ContextResponse = GetContextResponse;

export function normalizeInteractionScope(
  interaction: AgentInteraction,
): MemoryScope {
  const organization =
    interaction.scope?.organization ?? interaction.organization;
  const project = interaction.scope?.project ?? interaction.project;
  const repo = interaction.scope?.repo ?? interaction.repo;
  const path = interaction.scope?.path ?? interaction.path;
  const component = interaction.scope?.component ?? interaction.component;
  return MemoryScopeSchema.parse({
    ...(organization === undefined ? {} : { organization }),
    ...(project === undefined ? {} : { project }),
    ...(repo === undefined ? {} : { repo }),
    ...(path === undefined ? {} : { path }),
    ...(component === undefined ? {} : { component }),
  });
}

export function normalizeTaskScope(task: AgentTask): MemoryScope {
  const organization = task.scope?.organization ?? task.organization;
  const project = task.scope?.project ?? task.project;
  const repo = task.scope?.repo ?? task.repo;
  const path = task.scope?.path ?? task.path;
  const component = task.scope?.component ?? task.component;
  return MemoryScopeSchema.parse({
    ...(organization === undefined ? {} : { organization }),
    ...(project === undefined ? {} : { project }),
    ...(repo === undefined ? {} : { repo }),
    ...(path === undefined ? {} : { path }),
    ...(component === undefined ? {} : { component }),
  });
}
