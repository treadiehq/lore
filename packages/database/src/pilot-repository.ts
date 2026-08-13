import { createHash, randomUUID } from "node:crypto";
import {
  ActivityListResponseSchema,
  ActivityQuerySchema,
  AuthenticatedWorkspaceSchema,
  ConnectorEventSchema,
  DeliveryReceiptSchema,
  LearningInspectionResponseSchema,
  MemorySchema,
  MemoryProvenanceSchema,
  ObservationResponseSchema,
  PairedTurnResponseSchema,
  WorkspaceTokenSchema,
  type AuthenticatedWorkspace,
  type ActivityListResponse,
  type ActivityQuery,
  type ConfirmationLevel,
  type ContextPacking,
  type ConnectorEvent,
  type ContextDeliveryRequest,
  type DeliveryReceipt,
  type LearningInspectionResponse,
  type Memory,
  type MemoryProvenance,
  type ObservationRequest,
  type ObservationResponse,
  type PairedTurnRequest,
  type PairedTurnResponse,
  type TurnObservation,
  type WorkspaceToken,
} from "@lore-co/core";
import {
  and,
  count,
  desc,
  eq,
  gte,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  or,
  type SQL,
} from "drizzle-orm";
import type { Database, DatabaseConnection } from "./index.js";
import {
  connectorEvents,
  deliveryReceipts,
  idempotencyRecords,
  memories,
  memoryProvenance,
  workspaces,
  workspaceTokens,
  type ConnectorEventRow,
  type DeliveryReceiptRow,
  type MemoryRow,
  type MemoryProvenanceRow,
  type WorkspaceTokenRow,
} from "./schema.js";

const TOKEN_MINIMUM_LENGTH = 24;

export function hashWorkspaceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createRequestHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function tokenPrefix(token: string): string {
  return token.slice(0, Math.min(8, token.length));
}

function rowToWorkspaceToken(
  row: WorkspaceTokenRow,
  now = new Date(),
): WorkspaceToken {
  const status =
    row.revokedAt !== null
      ? "revoked"
      : row.expiresAt !== null && row.expiresAt <= now
        ? "expired"
        : "active";
  return WorkspaceTokenSchema.parse({
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    status,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  });
}

function workspaceSlug(organization: string): string {
  const base =
    organization
      .normalize("NFKD")
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 72) || "workspace";
  return `${base}-${createHash("sha256").update(organization).digest("hex").slice(0, 8)}`;
}

function rowToConnectorEvent(row: ConnectorEventRow): ConnectorEvent {
  return ConnectorEventSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    connector: row.connector,
    externalEventId: row.externalEventId,
    type: row.type,
    agent: row.agent,
    sessionId: row.sessionId,
    conversationId: row.conversationId,
    payload: row.payload,
    redacted: row.redacted,
    requestId: row.requestId,
    occurredAt: row.occurredAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
  });
}

function rowToMemory(row: MemoryRow): Memory {
  return MemorySchema.parse({
    id: row.id,
    ...(row.workspaceId === null ? {} : { workspaceId: row.workspaceId }),
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
      ...(row.workspaceId === null ? {} : { workspaceId: row.workspaceId }),
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
    deletedAt: row.deletedAt?.toISOString() ?? null,
  });
}

function rowToProvenance(row: MemoryProvenanceRow): MemoryProvenance {
  return MemoryProvenanceSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    memoryId: row.memoryId,
    eventId: row.eventId,
    messageRole: row.messageRole,
    sourceMessageId: row.sourceMessageId,
    excerpt: row.excerpt,
    redacted: row.redacted,
    confidence: row.confidence,
    confirmation: row.confirmation,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  });
}

function rowToReceipt(row: DeliveryReceiptRow): DeliveryReceipt {
  return DeliveryReceiptSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    eventId: row.eventId,
    requestId: row.requestId,
    memoryIds: row.memoryIds,
    packing: row.packing,
    deliveredAt: row.deliveredAt.toISOString(),
  });
}

export type IdempotencyClaim =
  | { state: "claimed" }
  | { state: "replay"; response: PairedTurnResponse }
  | { state: "conflict" }
  | { state: "processing" };

export type ObservationIdempotencyClaim =
  | { state: "claimed" }
  | { state: "replay"; response: ObservationResponse }
  | { state: "conflict" }
  | { state: "processing" };

type RawIdempotencyClaim =
  | { state: "claimed" }
  | { state: "replay"; response: Record<string, unknown> }
  | { state: "conflict" }
  | { state: "processing" };

export interface RecordConnectorEventInput {
  workspaceId: string;
  requestId: string;
  turn: PairedTurnRequest;
  payload: Record<string, unknown>;
  redacted: boolean;
}

export interface RecordObservationEventInput {
  workspaceId: string;
  requestId: string;
  observation: ObservationRequest;
  payload: Record<string, unknown>;
  redacted: boolean;
}

export interface RecordProvenanceInput {
  workspaceId: string;
  eventId: string;
  memory: Memory;
  messageRole: "assistant" | "user";
  sourceMessageId?: string;
  excerpt: string;
  redacted: boolean;
  confidence?: number;
  confirmation?: ConfirmationLevel;
  metadata?: Record<string, unknown>;
}

export interface RecordContextDeliveryEventInput {
  workspaceId: string;
  requestId: string;
  delivery: ContextDeliveryRequest;
  payload: Record<string, unknown>;
  redacted: boolean;
}

export class PostgresPilotRepository {
  readonly #db: Database;

  constructor(database: Database | DatabaseConnection) {
    this.#db = "db" in database ? database.db : database;
  }

  async listWorkspaceTokens(workspaceId: string): Promise<WorkspaceToken[]> {
    const rows = await this.#db
      .select()
      .from(workspaceTokens)
      .where(eq(workspaceTokens.workspaceId, workspaceId))
      .orderBy(desc(workspaceTokens.createdAt), workspaceTokens.id);
    const now = new Date();
    return rows.map((row) => rowToWorkspaceToken(row, now));
  }

  async createWorkspaceToken(input: {
    workspaceId: string;
    name: string;
    token: string;
    expiresAt?: Date;
  }): Promise<WorkspaceToken> {
    const name = input.name.trim();
    const token = input.token.trim();
    if (name === "") {
      throw new Error("Workspace token name cannot be empty");
    }
    if (token.length < TOKEN_MINIMUM_LENGTH) {
      throw new Error(
        `Workspace token must contain at least ${TOKEN_MINIMUM_LENGTH} characters`,
      );
    }
    if (
      input.expiresAt !== undefined &&
      input.expiresAt.getTime() <= Date.now()
    ) {
      throw new Error("Workspace token expiry must be in the future");
    }

    const rows = await this.#db
      .insert(workspaceTokens)
      .values({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        name,
        tokenHash: hashWorkspaceToken(token),
        tokenPrefix: tokenPrefix(token),
        ...(input.expiresAt === undefined
          ? {}
          : { expiresAt: input.expiresAt }),
      })
      .returning();
    const created = rows[0];
    if (created === undefined) {
      throw new Error("Failed to create workspace token");
    }
    return rowToWorkspaceToken(created);
  }

  async revokeWorkspaceToken(
    workspaceId: string,
    tokenId: string,
  ): Promise<WorkspaceToken | null> {
    const now = new Date();
    const rows = await this.#db
      .update(workspaceTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(workspaceTokens.id, tokenId),
          eq(workspaceTokens.workspaceId, workspaceId),
          isNull(workspaceTokens.revokedAt),
        ),
      )
      .returning();
    const revoked = rows[0];
    return revoked === undefined ? null : rowToWorkspaceToken(revoked, now);
  }

  async ensureWorkspaceToken(input: {
    organization: string;
    token: string;
    workspaceName?: string;
    tokenName?: string;
  }): Promise<AuthenticatedWorkspace> {
    const organization = input.organization.trim();
    const token = input.token.trim();
    if (organization.length === 0) {
      throw new Error("Workspace organization cannot be empty");
    }
    if (token.length < TOKEN_MINIMUM_LENGTH) {
      throw new Error(
        `LORE_WORKSPACE_TOKEN must contain at least ${TOKEN_MINIMUM_LENGTH} characters`,
      );
    }

    return this.#db.transaction(async (transaction) => {
      const existingWorkspaces = await transaction
        .select()
        .from(workspaces)
        .where(eq(workspaces.organization, organization))
        .limit(1);
      let workspace = existingWorkspaces[0];
      if (workspace === undefined) {
        const inserted = await transaction
          .insert(workspaces)
          .values({
            id: randomUUID(),
            slug: workspaceSlug(organization),
            organization,
            name: input.workspaceName?.trim() || organization,
            status: "active",
          })
          .onConflictDoNothing({ target: workspaces.organization })
          .returning();
        workspace = inserted[0];
        if (workspace === undefined) {
          const raced = await transaction
            .select()
            .from(workspaces)
            .where(eq(workspaces.organization, organization))
            .limit(1);
          workspace = raced[0];
        }
      }
      if (workspace === undefined) {
        throw new Error(`Failed to provision workspace for ${organization}`);
      }

      const hash = hashWorkspaceToken(token);
      const insertedTokens = await transaction
        .insert(workspaceTokens)
        .values({
          id: randomUUID(),
          workspaceId: workspace.id,
          name: input.tokenName?.trim() || "bootstrap",
          tokenHash: hash,
          tokenPrefix: tokenPrefix(token),
        })
        .onConflictDoNothing({ target: workspaceTokens.tokenHash })
        .returning();
      let workspaceToken = insertedTokens[0];
      if (workspaceToken === undefined) {
        const existingTokens = await transaction
          .select()
          .from(workspaceTokens)
          .where(eq(workspaceTokens.tokenHash, hash))
          .limit(1);
        workspaceToken = existingTokens[0];
      }
      if (
        workspaceToken === undefined ||
        workspaceToken.workspaceId !== workspace.id
      ) {
        throw new Error("Workspace token is already assigned to another tenant");
      }

      return AuthenticatedWorkspaceSchema.parse({
        workspaceId: workspace.id,
        organization: workspace.organization,
        tokenId: workspaceToken.id,
      });
    });
  }

  async authenticateToken(token: string): Promise<AuthenticatedWorkspace | null> {
    if (
      token.length < TOKEN_MINIMUM_LENGTH ||
      token.length > 4_096 ||
      /\s/u.test(token)
    ) {
      return null;
    }
    const now = new Date();
    const rows = await this.#db
      .select({
        workspaceId: workspaces.id,
        organization: workspaces.organization,
        tokenId: workspaceTokens.id,
      })
      .from(workspaceTokens)
      .innerJoin(workspaces, eq(workspaceTokens.workspaceId, workspaces.id))
      .where(
        and(
          eq(workspaceTokens.tokenHash, hashWorkspaceToken(token)),
          eq(workspaces.status, "active"),
          isNull(workspaceTokens.revokedAt),
          or(
            isNull(workspaceTokens.expiresAt),
            gt(workspaceTokens.expiresAt, now),
          ),
        ),
      )
      .limit(1);
    const authenticated = rows[0];
    if (authenticated === undefined) {
      return null;
    }
    await this.#db
      .update(workspaceTokens)
      .set({ lastUsedAt: now })
      .where(eq(workspaceTokens.id, authenticated.tokenId));
    return AuthenticatedWorkspaceSchema.parse(authenticated);
  }

  async beginIdempotency(input: {
    workspaceId: string;
    key: string;
    requestHash: string;
    ttlMs?: number;
  }): Promise<IdempotencyClaim> {
    const claim = await this.#beginIdempotencyRecord(input);
    if (claim.state !== "replay") {
      return claim;
    }
    return {
      state: "replay",
      response: PairedTurnResponseSchema.parse(claim.response),
    };
  }

  async beginObservationIdempotency(input: {
    workspaceId: string;
    key: string;
    requestHash: string;
    ttlMs?: number;
  }): Promise<ObservationIdempotencyClaim> {
    const claim = await this.#beginIdempotencyRecord(input);
    if (claim.state !== "replay") {
      return claim;
    }
    return {
      state: "replay",
      response: ObservationResponseSchema.parse(claim.response),
    };
  }

  async #beginIdempotencyRecord(input: {
    workspaceId: string;
    key: string;
    requestHash: string;
    ttlMs?: number;
  }): Promise<RawIdempotencyClaim> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (input.ttlMs ?? 86_400_000));
    const inserted = await this.#db
      .insert(idempotencyRecords)
      .values({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        key: input.key,
        requestHash: input.requestHash,
        status: "processing",
        expiresAt,
      })
      .onConflictDoNothing({
        target: [idempotencyRecords.workspaceId, idempotencyRecords.key],
      })
      .returning();
    if (inserted[0] !== undefined) {
      return { state: "claimed" };
    }

    const existingRows = await this.#db
      .select()
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.workspaceId, input.workspaceId),
          eq(idempotencyRecords.key, input.key),
        ),
      )
      .limit(1);
    const existing = existingRows[0];
    if (existing === undefined) {
      return this.#beginIdempotencyRecord(input);
    }
    if (existing.expiresAt <= now) {
      const reclaimed = await this.#db
        .update(idempotencyRecords)
        .set({
          id: randomUUID(),
          requestHash: input.requestHash,
          status: "processing",
          response: null,
          expiresAt,
          updatedAt: now,
        })
        .where(
          and(
            eq(idempotencyRecords.id, existing.id),
            lt(idempotencyRecords.expiresAt, now),
          ),
        )
        .returning();
      return reclaimed[0] === undefined
        ? this.#beginIdempotencyRecord(input)
        : { state: "claimed" };
    }
    if (existing.requestHash !== input.requestHash) {
      return { state: "conflict" };
    }
    if (existing.status === "completed" && existing.response !== null) {
      return {
        state: "replay",
        response: existing.response,
      };
    }
    return { state: "processing" };
  }

  async completeIdempotency(input: {
    workspaceId: string;
    key: string;
    requestHash: string;
    response: PairedTurnResponse;
  }): Promise<void> {
    const rows = await this.#db
      .update(idempotencyRecords)
      .set({
        status: "completed",
        response: input.response as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(idempotencyRecords.workspaceId, input.workspaceId),
          eq(idempotencyRecords.key, input.key),
          eq(idempotencyRecords.requestHash, input.requestHash),
          eq(idempotencyRecords.status, "processing"),
        ),
      )
      .returning({ id: idempotencyRecords.id });
    if (rows[0] === undefined) {
      throw new Error("Idempotency claim was lost before completion");
    }
  }

  async completeObservationIdempotency(input: {
    workspaceId: string;
    key: string;
    requestHash: string;
    response: ObservationResponse;
  }): Promise<void> {
    const rows = await this.#db
      .update(idempotencyRecords)
      .set({
        status: "completed",
        response: input.response as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(idempotencyRecords.workspaceId, input.workspaceId),
          eq(idempotencyRecords.key, input.key),
          eq(idempotencyRecords.requestHash, input.requestHash),
          eq(idempotencyRecords.status, "processing"),
        ),
      )
      .returning({ id: idempotencyRecords.id });
    if (rows[0] === undefined) {
      throw new Error("Observation idempotency claim was lost before completion");
    }
  }

  async abandonIdempotency(input: {
    workspaceId: string;
    key: string;
    requestHash: string;
  }): Promise<void> {
    await this.#db
      .delete(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.workspaceId, input.workspaceId),
          eq(idempotencyRecords.key, input.key),
          eq(idempotencyRecords.requestHash, input.requestHash),
          eq(idempotencyRecords.status, "processing"),
        ),
      );
  }

  async recordConnectorEvent(
    input: RecordConnectorEventInput,
  ): Promise<ConnectorEvent> {
    const occurredAt = new Date(input.turn.occurredAt ?? Date.now());
    const inserted = await this.#db
      .insert(connectorEvents)
      .values({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        connector: input.turn.connector,
        externalEventId: input.turn.eventId,
        type: "paired_turn",
        agent: input.turn.agent,
        sessionId: input.turn.sessionId,
        conversationId: input.turn.conversationId ?? null,
        payload: input.payload,
        redacted: input.redacted,
        requestId: input.requestId,
        occurredAt,
      })
      .onConflictDoNothing({
        target: [
          connectorEvents.workspaceId,
          connectorEvents.connector,
          connectorEvents.externalEventId,
        ],
      })
      .returning();
    let row = inserted[0];
    if (row === undefined) {
      const existing = await this.#db
        .select()
        .from(connectorEvents)
        .where(
          and(
            eq(connectorEvents.workspaceId, input.workspaceId),
            eq(connectorEvents.connector, input.turn.connector),
            eq(connectorEvents.externalEventId, input.turn.eventId),
          ),
        )
        .limit(1);
      row = existing[0];
    }
    if (row === undefined) {
      throw new Error("Connector event conflicted but could not be loaded");
    }
    return rowToConnectorEvent(row);
  }

  async recordObservationEvent(
    input: RecordObservationEventInput,
  ): Promise<{ event: ConnectorEvent; inserted: boolean }> {
    const inserted = await this.#db
      .insert(connectorEvents)
      .values({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        connector: input.observation.connector,
        externalEventId: input.observation.eventId,
        type: "observation",
        agent: input.observation.agent,
        sessionId: input.observation.sessionId,
        conversationId: input.observation.conversationId ?? null,
        payload: input.payload,
        redacted: input.redacted,
        requestId: input.requestId,
        occurredAt: new Date(input.observation.occurredAt),
      })
      .onConflictDoNothing({
        target: [
          connectorEvents.workspaceId,
          connectorEvents.connector,
          connectorEvents.externalEventId,
        ],
      })
      .returning();
    const created = inserted[0];
    if (created !== undefined) {
      return { event: rowToConnectorEvent(created), inserted: true };
    }
    const existing = await this.#db
      .select()
      .from(connectorEvents)
      .where(
        and(
          eq(connectorEvents.workspaceId, input.workspaceId),
          eq(connectorEvents.connector, input.observation.connector),
          eq(connectorEvents.externalEventId, input.observation.eventId),
        ),
      )
      .limit(1);
    const row = existing[0];
    if (row === undefined) {
      throw new Error("Observation event conflicted but could not be loaded");
    }
    return { event: rowToConnectorEvent(row), inserted: false };
  }

  async completeObservationEvent(input: {
    workspaceId: string;
    eventId: string;
    response: TurnObservation;
  }): Promise<ConnectorEvent> {
    const existingRows = await this.#db
      .select()
      .from(connectorEvents)
      .where(
        and(
          eq(connectorEvents.id, input.eventId),
          eq(connectorEvents.workspaceId, input.workspaceId),
          eq(connectorEvents.type, "observation"),
        ),
      )
      .limit(1);
    const existing = existingRows[0];
    if (existing === undefined) {
      throw new Error("Observation event disappeared before completion");
    }
    const rows = await this.#db
      .update(connectorEvents)
      .set({
        payload: {
          ...existing.payload,
          response: input.response,
        },
      })
      .where(
        and(
          eq(connectorEvents.id, input.eventId),
          eq(connectorEvents.workspaceId, input.workspaceId),
          eq(connectorEvents.type, "observation"),
        ),
      )
      .returning();
    const completed = rows[0];
    if (completed === undefined) {
      throw new Error("Observation event disappeared before completion");
    }
    return rowToConnectorEvent(completed);
  }

  async recordContextDeliveryEvent(
    input: RecordContextDeliveryEventInput,
  ): Promise<{ event: ConnectorEvent; inserted: boolean }> {
    const inserted = await this.#db
      .insert(connectorEvents)
      .values({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        connector: input.delivery.connector,
        externalEventId: input.delivery.eventId,
        type: "context_delivery",
        agent: input.delivery.task.agent,
        sessionId: input.delivery.sessionId,
        conversationId: null,
        payload: input.payload,
        redacted: input.redacted,
        requestId: input.requestId,
        occurredAt: new Date(),
      })
      .onConflictDoNothing({
        target: [
          connectorEvents.workspaceId,
          connectorEvents.connector,
          connectorEvents.externalEventId,
        ],
      })
      .returning();
    const created = inserted[0];
    if (created !== undefined) {
      return { event: rowToConnectorEvent(created), inserted: true };
    }
    const existing = await this.#db
      .select()
      .from(connectorEvents)
      .where(
        and(
          eq(connectorEvents.workspaceId, input.workspaceId),
          eq(connectorEvents.connector, input.delivery.connector),
          eq(connectorEvents.externalEventId, input.delivery.eventId),
        ),
      )
      .limit(1);
    const row = existing[0];
    if (row === undefined) {
      throw new Error("Context delivery conflicted but could not be loaded");
    }
    return { event: rowToConnectorEvent(row), inserted: false };
  }

  async recordProvenance(
    input: RecordProvenanceInput,
  ): Promise<MemoryProvenance> {
    const inserted = await this.#db
      .insert(memoryProvenance)
      .values({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        memoryId: input.memory.id,
        eventId: input.eventId,
        messageRole: input.messageRole,
        sourceMessageId: input.sourceMessageId ?? null,
        excerpt: input.excerpt.slice(0, 10_000),
        redacted: input.redacted,
        confidence: input.confidence ?? input.memory.confidence ?? 1,
        confirmation:
          input.confirmation ?? input.memory.confirmation ?? "unconfirmed",
        metadata: input.metadata ?? {},
      })
      .onConflictDoNothing({
        target: [memoryProvenance.eventId, memoryProvenance.memoryId],
      })
      .returning();
    let row = inserted[0];
    if (row === undefined) {
      const existing = await this.#db
        .select()
        .from(memoryProvenance)
        .where(
          and(
            eq(memoryProvenance.eventId, input.eventId),
            eq(memoryProvenance.memoryId, input.memory.id),
          ),
        )
        .limit(1);
      row = existing[0];
    }
    if (row === undefined) {
      throw new Error("Memory provenance conflicted but could not be loaded");
    }
    return rowToProvenance(row);
  }

  async recordDeliveryReceipt(input: {
    workspaceId: string;
    eventId: string;
    requestId: string;
    memoryIds: string[];
    packing?: ContextPacking;
  }): Promise<DeliveryReceipt> {
    const inserted = await this.#db
      .insert(deliveryReceipts)
      .values({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        eventId: input.eventId,
        requestId: input.requestId,
        memoryIds: input.memoryIds,
        packing:
          input.packing === undefined
            ? null
            : (input.packing as unknown as Record<string, unknown>),
      })
      .onConflictDoNothing({ target: deliveryReceipts.eventId })
      .returning();
    let row = inserted[0];
    if (row === undefined) {
      const existing = await this.#db
        .select()
        .from(deliveryReceipts)
        .where(eq(deliveryReceipts.eventId, input.eventId))
        .limit(1);
      row = existing[0];
    }
    if (row === undefined) {
      throw new Error("Delivery receipt conflicted but could not be loaded");
    }
    return rowToReceipt(row);
  }

  async inspectLearning(input: {
    workspaceId: string;
    learningId: string;
  }): Promise<LearningInspectionResponse | null> {
    const learningRows = await this.#db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.id, input.learningId),
          eq(memories.workspaceId, input.workspaceId),
        ),
      )
      .limit(1);
    const learningRow = learningRows[0];
    if (learningRow === undefined) {
      return null;
    }

    const [provenanceRows, predecessorRows, successorRows, sourceEventRows] =
      await Promise.all([
        this.#db
          .select()
          .from(memoryProvenance)
          .where(
            and(
              eq(memoryProvenance.workspaceId, input.workspaceId),
              eq(memoryProvenance.memoryId, input.learningId),
            ),
          )
          .orderBy(memoryProvenance.createdAt, memoryProvenance.id),
        learningRow.supersedesMemoryId === null
          ? Promise.resolve([])
          : this.#db
              .select()
              .from(memories)
              .where(
                and(
                  eq(memories.id, learningRow.supersedesMemoryId),
                  eq(memories.workspaceId, input.workspaceId),
                ),
              )
              .limit(1),
        this.#db
          .select()
          .from(memories)
          .where(
            and(
              eq(memories.supersedesMemoryId, input.learningId),
              eq(memories.workspaceId, input.workspaceId),
            ),
          )
          .limit(1),
        learningRow.sourceEventId === null
          ? Promise.resolve([])
          : this.#db
              .select()
              .from(connectorEvents)
              .where(
                and(
                  eq(connectorEvents.id, learningRow.sourceEventId),
                  eq(connectorEvents.workspaceId, input.workspaceId),
                ),
              )
              .limit(1),
      ]);

    const eventIds = [...new Set(provenanceRows.map((row) => row.eventId))];
    const provenanceEventRows =
      eventIds.length === 0
        ? []
        : await this.#db
            .select()
            .from(connectorEvents)
            .where(
              and(
                eq(connectorEvents.workspaceId, input.workspaceId),
                inArray(connectorEvents.id, eventIds),
              ),
            );
    const eventById = new Map(
      provenanceEventRows.map((row) => [row.id, rowToConnectorEvent(row)]),
    );

    return LearningInspectionResponseSchema.parse({
      learning: rowToMemory(learningRow),
      sourceEvent:
        sourceEventRows[0] === undefined
          ? null
          : rowToConnectorEvent(sourceEventRows[0]),
      provenance: provenanceRows.flatMap((row) => {
        const event = eventById.get(row.eventId);
        return event === undefined
          ? []
          : [{ record: rowToProvenance(row), event }];
      }),
      predecessor:
        predecessorRows[0] === undefined
          ? null
          : rowToMemory(predecessorRows[0]),
      successor:
        successorRows[0] === undefined ? null : rowToMemory(successorRows[0]),
    });
  }

  async listActivity(
    input: { workspaceId: string } & ActivityQuery,
  ): Promise<ActivityListResponse> {
    const { workspaceId, ...query } = input;
    const filters = ActivityQuerySchema.parse(query);
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;
    const conditions: SQL[] = [
      eq(connectorEvents.workspaceId, workspaceId),
    ];
    if (filters.type !== undefined) {
      conditions.push(eq(connectorEvents.type, filters.type));
    }
    if (filters.agent !== undefined) {
      conditions.push(eq(connectorEvents.agent, filters.agent));
    }
    if (filters.connector !== undefined) {
      conditions.push(eq(connectorEvents.connector, filters.connector));
    }
    if (filters.from !== undefined) {
      conditions.push(
        gte(connectorEvents.occurredAt, new Date(filters.from)),
      );
    }
    if (filters.to !== undefined) {
      conditions.push(lte(connectorEvents.occurredAt, new Date(filters.to)));
    }
    const where = and(...conditions);
    const [eventRows, totalRows] = await Promise.all([
      this.#db
        .select()
        .from(connectorEvents)
        .where(where)
        .orderBy(desc(connectorEvents.receivedAt), connectorEvents.id)
        .limit(limit)
        .offset(offset),
      this.#db
        .select({ count: count() })
        .from(connectorEvents)
        .where(where),
    ]);
    const total = totalRows[0]?.count ?? 0;
    if (eventRows.length === 0) {
      return ActivityListResponseSchema.parse({
        activities: [],
        total,
        limit,
        offset,
        hasMore: offset + eventRows.length < total,
      });
    }
    const eventIds = eventRows.map((event) => event.id);
    const [provenanceRows, receiptRows] = await Promise.all([
      this.#db
        .select()
        .from(memoryProvenance)
        .where(
          and(
            eq(memoryProvenance.workspaceId, workspaceId),
            inArray(memoryProvenance.eventId, eventIds),
          ),
        ),
      this.#db
        .select()
        .from(deliveryReceipts)
        .where(
          and(
            eq(deliveryReceipts.workspaceId, workspaceId),
            inArray(deliveryReceipts.eventId, eventIds),
          ),
        ),
    ]);
    const memoryIds = [
      ...new Set([
        ...provenanceRows.map((row) => row.memoryId),
        ...receiptRows.flatMap((row) => row.memoryIds),
      ]),
    ];
    const memoryRows =
      memoryIds.length === 0
        ? []
        : await this.#db
            .select({
              id: memories.id,
              content: memories.content,
              category: memories.category,
              status: memories.status,
            })
            .from(memories)
            .where(inArray(memories.id, memoryIds));
    const memoryById = new Map(memoryRows.map((memory) => [memory.id, memory]));
    const provenanceByEvent = new Map<string, string[]>();
    for (const row of provenanceRows) {
      provenanceByEvent.set(row.eventId, [
        ...(provenanceByEvent.get(row.eventId) ?? []),
        row.memoryId,
      ]);
    }
    const receiptByEvent = new Map(
      receiptRows.map((receipt) => [receipt.eventId, receipt]),
    );
    return ActivityListResponseSchema.parse({
      activities: eventRows.map((row) => {
        const event = rowToConnectorEvent(row);
        const directCurrentUser = event.payload.currentUser;
        const storedRequest = event.payload.request;
        const requestMessages =
          typeof storedRequest === "object" &&
          storedRequest !== null &&
          "messages" in storedRequest &&
          Array.isArray(storedRequest.messages)
            ? storedRequest.messages
            : [];
        const observedUser = [...requestMessages].reverse().find(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "role" in message &&
            message.role === "user" &&
            "content" in message &&
            typeof message.content === "string",
        );
        const correction =
          typeof directCurrentUser === "object" &&
          directCurrentUser !== null &&
          "content" in directCurrentUser &&
          typeof directCurrentUser.content === "string"
            ? directCurrentUser.content
            : typeof observedUser === "object" &&
                observedUser !== null &&
                "content" in observedUser &&
                typeof observedUser.content === "string"
              ? observedUser.content
              : "";
        const receipt = receiptByEvent.get(event.id);
        return {
          event,
          correction,
          learnedMemories: (provenanceByEvent.get(event.id) ?? [])
            .map((id) => memoryById.get(id))
            .filter((memory) => memory !== undefined),
          deliveredMemories: (receipt?.memoryIds ?? [])
            .map((id) => memoryById.get(id))
            .filter((memory) => memory !== undefined),
          receipt: receipt === undefined ? null : rowToReceipt(receipt),
        };
      }),
      total,
      limit,
      offset,
      hasMore: offset + eventRows.length < total,
    });
  }
}
