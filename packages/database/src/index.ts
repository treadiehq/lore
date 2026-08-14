import {
  createMemoryFingerprint,
  ListMemoriesDtoSchema,
  MemorySchema,
  MemoryUpdateSchema,
  type FindActiveCandidatesOptions,
  type InsertMemoryResult,
  type ListMemoriesDto,
  type ListMemoriesResponse,
  type Memory,
  type MemoryRepository,
  type MemoryScope,
  type MemoryUpdate,
  type SupersedeMemoryResult,
} from "@lore-co/core";
import {
  and,
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
import { memories, type MemoryRow, type NewMemoryRow } from "./schema.js";
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

function memoryToRow(memory: Memory): NewMemoryRow {
  return {
    id: memory.id,
    workspaceId: memory.workspaceId ?? memory.source.workspaceId ?? null,
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
    const inserted = await this.#db
      .insert(memories)
      .values(memoryToRow(memory))
      .onConflictDoNothing({
        target: memories.fingerprint,
        where: eq(memories.status, "active"),
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
          eq(memories.fingerprint, memory.fingerprint),
          eq(memories.status, "active"),
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

  async get(id: string): Promise<Memory | null> {
    const rows = await this.#db
      .select()
      .from(memories)
      .where(eq(memories.id, id))
      .limit(1);
    return rows[0] === undefined ? null : rowToMemory(rows[0]);
  }

  async list(input: ListMemoriesDto = {}): Promise<ListMemoriesResponse> {
    const filters = ListMemoriesDtoSchema.parse(input);
    const conditions: SQL[] = [];
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
  ): Promise<Memory | null> {
    const update = MemoryUpdateSchema.parse(updateInput);
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
      const current = await this.get(id);
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
    if (update.deletedAt !== undefined) {
      values.deletedAt =
        update.deletedAt === null ? null : new Date(update.deletedAt);
    }

    const rows = await this.#db
      .update(memories)
      .set(values)
      .where(eq(memories.id, id))
      .returning();
    return rows[0] === undefined ? null : rowToMemory(rows[0]);
  }

  async softDelete(
    id: string,
    deletedAt = new Date().toISOString(),
  ): Promise<Memory | null> {
    const current = await this.get(id);
    if (current === null || current.status === "deleted") {
      return current;
    }
    return this.update(id, {
      status: "deleted",
      deletedAt,
      updatedAt: deletedAt,
    });
  }

  async findActiveScopeCandidates(
    scope: MemoryScope,
    options: FindActiveCandidatesOptions = {},
  ): Promise<Memory[]> {
    const conditions = activeScopeConditions(scope, options);
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
  ): Promise<SupersedeMemoryResult> {
    const replacement = MemorySchema.parse(replacementInput);
    if (replacement.supersedesMemoryId !== memoryId) {
      throw new Error("Replacement must reference the memory it supersedes");
    }

    return this.#db.transaction(async (transaction) => {
      const currentRows = await transaction
        .select()
        .from(memories)
        .where(eq(memories.id, memoryId))
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
              eq(memories.fingerprint, replacement.fingerprint),
              eq(memories.status, "active"),
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
      if (current.status !== "active") {
        throw new Error(
          `Only active memories can be superseded: ${memoryId} is ${current.status}`,
        );
      }

      const replacementRows = await transaction
        .insert(memories)
        .values(memoryToRow(replacement))
        .onConflictDoNothing({
          target: memories.fingerprint,
          where: eq(memories.status, "active"),
        })
        .returning();
      let replacementRow = replacementRows[0];
      if (replacementRow === undefined) {
        const existingRows = await transaction
          .select()
          .from(memories)
          .where(
            and(
              eq(memories.fingerprint, replacement.fingerprint),
              eq(memories.status, "active"),
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
        })
        .where(eq(memories.id, memoryId))
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
