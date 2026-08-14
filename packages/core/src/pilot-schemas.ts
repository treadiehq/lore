import { z } from "zod";
import {
  AgentMessageSchema,
  AgentTaskSchema,
  ContextPackingSchema,
  MemorySchema,
  MemoryScopeSchema,
  ObserveResponseSchema,
  RetrievalHitSchema,
  RetrievalMatchReasonSchema,
  RepositoryPathSchema,
} from "./schemas.js";

export const WorkspaceStatusSchema = z.enum(["active", "disabled"]);
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;

export const WorkspaceSchema = z
  .object({
    id: z.uuid(),
    slug: z.string().trim().min(1).max(100),
    organization: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    status: WorkspaceStatusSchema,
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const StoredWorkspaceTokenSchema = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    name: z.string().trim().min(1).max(200),
    prefix: z.string().max(16),
    expiresAt: z.iso.datetime({ offset: true }).nullable(),
    revokedAt: z.iso.datetime({ offset: true }).nullable(),
    lastUsedAt: z.iso.datetime({ offset: true }).nullable(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type StoredWorkspaceToken = z.infer<
  typeof StoredWorkspaceTokenSchema
>;

export const AuthenticatedWorkspaceSchema = z
  .object({
    workspaceId: z.uuid(),
    organization: z.string().trim().min(1),
    tokenId: z.uuid(),
  })
  .strict();
export type AuthenticatedWorkspace = z.infer<
  typeof AuthenticatedWorkspaceSchema
>;

export const ConfirmationLevelSchema = z.enum([
  "unconfirmed",
  "implicit",
  "explicit",
]);
export type ConfirmationLevel = z.infer<typeof ConfirmationLevelSchema>;

export const TurnScopeSchema = MemoryScopeSchema.omit({
  organization: true,
});
export type TurnScope = z.infer<typeof TurnScopeSchema>;

export const ConnectorNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9._-]*$/iu);

export const PairedTurnMessageSchema = z
  .object({
    id: z.string().trim().min(1).max(500).optional(),
    content: z.string().trim().min(1).max(100_000),
    timestamp: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
export type PairedTurnMessage = z.infer<typeof PairedTurnMessageSchema>;

const PairedTurnMessageInputSchema = z
  .union([z.string().trim().min(1).max(100_000), PairedTurnMessageSchema])
  .transform((value): PairedTurnMessage =>
    typeof value === "string" ? { content: value } : value,
  );

const RawPairedTurnRequestSchema = z
  .object({
    connector: ConnectorNameSchema,
    eventId: z.string().trim().min(1).max(500).optional(),
    externalEventId: z.string().trim().min(1).max(500).optional(),
    agent: z.string().trim().min(1).max(100),
    sessionId: z.string().trim().min(1).max(500),
    conversationId: z.string().trim().min(1).max(500).optional(),
    previousAssistant: PairedTurnMessageInputSchema,
    currentUser: PairedTurnMessageInputSchema.optional(),
    currentUserPrompt: z.string().trim().min(1).max(100_000).optional(),
    scope: TurnScopeSchema.optional(),
    learningScope: TurnScopeSchema.optional(),
    project: z.string().trim().min(1).max(500).optional(),
    repo: z.string().trim().min(1).max(1_000).optional(),
    path: z.string().trim().min(1).max(2_000).optional(),
    component: z.string().trim().min(1).max(500).optional(),
    task: z.string().trim().min(1).max(100_000).optional(),
    diff: z.string().max(524_288).optional(),
    files: z.array(RepositoryPathSchema).max(500).optional(),
    components: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
    symbols: z.array(z.string().trim().min(1).max(500)).max(500).optional(),
    occurredAt: z.iso.datetime({ offset: true }).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.eventId === undefined && input.externalEventId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["eventId"],
        message: "eventId is required",
      });
    }
    if (
      input.eventId !== undefined &&
      input.externalEventId !== undefined &&
      input.eventId !== input.externalEventId
    ) {
      context.addIssue({
        code: "custom",
        path: ["externalEventId"],
        message: "eventId and externalEventId must match when both are present",
      });
    }
    if (
      (input.currentUser === undefined) ===
      (input.currentUserPrompt === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["currentUser"],
        message: "Provide exactly one of currentUser or currentUserPrompt",
      });
    }
    for (const field of ["project", "repo", "path", "component"] as const) {
      if (
        input.scope?.[field] !== undefined &&
        input[field] !== undefined &&
        input.scope[field] !== input[field]
      ) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `Conflicting ${field} values were provided`,
        });
      }
    }
  });

export const PairedTurnRequestSchema = RawPairedTurnRequestSchema.transform(
  (input) => {
    const eventId = input.eventId ?? input.externalEventId;
    const currentUser =
      input.currentUser ??
      (input.currentUserPrompt === undefined
        ? undefined
        : { content: input.currentUserPrompt });
    if (eventId === undefined || currentUser === undefined) {
      throw new Error("Paired turn validation did not produce required fields");
    }
    return {
      connector: input.connector,
      eventId,
      agent: input.agent,
      sessionId: input.sessionId,
      ...(input.conversationId === undefined
        ? {}
        : { conversationId: input.conversationId }),
      previousAssistant: input.previousAssistant,
      currentUser,
      scope: {
        ...input.scope,
        ...(input.project === undefined ? {} : { project: input.project }),
        ...(input.repo === undefined ? {} : { repo: input.repo }),
        ...(input.path === undefined ? {} : { path: input.path }),
        ...(input.component === undefined ? {} : { component: input.component }),
      },
      ...(input.learningScope === undefined
        ? {}
        : { learningScope: input.learningScope }),
      ...(input.task === undefined ? {} : { task: input.task }),
      ...(input.diff === undefined ? {} : { diff: input.diff }),
      ...(input.files === undefined ? {} : { files: input.files }),
      ...(input.components === undefined ? {} : { components: input.components }),
      ...(input.symbols === undefined ? {} : { symbols: input.symbols }),
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    };
  },
);
export type PairedTurnRequest = z.infer<typeof PairedTurnRequestSchema>;
export const PairedTurnSchema = PairedTurnRequestSchema;
export type PairedTurn = PairedTurnRequest;

const RawObservationRequestSchema = z
  .object({
    connector: ConnectorNameSchema,
    eventId: z.string().trim().min(1).max(500).optional(),
    externalEventId: z.string().trim().min(1).max(500).optional(),
    agent: z.string().trim().min(1).max(100),
    sessionId: z.string().trim().min(1).max(500),
    conversationId: z.string().trim().min(1).max(500).optional(),
    scope: TurnScopeSchema.optional(),
    learningScope: TurnScopeSchema.optional(),
    task: z.string().trim().min(1).max(100_000).optional(),
    diff: z.string().max(524_288).optional(),
    files: z.array(RepositoryPathSchema).max(500).optional(),
    messages: z.array(AgentMessageSchema).min(1).max(500),
    occurredAt: z.iso.datetime({ offset: true }),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.eventId === undefined && input.externalEventId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["eventId"],
        message: "eventId or externalEventId is required",
      });
    }
    if (
      input.eventId !== undefined &&
      input.externalEventId !== undefined &&
      input.eventId !== input.externalEventId
    ) {
      context.addIssue({
        code: "custom",
        path: ["externalEventId"],
        message: "eventId and externalEventId must match when both are present",
      });
    }
    if (!input.messages.some((message) => message.role === "user")) {
      context.addIssue({
        code: "custom",
        path: ["messages"],
        message: "At least one user message is required",
      });
    }
  });

export const ObservationRequestSchema = RawObservationRequestSchema.transform(
  (input) => {
    const eventId = input.eventId ?? input.externalEventId;
    if (eventId === undefined) {
      throw new Error("Observation validation did not produce an event ID");
    }
    const {
      externalEventId: _externalEventId,
      eventId: _eventId,
      ...rest
    } = input;
    return {
      ...rest,
      eventId,
      learningScope: input.learningScope ?? {},
    };
  },
);
export type ObservationRequestInput = z.input<typeof ObservationRequestSchema>;
export type ObservationRequest = z.output<typeof ObservationRequestSchema>;

export const DevinSessionRegistrationSchema = z
  .object({
    organizationId: z.string().trim().min(1).max(500),
    sessionId: z.string().trim().min(1).max(500),
    project: z.string().trim().min(1).max(500).optional(),
    repo: z.string().trim().min(1).max(1_000),
  })
  .strict();
export type DevinSessionRegistration = z.infer<
  typeof DevinSessionRegistrationSchema
>;

export const DevinSessionRegistrationResponseSchema = z
  .object({
    registered: z.literal(true),
    sessionId: z.string().trim().min(1).max(500),
    status: z.enum(["active", "paused", "error"]),
  })
  .strict();
export type DevinSessionRegistrationResponse = z.infer<
  typeof DevinSessionRegistrationResponseSchema
>;

export const ContextDeliveryRequestSchema = z
  .object({
    connector: ConnectorNameSchema,
    eventId: z.string().trim().min(1).max(500),
    sessionId: z.string().trim().min(1).max(500),
    task: AgentTaskSchema,
  })
  .strict();
export type ContextDeliveryRequest = z.infer<
  typeof ContextDeliveryRequestSchema
>;

export const ConnectorEventTypeSchema = z.enum([
  "observation",
  "paired_turn",
  "context_delivery",
]);
export type ConnectorEventType = z.infer<typeof ConnectorEventTypeSchema>;

export const ConnectorEventSchema = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    connector: z.string().trim().min(1).max(100),
    externalEventId: z.string().trim().min(1).max(500),
    type: ConnectorEventTypeSchema,
    agent: z.string().trim().min(1).max(100),
    sessionId: z.string().trim().min(1).max(500),
    conversationId: z.string().trim().min(1).max(500).nullable(),
    payload: z.record(z.string(), z.unknown()),
    redacted: z.boolean(),
    requestId: z.string().trim().min(1).max(128),
    occurredAt: z.iso.datetime({ offset: true }),
    receivedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type ConnectorEvent = z.infer<typeof ConnectorEventSchema>;

export const MemoryProvenanceSchema = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    memoryId: z.uuid(),
    eventId: z.uuid(),
    messageRole: z.enum(["assistant", "user"]),
    sourceMessageId: z.string().trim().min(1).max(500).nullable(),
    excerpt: z.string().max(10_000),
    redacted: z.boolean(),
    confidence: z.number().min(0).max(1),
    confirmation: ConfirmationLevelSchema,
    metadata: z.record(z.string(), z.unknown()),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type MemoryProvenance = z.infer<typeof MemoryProvenanceSchema>;

export const LearningInspectionProvenanceSchema = z
  .object({
    record: MemoryProvenanceSchema,
    event: ConnectorEventSchema,
  })
  .strict();
export type LearningInspectionProvenance = z.infer<
  typeof LearningInspectionProvenanceSchema
>;

export const LearningInspectionResponseSchema = z
  .object({
    learning: MemorySchema,
    sourceEvent: ConnectorEventSchema.nullable(),
    provenance: z.array(LearningInspectionProvenanceSchema),
    predecessor: MemorySchema.nullable(),
    successor: MemorySchema.nullable(),
  })
  .strict();
export type LearningInspectionResponse = z.infer<
  typeof LearningInspectionResponseSchema
>;

export const DeliveryReceiptSchema = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    eventId: z.uuid(),
    requestId: z.string().trim().min(1).max(128),
    memoryIds: z.array(z.uuid()),
    packing: ContextPackingSchema.nullable(),
    querySha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable()
      .default(null),
    retrievalPolicyVersion: z.string().trim().min(1).max(100).default("legacy"),
    hits: z.array(
      z
        .object({
          memoryId: z.uuid(),
          fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
          content: z.string().trim().min(1),
          score: z.number().nonnegative(),
          reasons: z.array(RetrievalMatchReasonSchema).min(1),
          matchedTerms: z.array(z.string()),
        })
        .strict(),
    ).default([]),
    deliveredAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type DeliveryReceipt = z.infer<typeof DeliveryReceiptSchema>;

export const DeliveryFeedbackActionSchema = z.enum(["wrong", "forget"]);
export type DeliveryFeedbackAction = z.infer<
  typeof DeliveryFeedbackActionSchema
>;

export const DeliveryFeedbackRequestSchema = z
  .object({
    memoryId: z.uuid(),
    action: DeliveryFeedbackActionSchema,
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type DeliveryFeedbackRequest = z.infer<
  typeof DeliveryFeedbackRequestSchema
>;

export const DeliveryFeedbackSchema = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    receiptId: z.uuid(),
    memoryId: z.uuid(),
    action: DeliveryFeedbackActionSchema,
    reason: z.string().trim().min(1).max(500),
    actorId: z.string().nullable(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type DeliveryFeedback = z.infer<typeof DeliveryFeedbackSchema>;

export const DeliveryReceiptDetailSchema = z
  .object({
    receipt: DeliveryReceiptSchema,
    event: ConnectorEventSchema,
    memories: z.array(MemorySchema),
    feedback: z.array(DeliveryFeedbackSchema),
  })
  .strict();
export type DeliveryReceiptDetail = z.infer<
  typeof DeliveryReceiptDetailSchema
>;

export const DeliveryFeedbackResponseSchema = z
  .object({
    feedback: DeliveryFeedbackSchema,
    memory: MemorySchema,
  })
  .strict();
export type DeliveryFeedbackResponse = z.infer<
  typeof DeliveryFeedbackResponseSchema
>;

export const ContextDeliveryResponseSchema = z
  .object({
    event: ConnectorEventSchema,
    receipt: DeliveryReceiptSchema,
    replayed: z.boolean(),
    memories: z.array(MemorySchema),
    hits: z.array(RetrievalHitSchema).default([]),
    context: z.string(),
    packing: ContextPackingSchema,
  })
  .strict();
export type ContextDeliveryResponse = z.infer<
  typeof ContextDeliveryResponseSchema
>;

export const ActivityMemorySchema = MemorySchema.pick({
  id: true,
  content: true,
  category: true,
  status: true,
});
export type ActivityMemory = z.infer<typeof ActivityMemorySchema>;

export const ActivityItemSchema = z
  .object({
    event: ConnectorEventSchema,
    correction: z.string(),
    learnedMemories: z.array(ActivityMemorySchema),
    deliveredMemories: z.array(ActivityMemorySchema),
    receipt: DeliveryReceiptSchema.nullable(),
  })
  .strict();
export type ActivityItem = z.infer<typeof ActivityItemSchema>;

export const ActivityQuerySchema = z
  .object({
    type: ConnectorEventTypeSchema.optional(),
    agent: z.string().trim().min(1).max(100).optional(),
    connector: ConnectorNameSchema.optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
    offset: z.coerce.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.from !== undefined &&
      input.to !== undefined &&
      Date.parse(input.from) > Date.parse(input.to)
    ) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "to must be at or after from",
      });
    }
  });
export type ActivityQuery = z.infer<typeof ActivityQuerySchema>;

export const ActivityListResponseSchema = z
  .object({
    activities: z.array(ActivityItemSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(100),
    offset: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  })
  .strict();
export type ActivityListResponse = z.infer<
  typeof ActivityListResponseSchema
>;

export const TurnObservationSchema = ObserveResponseSchema.extend({
  reconciled: z.number().int().nonnegative(),
  superseded: z.number().int().nonnegative(),
});
export type TurnObservation = z.infer<typeof TurnObservationSchema>;

export const ObservationResponseSchema = TurnObservationSchema.extend({
  event: ConnectorEventSchema,
  replayed: z.boolean(),
});
export type ObservationResponse = z.infer<typeof ObservationResponseSchema>;

export const PairedTurnResponseSchema = z
  .object({
    requestId: z.string().trim().min(1).max(128),
    event: ConnectorEventSchema,
    replayed: z.boolean(),
    observation: TurnObservationSchema,
    context: z
      .object({
        memories: z.array(MemorySchema),
        hits: z.array(RetrievalHitSchema).default([]),
        text: z.string(),
        packing: ContextPackingSchema.optional(),
      })
      .strict(),
    receipt: DeliveryReceiptSchema,
  })
  .strict();
export type PairedTurnResponse = z.infer<typeof PairedTurnResponseSchema>;
