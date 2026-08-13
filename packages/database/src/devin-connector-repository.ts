import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { Database, DatabaseConnection } from "./index.js";
import {
  devinSessionCursors,
  workspaces,
  type DevinSessionCursorRow,
} from "./schema.js";

export interface DevinSessionCursor {
  id: string;
  workspaceId: string;
  workspaceOrganization: string;
  organizationId: string;
  sessionId: string;
  project: string | null;
  repo: string;
  cursor: string | null;
  pendingAssistantId: string | null;
  pendingAssistantContent: string | null;
  pendingAssistantAt: Date | null;
  status: "active" | "paused" | "error";
  lastError: string | null;
  lastPolledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RegisterDevinSessionInput {
  workspaceId: string;
  organizationId: string;
  sessionId: string;
  project?: string;
  repo: string;
}

export interface DevinSessionCheckpoint {
  cursor: string | null;
  pendingAssistantId: string | null;
  pendingAssistantContent: string | null;
  pendingAssistantAt: Date | null;
}

function rowWithOrganization(
  row: DevinSessionCursorRow,
  workspaceOrganization: string,
): DevinSessionCursor {
  return { ...row, workspaceOrganization };
}

export class PostgresDevinConnectorRepository {
  readonly #db: Database;

  constructor(database: Database | DatabaseConnection) {
    this.#db = "db" in database ? database.db : database;
  }

  async register(
    input: RegisterDevinSessionInput,
  ): Promise<DevinSessionCursor> {
    const now = new Date();
    const inserted = await this.#db
      .insert(devinSessionCursors)
      .values({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        organizationId: input.organizationId,
        sessionId: input.sessionId,
        project: input.project ?? null,
        repo: input.repo,
        status: "active",
        lastError: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          devinSessionCursors.workspaceId,
          devinSessionCursors.organizationId,
          devinSessionCursors.sessionId,
        ],
        set: {
          project: input.project ?? null,
          repo: input.repo,
          status: "active",
          lastError: null,
          updatedAt: now,
        },
      })
      .returning();
    const row = inserted[0];
    if (row === undefined) {
      throw new Error("Devin session registration did not return a row");
    }
    const workspaceRows = await this.#db
      .select({ organization: workspaces.organization })
      .from(workspaces)
      .where(eq(workspaces.id, row.workspaceId))
      .limit(1);
    const organization = workspaceRows[0]?.organization;
    if (organization === undefined) {
      throw new Error("Devin session workspace does not exist");
    }
    return rowWithOrganization(row, organization);
  }

  async listActive(limit = 25): Promise<DevinSessionCursor[]> {
    const rows = await this.#db
      .select({
        cursor: devinSessionCursors,
        workspaceOrganization: workspaces.organization,
      })
      .from(devinSessionCursors)
      .innerJoin(workspaces, eq(workspaces.id, devinSessionCursors.workspaceId))
      .where(eq(devinSessionCursors.status, "active"))
      .orderBy(
        asc(devinSessionCursors.lastPolledAt),
        asc(devinSessionCursors.createdAt),
      )
      .limit(Math.min(Math.max(limit, 1), 100));
    return rows.map((row) =>
      rowWithOrganization(row.cursor, row.workspaceOrganization),
    );
  }

  async checkpoint(
    id: string,
    checkpoint: DevinSessionCheckpoint,
  ): Promise<void> {
    await this.#db
      .update(devinSessionCursors)
      .set({
        cursor: checkpoint.cursor,
        pendingAssistantId: checkpoint.pendingAssistantId,
        pendingAssistantContent: checkpoint.pendingAssistantContent,
        pendingAssistantAt: checkpoint.pendingAssistantAt,
        status: "active",
        lastError: null,
        lastPolledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(devinSessionCursors.id, id));
  }

  async recordError(id: string, error: string): Promise<void> {
    await this.#db
      .update(devinSessionCursors)
      .set({
        lastError: error.slice(0, 2_000),
        lastPolledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(devinSessionCursors.id, id),
          eq(devinSessionCursors.status, "active"),
        ),
      );
  }

  async setStatus(
    input: {
      workspaceId: string;
      organizationId: string;
      sessionId: string;
    },
    status: "active" | "paused",
  ): Promise<boolean> {
    const rows = await this.#db
      .update(devinSessionCursors)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(devinSessionCursors.workspaceId, input.workspaceId),
          eq(devinSessionCursors.organizationId, input.organizationId),
          eq(devinSessionCursors.sessionId, input.sessionId),
        ),
      )
      .returning({ id: devinSessionCursors.id });
    return rows.length > 0;
  }
}
