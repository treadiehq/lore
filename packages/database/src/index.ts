import {
  createMemoryFingerprint,
  ListMemoriesDtoSchema,
  MemoryConflictSchema,
  MemorySchema,
  MemoryUpdateSchema,
  ProposalMetadataSchema,
  ReviewProposalDtoSchema,
  UpdateWorkspaceLearningPolicySchema,
  WorkspaceLearningPolicySchema,
  type FindActiveCandidatesOptions,
  type InsertMemoryConflictResult,
  type InsertMemoryResult,
  type ListMemoriesDto,
  type ListMemoriesResponse,
  type Memory,
  type MemoryConflict,
  type MemoryRepository,
  type MemoryScope,
  type MemoryUpdate,
  type ProposalMetadata,
  type ProposalRecord,
  type ProposeMemoryResult,
  type RepositoryContext,
  type ReviewProposalDto,
  type ReviewProposalResponse,
  type SupersedeMemoryResult,
  type UpdateWorkspaceLearningPolicy,
  type WorkspaceLearningPolicy,
  type WorkspaceRepositoryContext,
} from "@lore-co/core";
import {
  and,
  asc,
  cosineDistance,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  drizzle,
  type PostgresJsDatabase,
} from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import {
  memories,
  memoryConflicts,
  memoryProposals,
  workspaces,
  type MemoryConflictRow,
  type MemoryProposalRow,
  type MemoryRow,
  type NewMemoryRow,
} from "./schema.js";
import * as schema from "./schema.js";

export * from "./schema.js";
export * from "./pilot-repository.js";
export * from "./auth-repository.js";
export * from "./devin-connector-repository.js";

export type Database = PostgresJsDatabase<typeof schema>;

export interface DatabaseConnection {
  db: Database;
  client: Sql;
}

export interface CreateDatabaseOptions {
  maxConnections?: number;
  prepare?: boolean;
}

export interface SemanticMemorySearchInput {
  workspaceId: string;
  scope: MemoryScope;
  embedding: readonly number[];
  model: string;
  paths?: readonly string[];
  components?: readonly string[];
  limit: number;
  minimumSimilarity: number;
}

export function createDatabase(
  url = process.env.DATABASE_URL,
  options: CreateDatabaseOptions = {},
): DatabaseConnection {
  if (url === undefined || url.trim() === "") {
    throw new Error(
      "DATABASE_URL is required to create a PostgreSQL connection",
    );
  }
  const client = postgres(url, {
    ...(options.maxConnections === undefined
      ? {}
      : { max: options.maxConnections }),
    ...(options.prepare === undefined ? {} : { prepare: options.prepare }),
  });
  return {
    client,
    db: drizzle(client, { schema }),
  };
}

export async function closeDatabase(
  connection: DatabaseConnection,
): Promise<void> {
  await connection.client.end({ timeout: 5 });
}

export const createDb = createDatabase;
export const closeDb = closeDatabase;
export const createPostgresDatabase = createDatabase;
export const closePostgresDatabase = closeDatabase;

function rowToMemory(row: MemoryRow): Memory {
  return MemorySchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    content: row.content,
    scope: {
      ...(row.organization === null
        ? {}
        : { organization: row.organization }),
      ...(row.project === null ? {} : { project: row.project }),
      ...(row.repo === null ? {} : { repo: row.repo }),
      ...(row.path === null ? {} : { path: row.path }),
      ...(row.component === null ? {} : { component: row.component }),
    },
    category: row.category,
    status: row.status,
    source: {
      agent: row.sourceAgent,
      ...(row.sourceSessionId === null
        ? {}
        : { sessionId: row.sourceSessionId }),
      ...(row.sourceMessageId === null
        ? {}
        : { messageId: row.sourceMessageId }),
      ...(row.sourceRawText === null ? {} : { rawText: row.sourceRawText }),
      workspaceId: row.workspaceId,
      ...(row.sourceEventId === null ? {} : { eventId: row.sourceEventId }),
      ...(row.sourceRedacted ? { redacted: true } : {}),
    },
    confidence: row.confidence,
    confirmation: row.confirmation,
    ...(row.reconciliationKey === null
      ? {}
      : { reconciliationKey: row.reconciliationKey }),
    fingerprint: row.fingerprint,
    supersedesMemoryId: row.supersedesMemoryId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    suppressedAt: row.suppressedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
  });
}

function rowToProposalMetadata(row: MemoryProposalRow): ProposalMetadata {
  return ProposalMetadataSchema.parse({
    memoryId: row.memoryId,
    workspaceId: row.workspaceId,
    policyMode: row.policyMode,
    reason: row.reason,
    provenance: row.provenance,
    proposedAt: row.proposedAt.toISOString(),
    decision: row.decision,
    reviewerId: row.reviewerId,
    decisionReason: row.decisionReason,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionTargetMemoryId: row.decisionTargetMemoryId,
  });
}

function rowToMemoryConflict(row: MemoryConflictRow): MemoryConflict {
  return MemoryConflictSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    proposalMemoryId: row.proposalMemoryId,
    targetMemoryId: row.targetMemoryId,
    detector: row.detector,
    severity: row.severity,
    evidence: row.evidence,
    createdAt: row.createdAt.toISOString(),
    resolution: row.resolution,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  });
}

function requiredMemoryWorkspaceId(memory: Memory): string {
  const workspaceId = memory.workspaceId ?? memory.source.workspaceId;
  if (workspaceId === undefined) {
    throw new Error("Database memories require a workspace ID");
  }
  return workspaceId;
}

const FINGERPRINT_RESERVING_STATUSES = [
  "active",
  "proposed",
  "suppressed",
] as const;

function memoryToRow(memory: Memory): NewMemoryRow {
  const workspaceId = requiredMemoryWorkspaceId(memory);
  return {
    id: memory.id,
    workspaceId,
    content: memory.content,
    organization: memory.scope.organization ?? null,
    project: memory.scope.project ?? null,
    repo: memory.scope.repo ?? null,
    path: memory.scope.path ?? null,
    component: memory.scope.component ?? null,
    category: memory.category,
    status: memory.status,
    sourceAgent: memory.source.agent,
    sourceSessionId: memory.source.sessionId ?? null,
    sourceMessageId: memory.source.messageId ?? null,
    sourceRawText: memory.source.rawText ?? null,
    sourceEventId: memory.source.eventId ?? null,
    sourceRedacted: memory.source.redacted ?? false,
    confidence: memory.confidence ?? 1,
    confirmation: memory.confirmation ?? "unconfirmed",
    reconciliationKey: memory.reconciliationKey ?? null,
    fingerprint: memory.fingerprint,
    supersedesMemoryId: memory.supersedesMemoryId,
    createdAt: new Date(memory.createdAt),
    updatedAt: new Date(memory.updatedAt),
    suppressedAt:
      memory.suppressedAt === null ? null : new Date(memory.suppressedAt),
    deletedAt:
      memory.deletedAt === null ? null : new Date(memory.deletedAt),
  };
}

function oneOrMany<T>(value: T | T[] | undefined): T[] | undefined {
  return value === undefined ? undefined : Array.isArray(value) ? value : [value];
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&");
}

function whereFrom(conditions: SQL[]): SQL | undefined {
  return conditions.length === 0 ? undefined : and(...conditions);
}

function activeScopeConditions(
  scope: MemoryScope,
  options: Pick<
    FindActiveCandidatesOptions,
    "workspaceId" | "paths" | "components"
  > = {},
): SQL[] {
  const paths = [
    ...new Set(
      [scope.path, ...(options.paths ?? [])].filter(
        (value): value is string => value !== undefined,
      ),
    ),
  ];
  const components = [
    ...new Set(
      [scope.component, ...(options.components ?? [])].filter(
        (value): value is string => value !== undefined,
      ),
    ),
  ];
  return [
    eq(memories.status, "active"),
    ...(options.workspaceId === undefined
      ? []
      : [eq(memories.workspaceId, options.workspaceId)]),
    scope.organization === undefined
      ? isNull(memories.organization)
      : eq(memories.organization, scope.organization),
    scope.project === undefined
      ? isNull(memories.project)
      : (or(
          isNull(memories.project),
          eq(memories.project, scope.project),
        ) as SQL),
    scope.repo === undefined
      ? isNull(memories.repo)
      : (or(isNull(memories.repo), eq(memories.repo, scope.repo)) as SQL),
    paths.length === 0
      ? isNull(memories.path)
      : (or(
          isNull(memories.path),
          ...paths.map(
            (path) =>
              sql`(${path} = ${memories.path} OR left(${path}, length(${memories.path}) + 1) = (${memories.path} || '/'))`,
          ),
        ) as SQL),
    components.length === 0
      ? isNull(memories.component)
      : (or(
          isNull(memories.component),
          inArray(memories.component, components),
        ) as SQL),
  ];
}

export class PostgresMemoryRepository implements MemoryRepository {
  readonly #db: Database;

  constructor(database: Database | DatabaseConnection) {
    this.#db = "db" in database ? database.db : database;
  }

  async insert(memoryInput: Memory): Promise<InsertMemoryResult> {
    const memory = MemorySchema.parse(memoryInput);
    if (memory.status === "proposed") {
      throw new Error("Proposed memories must be inserted with proposal metadata");
    }
    const workspaceId = requiredMemoryWorkspaceId(memory);
    const inserted = await this.#db
      .insert(memories)
      .values(memoryToRow(memory))
      .onConflictDoNothing({
        target: [memories.workspaceId, memories.fingerprint],
        where: inArray(memories.status, FINGERPRINT_RESERVING_STATUSES),
      })
      .returning();
    const insertedRow = inserted[0];
    if (insertedRow !== undefined) {
      return { memory: rowToMemory(insertedRow), inserted: true };
    }

    const existing = await this.#db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.workspaceId, workspaceId),
          eq(memories.fingerprint, memory.fingerprint),
          inArray(memories.status, FINGERPRINT_RESERVING_STATUSES),
        ),
      )
      .limit(1);
    const existingRow = existing[0];
    if (existingRow === undefined) {
      throw new Error(
        `Memory insert conflicted but fingerprint was not found: ${memory.fingerprint}`,
      );
    }
    return { memory: rowToMemory(existingRow), inserted: false };
  }

  async propose(
    memoryInput: Memory,
    metadataInput: ProposalMetadata,
    conflictInputs: readonly MemoryConflict[] = [],
  ): Promise<ProposeMemoryResult> {
    const memory = MemorySchema.parse(memoryInput);
    const metadata = ProposalMetadataSchema.parse(metadataInput);
    const conflicts = conflictInputs.map((conflict) =>
      MemoryConflictSchema.parse(conflict),
    );
    const workspaceId = requiredMemoryWorkspaceId(memory);
    if (memory.status !== "proposed") {
      throw new Error("Proposal insertion requires proposed memory status");
    }
    if (
      metadata.memoryId !== memory.id ||
      metadata.workspaceId !== workspaceId
    ) {
      throw new Error("Proposal metadata does not match its memory");
    }
    if (
      metadata.decision !== null ||
      JSON.stringify(metadata.provenance) !== JSON.stringify(memory.source)
    ) {
      throw new Error("New proposal metadata must contain pending provenance");
    }
    const conflictEdges = new Set<string>();
    for (const conflict of conflicts) {
      if (
        conflict.workspaceId !== workspaceId ||
        conflict.proposalMemoryId !== memory.id ||
        conflict.resolution !== null
      ) {
        throw new Error("Proposal conflict metadata is inconsistent");
      }
      const edge = `${conflict.targetMemoryId}\0${conflict.detector}`;
      if (conflictEdges.has(edge)) {
        throw new Error("Duplicate conflict edge in proposal");
      }
      conflictEdges.add(edge);
    }

    return this.#db.transaction(async (transaction) => {
      const inserted = await transaction
        .insert(memories)
        .values(memoryToRow(memory))
        .onConflictDoNothing({
          target: [memories.workspaceId, memories.fingerprint],
          where: inArray(memories.status, FINGERPRINT_RESERVING_STATUSES),
        })
        .returning();
      const insertedRow = inserted[0];
      if (insertedRow === undefined) {
        const existingRows = await transaction
          .select()
          .from(memories)
          .where(
            and(
              eq(memories.workspaceId, workspaceId),
              eq(memories.fingerprint, memory.fingerprint),
              inArray(memories.status, FINGERPRINT_RESERVING_STATUSES),
            ),
          )
          .limit(1);
        const existing = existingRows[0];
        if (existing === undefined) {
          throw new Error(
            `Memory proposal conflicted but fingerprint was not found: ${memory.fingerprint}`,
          );
        }
        const proposalRows =
          existing.status === "proposed"
            ? await transaction
                .select()
                .from(memoryProposals)
                .where(
                  and(
                    eq(memoryProposals.memoryId, existing.id),
                    eq(memoryProposals.workspaceId, workspaceId),
                  ),
                )
                .limit(1)
            : [];
        const conflictRows =
          existing.status === "proposed"
            ? await transaction
                .select()
                .from(memoryConflicts)
                .where(
                  and(
                    eq(memoryConflicts.proposalMemoryId, existing.id),
                    eq(memoryConflicts.workspaceId, workspaceId),
                  ),
                )
                .orderBy(
                  asc(memoryConflicts.createdAt),
                  memoryConflicts.id,
                )
            : [];
        return {
          memory: rowToMemory(existing),
          metadata:
            proposalRows[0] === undefined
              ? null
              : rowToProposalMetadata(proposalRows[0]),
          conflicts: conflictRows.map(rowToMemoryConflict),
          inserted: false,
        };
      }

      for (const conflict of conflicts) {
        const targetRows = await transaction
          .select({ id: memories.id, status: memories.status })
          .from(memories)
          .where(
            and(
              eq(memories.id, conflict.targetMemoryId),
              eq(memories.workspaceId, workspaceId),
              inArray(memories.status, ["active", "suppressed"]),
            ),
          )
          .limit(1);
        if (targetRows[0] === undefined) {
          throw new Error(
            `Conflict target is not reviewable: ${conflict.targetMemoryId}`,
          );
        }
      }

      await transaction.insert(memoryProposals).values({
        memoryId: metadata.memoryId,
        workspaceId,
        policyMode: metadata.policyMode,
        reason: metadata.reason,
        provenance: metadata.provenance,
        proposedAt: new Date(metadata.proposedAt),
      });
      if (conflicts.length > 0) {
        await transaction.insert(memoryConflicts).values(
          conflicts.map((conflict) => ({
            id: conflict.id,
            workspaceId,
            proposalMemoryId: conflict.proposalMemoryId,
            targetMemoryId: conflict.targetMemoryId,
            detector: conflict.detector,
            severity: conflict.severity,
            evidence: conflict.evidence,
            createdAt: new Date(conflict.createdAt),
          })),
        );
      }
      return {
        memory: rowToMemory(insertedRow),
        metadata,
        conflicts: [...conflicts],
        inserted: true,
      };
    });
  }

  async get(
    id: string,
    context: RepositoryContext = {},
  ): Promise<Memory | null> {
    const rows = await this.#db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.id, id),
          ...(context.workspaceId === undefined
            ? []
            : [eq(memories.workspaceId, context.workspaceId)]),
        ),
      )
      .limit(1);
    return rows[0] === undefined ? null : rowToMemory(rows[0]);
  }

  async getProposal(
    memoryId: string,
    context: RepositoryContext = {},
  ): Promise<ProposalRecord | null> {
    const memoryRows = await this.#db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.id, memoryId),
          ...(context.workspaceId === undefined
            ? []
            : [eq(memories.workspaceId, context.workspaceId)]),
        ),
      )
      .limit(1);
    const memory = memoryRows[0];
    if (memory === undefined) {
      return null;
    }
    const proposalRows = await this.#db
      .select()
      .from(memoryProposals)
      .where(
        and(
          eq(memoryProposals.memoryId, memoryId),
          eq(memoryProposals.workspaceId, memory.workspaceId),
        ),
      )
      .limit(1);
    const metadata = proposalRows[0];
    if (metadata === undefined) {
      return null;
    }
    const conflictRows = await this.#db
      .select()
      .from(memoryConflicts)
      .where(
        and(
          eq(memoryConflicts.proposalMemoryId, memoryId),
          eq(memoryConflicts.workspaceId, memory.workspaceId),
        ),
      )
      .orderBy(asc(memoryConflicts.createdAt), memoryConflicts.id);
    return {
      memory: rowToMemory(memory),
      metadata: rowToProposalMetadata(metadata),
      conflicts: conflictRows.map(rowToMemoryConflict),
    };
  }

  async addProposalConflict(
    conflictInput: MemoryConflict,
    context: WorkspaceRepositoryContext,
  ): Promise<InsertMemoryConflictResult> {
    const conflict = MemoryConflictSchema.parse(conflictInput);
    if (
      conflict.workspaceId !== context.workspaceId ||
      conflict.resolution !== null
    ) {
      throw new Error("Conflict workspace or resolution is invalid");
    }

    return this.#db.transaction(async (transaction) => {
      const proposalRows = await transaction
        .select({ id: memories.id, status: memories.status })
        .from(memories)
        .where(
          and(
            eq(memories.id, conflict.proposalMemoryId),
            eq(memories.workspaceId, context.workspaceId),
          ),
        )
        .limit(1)
        .for("update");
      const proposal = proposalRows[0];
      if (proposal === undefined || proposal.status !== "proposed") {
        throw new Error(`Proposed memory not found: ${conflict.proposalMemoryId}`);
      }
      const metadataRows = await transaction
        .select({ decision: memoryProposals.decision })
        .from(memoryProposals)
        .where(
          and(
            eq(memoryProposals.memoryId, conflict.proposalMemoryId),
            eq(memoryProposals.workspaceId, context.workspaceId),
          ),
        )
        .limit(1);
      if (metadataRows[0] === undefined || metadataRows[0].decision !== null) {
        throw new Error(`Proposal has already been resolved: ${proposal.id}`);
      }
      const targetRows = await transaction
        .select({ id: memories.id })
        .from(memories)
        .where(
          and(
            eq(memories.id, conflict.targetMemoryId),
            eq(memories.workspaceId, context.workspaceId),
            inArray(memories.status, ["active", "suppressed"]),
          ),
        )
        .limit(1);
      if (targetRows[0] === undefined) {
        throw new Error(
          `Conflict target is not reviewable: ${conflict.targetMemoryId}`,
        );
      }

      const insertedRows = await transaction
        .insert(memoryConflicts)
        .values({
          id: conflict.id,
          workspaceId: context.workspaceId,
          proposalMemoryId: conflict.proposalMemoryId,
          targetMemoryId: conflict.targetMemoryId,
          detector: conflict.detector,
          severity: conflict.severity,
          evidence: conflict.evidence,
          createdAt: new Date(conflict.createdAt),
        })
        .onConflictDoNothing({
          target: [
            memoryConflicts.workspaceId,
            memoryConflicts.proposalMemoryId,
            memoryConflicts.targetMemoryId,
            memoryConflicts.detector,
          ],
        })
        .returning();
      const inserted = insertedRows[0];
      if (inserted !== undefined) {
        return { conflict: rowToMemoryConflict(inserted), inserted: true };
      }
      const existingRows = await transaction
        .select()
        .from(memoryConflicts)
        .where(
          and(
            eq(memoryConflicts.workspaceId, context.workspaceId),
            eq(
              memoryConflicts.proposalMemoryId,
              conflict.proposalMemoryId,
            ),
            eq(memoryConflicts.targetMemoryId, conflict.targetMemoryId),
            eq(memoryConflicts.detector, conflict.detector),
          ),
        )
        .limit(1);
      const existing = existingRows[0];
      if (existing === undefined) {
        throw new Error("Conflict insert raced without a stored edge");
      }
      return { conflict: rowToMemoryConflict(existing), inserted: false };
    });
  }

  async reviewProposal(
    inputValue: ReviewProposalDto,
    context: WorkspaceRepositoryContext,
  ): Promise<ReviewProposalResponse> {
    const input = ReviewProposalDtoSchema.parse(inputValue);
    return this.#db.transaction(async (transaction) => {
      const proposalRows = await transaction
        .select()
        .from(memories)
        .where(
          and(
            eq(memories.id, input.proposalMemoryId),
            eq(memories.workspaceId, context.workspaceId),
          ),
        )
        .limit(1)
        .for("update");
      const proposalRow = proposalRows[0];
      if (proposalRow === undefined) {
        throw new Error(`Proposal not found: ${input.proposalMemoryId}`);
      }
      const metadataRows = await transaction
        .select()
        .from(memoryProposals)
        .where(
          and(
            eq(memoryProposals.memoryId, input.proposalMemoryId),
            eq(memoryProposals.workspaceId, context.workspaceId),
          ),
        )
        .limit(1)
        .for("update");
      const metadataRow = metadataRows[0];
      if (metadataRow === undefined) {
        throw new Error(`Proposal not found: ${input.proposalMemoryId}`);
      }
      if (metadataRow.decision !== null || proposalRow.status !== "proposed") {
        throw new Error(
          `Proposal has already been resolved: ${input.proposalMemoryId}`,
        );
      }

      const conflictRows = await transaction
        .select()
        .from(memoryConflicts)
        .where(
          and(
            eq(memoryConflicts.workspaceId, context.workspaceId),
            eq(
              memoryConflicts.proposalMemoryId,
              input.proposalMemoryId,
            ),
            isNull(memoryConflicts.resolution),
          ),
        )
        .orderBy(asc(memoryConflicts.createdAt), memoryConflicts.id)
        .for("update");
      const blockingConflicts = conflictRows.filter(
        (conflict) => conflict.severity === "blocking",
      );
      if (
        input.decision === "approve" &&
        (proposalRow.supersedesMemoryId !== null ||
          blockingConflicts.length > 0)
      ) {
        throw new Error(
          "Blocked proposals cannot be approved without resolution",
        );
      }

      const decidedAt = new Date();
      let supersededRow: MemoryRow | undefined;
      let targetId: string | null = null;
      if (input.decision === "use_proposal") {
        if (input.targetMemoryId === undefined) {
          throw new Error(
            "Using a proposal requires a deterministic conflict target",
          );
        }
        targetId = input.targetMemoryId;
        const deterministicConflict = conflictRows.find(
          (conflict) =>
            conflict.targetMemoryId === targetId &&
            conflict.detector === "deterministic" &&
            conflict.severity === "blocking",
        );
        if (deterministicConflict === undefined) {
          throw new Error(
            "Using a proposal requires an open deterministic blocking conflict",
          );
        }
        if (
          blockingConflicts.some(
            (conflict) => conflict.targetMemoryId !== targetId,
          )
        ) {
          throw new Error(
            "Proposal has additional blocking conflicts that require keep_both or reject",
          );
        }
        if (
          proposalRow.supersedesMemoryId !== null &&
          proposalRow.supersedesMemoryId !== targetId
        ) {
          throw new Error(
            "Proposal lineage does not match the conflict target",
          );
        }
        const targetRows = await transaction
          .select()
          .from(memories)
          .where(
            and(
              eq(memories.id, targetId),
              eq(memories.workspaceId, context.workspaceId),
            ),
          )
          .limit(1)
          .for("update");
        const target = targetRows[0];
        if (
          target === undefined ||
          (target.status !== "active" && target.status !== "suppressed")
        ) {
          throw new Error(`Conflict target is not replaceable: ${targetId}`);
        }
        const supersededRows = await transaction
          .update(memories)
          .set({
            status: "superseded",
            updatedAt: decidedAt,
            suppressedAt: null,
          })
          .where(
            and(
              eq(memories.id, targetId),
              eq(memories.workspaceId, context.workspaceId),
              inArray(memories.status, ["active", "suppressed"]),
            ),
          )
          .returning();
        supersededRow = supersededRows[0];
        if (supersededRow === undefined) {
          throw new Error(`Conflict target changed during review: ${targetId}`);
        }
      }

      const nextSupersedesMemoryId =
        input.decision === "use_proposal" ? targetId : null;
      const nextScope = input.scope ?? rowToMemory(proposalRow).scope;
      const nextFingerprint = createMemoryFingerprint({
        content: proposalRow.content,
        scope: nextScope,
        category: proposalRow.category,
        supersedesMemoryId: nextSupersedesMemoryId,
      });
      const reviewedRows = await transaction
        .update(memories)
        .set({
          status: input.decision === "reject" ? "deleted" : "active",
          organization: nextScope.organization ?? null,
          project: nextScope.project ?? null,
          repo: nextScope.repo ?? null,
          path: nextScope.path ?? null,
          component: nextScope.component ?? null,
          fingerprint: nextFingerprint,
          supersedesMemoryId: nextSupersedesMemoryId,
          updatedAt: decidedAt,
          suppressedAt: null,
          deletedAt: input.decision === "reject" ? decidedAt : null,
        })
        .where(
          and(
            eq(memories.id, input.proposalMemoryId),
            eq(memories.workspaceId, context.workspaceId),
            eq(memories.status, "proposed"),
          ),
        )
        .returning();
      const reviewedRow = reviewedRows[0];
      if (reviewedRow === undefined) {
        throw new Error(
          `Proposal changed during review: ${input.proposalMemoryId}`,
        );
      }

      const decidedMetadataRows = await transaction
        .update(memoryProposals)
        .set({
          decision: input.decision,
          reviewerId: input.reviewerId,
          decisionReason: input.reason,
          decidedAt,
          decisionTargetMemoryId: targetId,
        })
        .where(
          and(
            eq(memoryProposals.memoryId, input.proposalMemoryId),
            eq(memoryProposals.workspaceId, context.workspaceId),
            isNull(memoryProposals.decision),
          ),
        )
        .returning();
      const decidedMetadata = decidedMetadataRows[0];
      if (decidedMetadata === undefined) {
        throw new Error(
          `Proposal decision raced during review: ${input.proposalMemoryId}`,
        );
      }

      if (conflictRows.length > 0) {
        await transaction
          .update(memoryConflicts)
          .set({
            resolution: input.decision,
            resolvedAt: decidedAt,
          })
          .where(
            and(
              eq(memoryConflicts.workspaceId, context.workspaceId),
              eq(
                memoryConflicts.proposalMemoryId,
                input.proposalMemoryId,
              ),
              isNull(memoryConflicts.resolution),
            ),
          );
      }
      const resolvedConflictRows = await transaction
        .select()
        .from(memoryConflicts)
        .where(
          and(
            eq(memoryConflicts.workspaceId, context.workspaceId),
            eq(
              memoryConflicts.proposalMemoryId,
              input.proposalMemoryId,
            ),
          ),
        )
        .orderBy(asc(memoryConflicts.createdAt), memoryConflicts.id);
      return {
        proposal: rowToMemory(reviewedRow),
        metadata: rowToProposalMetadata(decidedMetadata),
        conflicts: resolvedConflictRows.map(rowToMemoryConflict),
        supersededMemory:
          supersededRow === undefined ? null : rowToMemory(supersededRow),
      };
    });
  }

  async getWorkspaceLearningPolicy(
    workspaceId: string,
  ): Promise<WorkspaceLearningPolicy> {
    const rows = await this.#db
      .select({
        workspaceId: workspaces.id,
        learningMode: workspaces.learningMode,
        llmConflictAnalysisEnabled: workspaces.llmConflictAnalysisEnabled,
        updatedAt: workspaces.updatedAt,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
    return WorkspaceLearningPolicySchema.parse({
      ...row,
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  async updateWorkspaceLearningPolicy(
    workspaceId: string,
    updateInput: UpdateWorkspaceLearningPolicy,
  ): Promise<WorkspaceLearningPolicy> {
    const update = UpdateWorkspaceLearningPolicySchema.parse(updateInput);
    const rows = await this.#db
      .update(workspaces)
      .set({
        ...(update.learningMode === undefined
          ? {}
          : { learningMode: update.learningMode }),
        ...(update.llmConflictAnalysisEnabled === undefined
          ? {}
          : {
              llmConflictAnalysisEnabled:
                update.llmConflictAnalysisEnabled,
            }),
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, workspaceId))
      .returning({
        workspaceId: workspaces.id,
        learningMode: workspaces.learningMode,
        llmConflictAnalysisEnabled: workspaces.llmConflictAnalysisEnabled,
        updatedAt: workspaces.updatedAt,
      });
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
    return WorkspaceLearningPolicySchema.parse({
      ...row,
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  async list(
    input: ListMemoriesDto = {},
    context: RepositoryContext = {},
  ): Promise<ListMemoriesResponse> {
    const filters = ListMemoriesDtoSchema.parse(input);
    const conditions: SQL[] = [];
    if (context.workspaceId !== undefined) {
      conditions.push(eq(memories.workspaceId, context.workspaceId));
    }
    if (filters.scope?.organization !== undefined) {
      conditions.push(
        eq(memories.organization, filters.scope.organization),
      );
    }
    if (filters.scope?.project !== undefined) {
      conditions.push(eq(memories.project, filters.scope.project));
    }
    if (filters.scope?.repo !== undefined) {
      conditions.push(eq(memories.repo, filters.scope.repo));
    }
    if (filters.scope?.path !== undefined) {
      conditions.push(eq(memories.path, filters.scope.path));
    }
    if (filters.scope?.component !== undefined) {
      conditions.push(eq(memories.component, filters.scope.component));
    }

    const categories = oneOrMany(filters.category);
    if (categories !== undefined) {
      conditions.push(inArray(memories.category, categories));
    }
    const statuses = oneOrMany(filters.status);
    if (statuses !== undefined) {
      conditions.push(inArray(memories.status, statuses));
    }
    if (filters.query !== undefined) {
      conditions.push(
        ilike(memories.content, `%${escapeLike(filters.query)}%`),
      );
    }

    const where = whereFrom(conditions);
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;
    const [rows, totals] = await Promise.all([
      this.#db
        .select()
        .from(memories)
        .where(where)
        .orderBy(desc(memories.createdAt), memories.id)
        .limit(limit)
        .offset(offset),
      this.#db
        .select({ value: count() })
        .from(memories)
        .where(where),
    ]);

    return {
      memories: rows.map(rowToMemory),
      total: totals[0]?.value ?? 0,
      limit,
      offset,
    };
  }

  async update(
    id: string,
    updateInput: MemoryUpdate,
    context: RepositoryContext = {},
  ): Promise<Memory | null> {
    const update = MemoryUpdateSchema.parse(updateInput);
    if (update.status !== undefined) {
      const current = await this.get(id, context);
      if (current === null) {
        return null;
      }
      if (
        (current.status === "proposed" || update.status === "proposed") &&
        update.status !== current.status
      ) {
        throw new Error(
          "Proposed memories must be resolved with reviewProposal",
        );
      }
    }
    const values: Partial<NewMemoryRow> = {
      updatedAt:
        update.updatedAt === undefined
          ? new Date()
          : new Date(update.updatedAt),
    };
    if (update.content !== undefined) {
      values.content = update.content;
      values.embedding = null;
      values.embeddingModel = null;
      values.embeddedAt = null;
    }
    if (update.scope !== undefined) {
      values.organization = update.scope.organization ?? null;
      values.project = update.scope.project ?? null;
      values.repo = update.scope.repo ?? null;
      values.path = update.scope.path ?? null;
      values.component = update.scope.component ?? null;
    }
    if (update.category !== undefined) {
      values.category = update.category;
    }
    if (update.status !== undefined) {
      values.status = update.status;
    }
    if (update.source !== undefined) {
      values.sourceAgent = update.source.agent;
      values.sourceSessionId = update.source.sessionId ?? null;
      values.sourceMessageId = update.source.messageId ?? null;
      values.sourceRawText = update.source.rawText ?? null;
      values.sourceEventId = update.source.eventId ?? null;
      values.sourceRedacted = update.source.redacted ?? false;
      if (update.source.workspaceId !== undefined) {
        values.workspaceId = update.source.workspaceId;
      }
    }
    if (update.confidence !== undefined) {
      values.confidence = update.confidence;
    }
    if (update.confirmation !== undefined) {
      values.confirmation = update.confirmation;
    }
    if (update.reconciliationKey !== undefined) {
      values.reconciliationKey = update.reconciliationKey;
    }
    if (update.fingerprint !== undefined) {
      values.fingerprint = update.fingerprint;
    } else if (
      update.content !== undefined ||
      update.scope !== undefined ||
      update.category !== undefined ||
      update.supersedesMemoryId !== undefined
    ) {
      const current = await this.get(id, context);
      if (current === null) {
        return null;
      }
      values.fingerprint = createMemoryFingerprint({
        content: update.content ?? current.content,
        scope: update.scope ?? current.scope,
        category: update.category ?? current.category,
        supersedesMemoryId:
          update.supersedesMemoryId === undefined
            ? current.supersedesMemoryId
            : update.supersedesMemoryId,
      });
    }
    if (update.supersedesMemoryId !== undefined) {
      values.supersedesMemoryId = update.supersedesMemoryId;
    }
    if (update.suppressedAt !== undefined) {
      values.suppressedAt =
        update.suppressedAt === null ? null : new Date(update.suppressedAt);
    }
    if (update.deletedAt !== undefined) {
      values.deletedAt =
        update.deletedAt === null ? null : new Date(update.deletedAt);
    }

    const rows = await this.#db
      .update(memories)
      .set(values)
      .where(
        and(
          eq(memories.id, id),
          ...(context.workspaceId === undefined
            ? []
            : [eq(memories.workspaceId, context.workspaceId)]),
        ),
      )
      .returning();
    return rows[0] === undefined ? null : rowToMemory(rows[0]);
  }

  async softDelete(
    id: string,
    deletedAt = new Date().toISOString(),
    context: RepositoryContext = {},
  ): Promise<Memory | null> {
    const current = await this.get(id, context);
    if (current === null || current.status === "deleted") {
      return current;
    }
    return this.update(
      id,
      {
        status: "deleted",
        suppressedAt: null,
        deletedAt,
        updatedAt: deletedAt,
      },
      context,
    );
  }

  async findActiveScopeCandidates(
    scope: MemoryScope,
    options: FindActiveCandidatesOptions = {},
  ): Promise<Memory[]> {
    const conditions = activeScopeConditions(scope, options);
    if (options.requirePathOrComponentMatch === true) {
      const signalConditions: SQL[] = [
        ...(options.paths ?? []).map(
          (path) =>
            sql`(${path} = ${memories.path} OR left(${path}, length(${memories.path}) + 1) = (${memories.path} || '/'))`,
        ),
        ...((options.components?.length ?? 0) === 0
          ? []
          : [inArray(memories.component, [...(options.components ?? [])])]),
      ];
      if (signalConditions.length === 0) {
        return [];
      }
      conditions.push(or(...signalConditions) as SQL);
    }
    const keywords = [
      ...new Set(
        (options.keywords ?? [])
          .map((keyword) => keyword.trim())
          .filter((keyword) => keyword.length >= 2)
          .slice(0, 100),
      ),
    ];
    if (keywords.length > 0) {
      const searchQuery = keywords
        .map((keyword) => `"${keyword.replaceAll('"', " ")}"`)
        .join(" OR ");
      conditions.push(
        or(
          sql`to_tsvector('simple', ${memories.content}) @@ websearch_to_tsquery('simple', ${searchQuery})`,
          ...keywords.map((keyword) =>
            ilike(memories.content, `%${escapeLike(keyword)}%`),
          ),
        ) as SQL,
      );
    }

    const rows = await this.#db
      .select()
      .from(memories)
      .where(and(...conditions))
      .orderBy(desc(memories.updatedAt), memories.id)
      .limit(Math.max(1, Math.min(options.limit ?? 100, 500)));
    return rows.map(rowToMemory);
  }

  async search(input: SemanticMemorySearchInput): Promise<Memory[]> {
    if (
      input.embedding.length !== 1_536 ||
      !input.embedding.every((value) => Number.isFinite(value))
    ) {
      throw new Error("Semantic search requires 1536 finite embedding values");
    }
    if (
      !Number.isFinite(input.minimumSimilarity) ||
      input.minimumSimilarity < 0 ||
      input.minimumSimilarity > 1
    ) {
      throw new Error("Semantic minimum similarity must be between 0 and 1");
    }
    const conditions = activeScopeConditions(input.scope, {
      workspaceId: input.workspaceId,
      ...(input.paths === undefined ? {} : { paths: input.paths }),
      ...(input.components === undefined
        ? {}
        : { components: input.components }),
    });
    conditions.push(
      isNotNull(memories.embedding),
      eq(memories.embeddingModel, input.model),
    );
    const distance = cosineDistance(memories.embedding, [...input.embedding]);
    conditions.push(lte(distance, 1 - input.minimumSimilarity));
    const rows = await this.#db
      .select()
      .from(memories)
      .where(and(...conditions))
      .orderBy(distance, desc(memories.updatedAt), memories.id)
      .limit(Math.max(1, Math.min(input.limit, 200)));
    return rows.map(rowToMemory);
  }

  async upsertEmbedding(input: {
    memory: Memory;
    model: string;
    embedding: readonly number[];
  }): Promise<void> {
    const workspaceId = input.memory.workspaceId ?? input.memory.source.workspaceId;
    if (workspaceId === undefined) {
      return;
    }
    if (
      input.embedding.length !== 1_536 ||
      !input.embedding.every((value) => Number.isFinite(value))
    ) {
      throw new Error("Memory embedding requires 1536 finite values");
    }
    await this.#db
      .update(memories)
      .set({
        embedding: [...input.embedding],
        embeddingModel: input.model,
        embeddedAt: new Date(),
      })
      .where(
        and(
          eq(memories.id, input.memory.id),
          eq(memories.workspaceId, workspaceId),
          eq(memories.status, "active"),
        ),
      );
  }

  async listNeedingEmbedding(input: {
    model: string;
    limit: number;
  }): Promise<Memory[]> {
    const rows = await this.#db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.status, "active"),
          isNotNull(memories.workspaceId),
          or(
            isNull(memories.embedding),
            isNull(memories.embeddingModel),
            ne(memories.embeddingModel, input.model),
          ),
        ),
      )
      .orderBy(memories.updatedAt, memories.id)
      .limit(Math.max(1, Math.min(input.limit, 500)));
    return rows.map(rowToMemory);
  }

  async supersede(
    memoryId: string,
    replacementInput: Memory,
    context: RepositoryContext = {},
  ): Promise<SupersedeMemoryResult> {
    const replacement = MemorySchema.parse(replacementInput);
    const workspaceId = requiredMemoryWorkspaceId(replacement);
    if (
      context.workspaceId !== undefined &&
      context.workspaceId !== workspaceId
    ) {
      throw new Error(`Memory not found: ${memoryId}`);
    }
    if (replacement.supersedesMemoryId !== memoryId) {
      throw new Error("Replacement must reference the memory it supersedes");
    }

    return this.#db.transaction(async (transaction) => {
      const currentRows = await transaction
        .select()
        .from(memories)
        .where(
          and(
            eq(memories.id, memoryId),
            eq(memories.workspaceId, workspaceId),
          ),
        )
        .limit(1)
        .for("update");
      const current = currentRows[0];
      if (current === undefined) {
        throw new Error(`Memory not found: ${memoryId}`);
      }
      if (current.status === "superseded") {
        const existingRows = await transaction
          .select()
          .from(memories)
          .where(
            and(
              eq(memories.workspaceId, workspaceId),
              eq(memories.fingerprint, replacement.fingerprint),
              inArray(memories.status, FINGERPRINT_RESERVING_STATUSES),
            ),
          )
          .limit(1);
        const existing = existingRows[0];
        if (existing?.supersedesMemoryId === memoryId) {
          return {
            memory: rowToMemory(existing),
            supersededMemory: rowToMemory(current),
          };
        }
        throw new Error(`Memory has already been superseded: ${memoryId}`);
      }
      if (current.status !== "active" && current.status !== "suppressed") {
        throw new Error(
          `Only active or suppressed memories can be superseded: ${memoryId} is ${current.status}`,
        );
      }

      const replacementRows = await transaction
        .insert(memories)
        .values(memoryToRow(replacement))
        .onConflictDoNothing({
          target: [memories.workspaceId, memories.fingerprint],
          where: inArray(memories.status, FINGERPRINT_RESERVING_STATUSES),
        })
        .returning();
      let replacementRow = replacementRows[0];
      if (replacementRow === undefined) {
        const existingRows = await transaction
          .select()
          .from(memories)
          .where(
            and(
              eq(memories.workspaceId, workspaceId),
              eq(memories.fingerprint, replacement.fingerprint),
              inArray(memories.status, FINGERPRINT_RESERVING_STATUSES),
            ),
          )
          .limit(1);
        replacementRow = existingRows[0];
      }
      if (
        replacementRow === undefined ||
        replacementRow.supersedesMemoryId !== memoryId
      ) {
        throw new Error(
          "Replacement fingerprint belongs to an unrelated memory",
        );
      }

      const updatedRows = await transaction
        .update(memories)
        .set({
          status: "superseded",
          updatedAt: new Date(replacement.createdAt),
          suppressedAt: null,
        })
        .where(
          and(
            eq(memories.id, memoryId),
            eq(memories.workspaceId, workspaceId),
          ),
        )
        .returning();
      const supersededRow = updatedRows[0];
      if (supersededRow === undefined) {
        throw new Error(`Memory disappeared while superseding: ${memoryId}`);
      }

      return {
        memory: rowToMemory(replacementRow),
        supersededMemory: rowToMemory(supersededRow),
      };
    });
  }
}
