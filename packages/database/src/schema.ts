import type {
  AuthUserStatus,
  ConfirmationLevel,
  ConnectorEventType,
  MemoryCategory,
  MemoryStatus,
  WorkspaceStatus,
} from "@lore-co/core";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey(),
    slug: text("slug").notNull(),
    organization: text("organization").notNull(),
    name: text("name").notNull(),
    status: text("status").$type<WorkspaceStatus>().notNull().default("active"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("workspaces_slug_idx").on(table.slug),
    uniqueIndex("workspaces_organization_idx").on(table.organization),
    check(
      "workspaces_status_check",
      sql`${table.status} IN ('active', 'disabled')`,
    ),
  ],
);

export const workspaceTokens = pgTable(
  "workspace_tokens",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    revokedAt: timestamp("revoked_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastUsedAt: timestamp("last_used_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("workspace_tokens_hash_idx").on(table.tokenHash),
    index("workspace_tokens_workspace_idx").on(table.workspaceId),
    check(
      "workspace_tokens_hash_check",
      sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const authUsers = pgTable(
  "auth_users",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    status: text("status").$type<AuthUserStatus>().notNull().default("active"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("auth_users_email_idx").on(table.email),
    index("auth_users_workspace_idx").on(table.workspaceId),
    check(
      "auth_users_email_normalized_check",
      sql`${table.email} = lower(btrim(${table.email})) AND length(${table.email}) BETWEEN 3 AND 320`,
    ),
    check(
      "auth_users_status_check",
      sql`${table.status} IN ('active', 'disabled')`,
    ),
  ],
);

export const authMagicLinks = pgTable(
  "auth_magic_links",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    consumedAt: timestamp("consumed_at", {
      withTimezone: true,
      mode: "date",
    }),
    revokedAt: timestamp("revoked_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("auth_magic_links_hash_idx").on(table.tokenHash),
    uniqueIndex("auth_magic_links_user_active_idx")
      .on(table.userId)
      .where(
        sql`${table.consumedAt} IS NULL AND ${table.revokedAt} IS NULL`,
      ),
    index("auth_magic_links_user_idx").on(table.userId),
    index("auth_magic_links_expires_idx").on(table.expiresAt),
    check(
      "auth_magic_links_hash_check",
      sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "auth_magic_links_expires_check",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "auth_magic_links_terminal_state_check",
      sql`${table.consumedAt} IS NULL OR ${table.revokedAt} IS NULL`,
    ),
  ],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    revokedAt: timestamp("revoked_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastUsedAt: timestamp("last_used_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("auth_sessions_hash_idx").on(table.tokenHash),
    index("auth_sessions_user_idx").on(table.userId),
    index("auth_sessions_expires_idx").on(table.expiresAt),
    check(
      "auth_sessions_hash_check",
      sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "auth_sessions_expires_check",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);

export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    content: text("content").notNull(),
    organization: text("organization"),
    project: text("project"),
    repo: text("repo"),
    path: text("path"),
    component: text("component"),
    category: text("category").$type<MemoryCategory>().notNull(),
    status: text("status").$type<MemoryStatus>().notNull().default("active"),
    sourceAgent: text("source_agent").notNull(),
    sourceSessionId: text("source_session_id"),
    sourceMessageId: text("source_message_id"),
    sourceRawText: text("source_raw_text"),
    sourceEventId: uuid("source_event_id"),
    sourceRedacted: boolean("source_redacted").notNull().default(false),
    confidence: doublePrecision("confidence").notNull().default(1),
    confirmation: text("confirmation")
      .$type<ConfirmationLevel>()
      .notNull()
      .default("unconfirmed"),
    reconciliationKey: text("reconciliation_key"),
    embedding: vector("embedding", { dimensions: 1_536 }),
    embeddingModel: text("embedding_model"),
    embeddedAt: timestamp("embedded_at", {
      withTimezone: true,
      mode: "date",
    }),
    fingerprint: text("fingerprint").notNull(),
    supersedesMemoryId: uuid("supersedes_memory_id").references(
      (): AnyPgColumn => memories.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    check(
      "memories_category_check",
      sql`${table.category} IN ('architecture', 'convention', 'correction', 'gotcha', 'known_gotcha', 'deprecated', 'behavior', 'review_feedback', 'other')`,
    ),
    check(
      "memories_status_check",
      sql`${table.status} IN ('active', 'superseded', 'deleted')`,
    ),
    check(
      "memories_deleted_at_check",
      sql`(${table.status} = 'deleted' AND ${table.deletedAt} IS NOT NULL) OR (${table.status} <> 'deleted' AND ${table.deletedAt} IS NULL)`,
    ),
    check(
      "memories_not_self_superseding_check",
      sql`${table.supersedesMemoryId} IS NULL OR ${table.supersedesMemoryId} <> ${table.id}`,
    ),
    check(
      "memories_confidence_check",
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
    ),
    check(
      "memories_confirmation_check",
      sql`${table.confirmation} IN ('unconfirmed', 'implicit', 'explicit')`,
    ),
    uniqueIndex("memories_fingerprint_idx")
      .on(table.fingerprint)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex("memories_supersedes_unique_idx")
      .on(table.supersedesMemoryId)
      .where(sql`${table.supersedesMemoryId} IS NOT NULL`),
    index("memories_scope_status_idx").on(
      table.organization,
      table.project,
      table.repo,
      table.path,
      table.component,
      table.status,
    ),
    index("memories_status_idx").on(table.status),
    index("memories_workspace_status_idx").on(table.workspaceId, table.status),
    index("memories_reconciliation_key_idx").on(
      table.workspaceId,
      table.reconciliationKey,
    ),
    index("memories_supersedes_memory_id_idx").on(table.supersedesMemoryId),
    index("memories_content_search_idx").using(
      "gin",
      sql`to_tsvector('simple', ${table.content})`,
    ),
    index("memories_embedding_hnsw_idx")
      .using("hnsw", table.embedding.op("vector_cosine_ops"))
      .where(
        sql`${table.status} = 'active' AND ${table.embedding} IS NOT NULL`,
      ),
  ],
);

export const connectorEvents = pgTable(
  "connector_events",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    connector: text("connector").notNull(),
    externalEventId: text("external_event_id").notNull(),
    type: text("type").$type<ConnectorEventType>().notNull(),
    agent: text("agent").notNull(),
    sessionId: text("session_id").notNull(),
    conversationId: text("conversation_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    redacted: boolean("redacted").notNull().default(false),
    requestId: text("request_id").notNull(),
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    receivedAt: timestamp("received_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("connector_events_external_idx").on(
      table.workspaceId,
      table.connector,
      table.externalEventId,
    ),
    index("connector_events_session_idx").on(
      table.workspaceId,
      table.sessionId,
      table.receivedAt,
    ),
    check(
      "connector_events_type_check",
      sql`${table.type} IN ('observation', 'paired_turn', 'context_delivery')`,
    ),
  ],
);

export const memoryProvenance = pgTable(
  "memory_provenance",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    memoryId: uuid("memory_id").notNull(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => connectorEvents.id, { onDelete: "cascade" }),
    messageRole: text("message_role")
      .$type<"assistant" | "user">()
      .notNull(),
    sourceMessageId: text("source_message_id"),
    excerpt: text("excerpt").notNull(),
    redacted: boolean("redacted").notNull().default(false),
    confidence: doublePrecision("confidence").notNull(),
    confirmation: text("confirmation")
      .$type<ConfirmationLevel>()
      .notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("memory_provenance_event_memory_idx").on(
      table.eventId,
      table.memoryId,
    ),
    index("memory_provenance_memory_idx").on(table.memoryId, table.createdAt),
    check(
      "memory_provenance_role_check",
      sql`${table.messageRole} IN ('assistant', 'user')`,
    ),
    check(
      "memory_provenance_confidence_check",
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
    ),
    check(
      "memory_provenance_confirmation_check",
      sql`${table.confirmation} IN ('unconfirmed', 'implicit', 'explicit')`,
    ),
  ],
);

export const deliveryReceipts = pgTable(
  "delivery_receipts",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => connectorEvents.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    memoryIds: uuid("memory_ids").array().notNull().default([]),
    packing: jsonb("packing").$type<Record<string, unknown>>(),
    deliveredAt: timestamp("delivered_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("delivery_receipts_event_idx").on(table.eventId),
    index("delivery_receipts_workspace_idx").on(
      table.workspaceId,
      table.deliveredAt,
    ),
  ],
);

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status")
      .$type<"processing" | "completed">()
      .notNull()
      .default("processing"),
    response: jsonb("response").$type<Record<string, unknown>>(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idempotency_records_workspace_key_idx").on(
      table.workspaceId,
      table.key,
    ),
    index("idempotency_records_expires_idx").on(table.expiresAt),
    check(
      "idempotency_records_hash_check",
      sql`${table.requestHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "idempotency_records_status_check",
      sql`${table.status} IN ('processing', 'completed')`,
    ),
  ],
);

export const devinSessionCursors = pgTable(
  "devin_session_cursors",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    sessionId: text("session_id").notNull(),
    project: text("project"),
    repo: text("repo").notNull(),
    cursor: text("cursor"),
    pendingAssistantId: text("pending_assistant_id"),
    pendingAssistantContent: text("pending_assistant_content"),
    pendingAssistantAt: timestamp("pending_assistant_at", {
      withTimezone: true,
      mode: "date",
    }),
    status: text("status")
      .$type<"active" | "paused" | "error">()
      .notNull()
      .default("active"),
    lastError: text("last_error"),
    lastPolledAt: timestamp("last_polled_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("devin_session_cursors_workspace_session_idx").on(
      table.workspaceId,
      table.organizationId,
      table.sessionId,
    ),
    index("devin_session_cursors_poll_idx").on(
      table.status,
      table.lastPolledAt,
    ),
    check(
      "devin_session_cursors_status_check",
      sql`${table.status} IN ('active', 'paused', 'error')`,
    ),
    check(
      "devin_session_cursors_pending_check",
      sql`(${table.pendingAssistantContent} IS NULL AND ${table.pendingAssistantId} IS NULL AND ${table.pendingAssistantAt} IS NULL) OR (${table.pendingAssistantContent} IS NOT NULL)`,
    ),
  ],
);

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type NewWorkspaceRow = typeof workspaces.$inferInsert;
export type WorkspaceTokenRow = typeof workspaceTokens.$inferSelect;
export type NewWorkspaceTokenRow = typeof workspaceTokens.$inferInsert;
export type AuthUserRow = typeof authUsers.$inferSelect;
export type NewAuthUserRow = typeof authUsers.$inferInsert;
export type AuthMagicLinkRow = typeof authMagicLinks.$inferSelect;
export type NewAuthMagicLinkRow = typeof authMagicLinks.$inferInsert;
export type AuthSessionRow = typeof authSessions.$inferSelect;
export type NewAuthSessionRow = typeof authSessions.$inferInsert;
export type MemoryRow = typeof memories.$inferSelect;
export type NewMemoryRow = typeof memories.$inferInsert;
export type ConnectorEventRow = typeof connectorEvents.$inferSelect;
export type NewConnectorEventRow = typeof connectorEvents.$inferInsert;
export type MemoryProvenanceRow = typeof memoryProvenance.$inferSelect;
export type NewMemoryProvenanceRow = typeof memoryProvenance.$inferInsert;
export type DeliveryReceiptRow = typeof deliveryReceipts.$inferSelect;
export type NewDeliveryReceiptRow = typeof deliveryReceipts.$inferInsert;
export type IdempotencyRecordRow = typeof idempotencyRecords.$inferSelect;
export type NewIdempotencyRecordRow = typeof idempotencyRecords.$inferInsert;
export type DevinSessionCursorRow = typeof devinSessionCursors.$inferSelect;
export type NewDevinSessionCursorRow = typeof devinSessionCursors.$inferInsert;
