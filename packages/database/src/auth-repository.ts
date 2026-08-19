import { createHash, randomUUID } from "node:crypto";
import {
  AuthenticatedWorkspaceSchema,
  AuthSessionProfileSchema,
  normalizeAuthEmail,
  type AuthenticatedWorkspace,
  type AuthSessionProfile,
  type AuthUserRole,
  type AuthUserStatus,
  type WorkspaceStatus,
} from "@lore-co/core";
import { and, eq, gt, isNull, ne } from "drizzle-orm";
import type { Database, DatabaseConnection } from "./index.js";
import {
  authMagicLinks,
  authOwnerBootstraps,
  authPasswordResets,
  authSessions,
  authUsers,
  workspaces,
} from "./schema.js";

const AUTH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

const identitySelection = {
  userId: authUsers.id,
  email: authUsers.email,
  userStatus: authUsers.status,
  role: authUsers.role,
  passwordHash: authUsers.passwordHash,
  workspaceId: workspaces.id,
  workspaceName: workspaces.name,
  organization: workspaces.organization,
  workspaceStatus: workspaces.status,
};

interface SelectedIdentity {
  userId: string;
  email: string;
  userStatus: AuthUserStatus;
  role: AuthUserRole;
  passwordHash: string | null;
  workspaceId: string;
  workspaceName: string;
  organization: string;
  workspaceStatus: WorkspaceStatus;
}

export interface AuthUserRecord extends Omit<AuthSessionProfile, "expiresAt"> {
  userStatus: AuthUserStatus;
  workspaceStatus: WorkspaceStatus;
  passwordHash: string | null;
}

export interface AuthUserProvisionResult {
  user: AuthUserRecord;
  created: boolean;
}

export interface IssueMagicLinkInput {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface VerifyMagicLinkInput {
  tokenHash: string;
  sessionId: string;
  sessionTokenHash: string;
  sessionExpiresAt: Date;
}

export interface CreateAuthSessionInput {
  userId: string;
  sessionId: string;
  sessionTokenHash: string;
  sessionExpiresAt: Date;
}

export interface ClaimFirstOwnerInput {
  organization: string;
  email: string;
  passwordHash: string;
  sessionId: string;
  sessionTokenHash: string;
  sessionExpiresAt: Date;
}

export interface IssuePasswordResetInput {
  id: string;
  email: string;
  organization: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface ConsumePasswordResetInput {
  tokenHash: string;
  passwordHash: string;
  sessionId: string;
  sessionTokenHash: string;
  sessionExpiresAt: Date;
}

class InactiveAuthIdentityError extends Error {}

export function hashAuthToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function workspaceIdentifier(name: string, workspaceId: string): string {
  const base =
    name
      .normalize("NFKD")
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 55) || "workspace";
  return `${base}-${workspaceId}`;
}

function recordFromIdentity(identity: SelectedIdentity): AuthUserRecord {
  return {
    userId: identity.userId,
    email: normalizeAuthEmail(identity.email),
    workspaceId: identity.workspaceId,
    workspaceName: identity.workspaceName,
    organization: identity.organization,
    role: identity.role,
    userStatus: identity.userStatus,
    workspaceStatus: identity.workspaceStatus,
    passwordHash: identity.passwordHash,
  };
}

function profileFromIdentity(
  identity: SelectedIdentity,
  expiresAt: Date,
): AuthSessionProfile {
  return AuthSessionProfileSchema.parse({
    userId: identity.userId,
    email: identity.email,
    workspaceId: identity.workspaceId,
    workspaceName: identity.workspaceName,
    organization: identity.organization,
    role: identity.role,
    expiresAt: expiresAt.toISOString(),
  });
}

export class PostgresAuthRepository {
  readonly #db: Database;

  constructor(database: Database | DatabaseConnection) {
    this.#db = "db" in database ? database.db : database;
  }

  async findUserByEmail(emailInput: string): Promise<AuthUserRecord | null> {
    const email = normalizeAuthEmail(emailInput);
    const rows = await this.#db
      .select(identitySelection)
      .from(authUsers)
      .innerJoin(workspaces, eq(authUsers.workspaceId, workspaces.id))
      .where(eq(authUsers.email, email))
      .limit(1);
    const identity = rows[0];
    return identity === undefined ? null : recordFromIdentity(identity);
  }

  async isOwnerBootstrapRequired(organization: string): Promise<boolean> {
    const workspaceRows = await this.#db
      .select({ id: workspaces.id, status: workspaces.status })
      .from(workspaces)
      .where(eq(workspaces.organization, organization.trim()))
      .limit(1);
    const workspace = workspaceRows[0];
    if (workspace === undefined || workspace.status !== "active") {
      return false;
    }
    const [claims, owners] = await Promise.all([
      this.#db
        .select({ workspaceId: authOwnerBootstraps.workspaceId })
        .from(authOwnerBootstraps)
        .where(eq(authOwnerBootstraps.workspaceId, workspace.id))
        .limit(1),
      this.#db
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(
          and(
            eq(authUsers.workspaceId, workspace.id),
            eq(authUsers.role, "owner"),
          ),
        )
        .limit(1),
    ]);
    return claims[0] === undefined && owners[0] === undefined;
  }

  async claimFirstOwner(
    input: ClaimFirstOwnerInput,
  ): Promise<AuthSessionProfile | null> {
    const email = normalizeAuthEmail(input.email);
    return this.#db.transaction(async (transaction) => {
      const workspaceRows = await transaction
        .select()
        .from(workspaces)
        .where(eq(workspaces.organization, input.organization.trim()))
        .limit(1)
        .for("update");
      const workspace = workspaceRows[0];
      if (workspace === undefined || workspace.status !== "active") {
        return null;
      }
      const claims = await transaction
        .select({ workspaceId: authOwnerBootstraps.workspaceId })
        .from(authOwnerBootstraps)
        .where(eq(authOwnerBootstraps.workspaceId, workspace.id))
        .limit(1);
      const owners = await transaction
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(
          and(
            eq(authUsers.workspaceId, workspace.id),
            eq(authUsers.role, "owner"),
          ),
        )
        .limit(1);
      if (claims[0] !== undefined || owners[0] !== undefined) {
        return null;
      }
      const existingEmail = await transaction
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(eq(authUsers.email, email))
        .limit(1);
      if (existingEmail[0] !== undefined) {
        return null;
      }

      const userId = randomUUID();
      const insertedUsers = await transaction
        .insert(authUsers)
        .values({
          id: userId,
          workspaceId: workspace.id,
          email,
          status: "active",
          role: "owner",
          passwordHash: input.passwordHash,
        })
        .onConflictDoNothing({ target: authUsers.email })
        .returning({ id: authUsers.id });
      if (insertedUsers[0] === undefined) {
        return null;
      }
      await transaction.insert(authOwnerBootstraps).values({
        workspaceId: workspace.id,
        claimedByUserId: userId,
      });
      await transaction.insert(authSessions).values({
        id: input.sessionId,
        userId,
        tokenHash: input.sessionTokenHash,
        expiresAt: input.sessionExpiresAt,
      });
      return profileFromIdentity(
        {
          userId,
          email,
          userStatus: "active",
          role: "owner",
          passwordHash: input.passwordHash,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          organization: workspace.organization,
          workspaceStatus: workspace.status,
        },
        input.sessionExpiresAt,
      );
    });
  }

  async createSessionForUser(
    input: CreateAuthSessionInput,
  ): Promise<AuthSessionProfile | null> {
    return this.#db.transaction(async (transaction) => {
      const identities = await transaction
        .select(identitySelection)
        .from(authUsers)
        .innerJoin(workspaces, eq(authUsers.workspaceId, workspaces.id))
        .where(eq(authUsers.id, input.userId))
        .limit(1);
      const identity = identities[0];
      if (
        identity === undefined ||
        identity.userStatus !== "active" ||
        identity.workspaceStatus !== "active"
      ) {
        return null;
      }
      await transaction.insert(authSessions).values({
        id: input.sessionId,
        userId: input.userId,
        tokenHash: input.sessionTokenHash,
        expiresAt: input.sessionExpiresAt,
      });
      return profileFromIdentity(identity, input.sessionExpiresAt);
    });
  }

  async changeOwnerPassword(input: {
    userId: string;
    workspaceId: string;
    sessionId: string;
    currentPasswordHash: string;
    newPasswordHash: string;
  }): Promise<boolean> {
    return this.#db.transaction(async (transaction) => {
      const updated = await transaction
        .update(authUsers)
        .set({ passwordHash: input.newPasswordHash, updatedAt: new Date() })
        .where(
          and(
            eq(authUsers.id, input.userId),
            eq(authUsers.workspaceId, input.workspaceId),
            eq(authUsers.role, "owner"),
            eq(authUsers.status, "active"),
            eq(authUsers.passwordHash, input.currentPasswordHash),
          ),
        )
        .returning({ id: authUsers.id });
      if (updated[0] === undefined) {
        return false;
      }
      await transaction
        .update(authSessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(authSessions.userId, input.userId),
            ne(authSessions.id, input.sessionId),
            isNull(authSessions.revokedAt),
          ),
        );
      return true;
    });
  }

  async issuePasswordReset(
    input: IssuePasswordResetInput,
  ): Promise<boolean> {
    const email = normalizeAuthEmail(input.email);
    return this.#db.transaction(async (transaction) => {
      const identities = await transaction
        .select(identitySelection)
        .from(authUsers)
        .innerJoin(workspaces, eq(authUsers.workspaceId, workspaces.id))
        .where(
          and(
            eq(authUsers.email, email),
            eq(workspaces.organization, input.organization.trim()),
          ),
        )
        .limit(1)
        .for("update");
      const identity = identities[0];
      if (
        identity === undefined ||
        identity.role !== "owner" ||
        identity.userStatus !== "active" ||
        identity.workspaceStatus !== "active"
      ) {
        return false;
      }
      const now = new Date();
      await transaction
        .update(authPasswordResets)
        .set({ revokedAt: now })
        .where(
          and(
            eq(authPasswordResets.userId, identity.userId),
            isNull(authPasswordResets.consumedAt),
            isNull(authPasswordResets.revokedAt),
          ),
        );
      await transaction.insert(authPasswordResets).values({
        id: input.id,
        userId: identity.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      });
      return true;
    });
  }

  async consumePasswordReset(
    input: ConsumePasswordResetInput,
  ): Promise<AuthSessionProfile | null> {
    try {
      return await this.#db.transaction(async (transaction) => {
        const now = new Date();
        const consumed = await transaction
          .update(authPasswordResets)
          .set({ consumedAt: now })
          .where(
            and(
              eq(authPasswordResets.tokenHash, input.tokenHash),
              isNull(authPasswordResets.consumedAt),
              isNull(authPasswordResets.revokedAt),
              gt(authPasswordResets.expiresAt, now),
            ),
          )
          .returning({ userId: authPasswordResets.userId });
        const reset = consumed[0];
        if (reset === undefined) {
          return null;
        }
        const identities = await transaction
          .select(identitySelection)
          .from(authUsers)
          .innerJoin(workspaces, eq(authUsers.workspaceId, workspaces.id))
          .where(eq(authUsers.id, reset.userId))
          .limit(1);
        const identity = identities[0];
        if (
          identity === undefined ||
          identity.role !== "owner" ||
          identity.userStatus !== "active" ||
          identity.workspaceStatus !== "active"
        ) {
          throw new InactiveAuthIdentityError();
        }
        await transaction
          .update(authUsers)
          .set({ passwordHash: input.passwordHash, updatedAt: now })
          .where(eq(authUsers.id, reset.userId));
        await transaction
          .update(authSessions)
          .set({ revokedAt: now })
          .where(
            and(
              eq(authSessions.userId, reset.userId),
              isNull(authSessions.revokedAt),
            ),
          );
        await transaction.insert(authSessions).values({
          id: input.sessionId,
          userId: reset.userId,
          tokenHash: input.sessionTokenHash,
          expiresAt: input.sessionExpiresAt,
        });
        return profileFromIdentity(
          { ...identity, passwordHash: input.passwordHash },
          input.sessionExpiresAt,
        );
      });
    } catch (error) {
      if (error instanceof InactiveAuthIdentityError) {
        return null;
      }
      throw error;
    }
  }

  async findOrCreateSignupUser(input: {
    email: string;
    organizationName: string;
  }, options?: {
    bootstrapOrganization?: string;
  }): Promise<AuthUserProvisionResult> {
    const email = normalizeAuthEmail(input.email);
    const organizationName = input.organizationName.trim();
    if (organizationName.length === 0 || organizationName.length > 200) {
      throw new Error("Organization name must contain 1 to 200 characters");
    }

    return this.#db.transaction(async (transaction) => {
      const existingRows = await transaction
        .select(identitySelection)
        .from(authUsers)
        .innerJoin(workspaces, eq(authUsers.workspaceId, workspaces.id))
        .where(eq(authUsers.email, email))
        .limit(1);
      const existing = existingRows[0];
      if (existing !== undefined) {
        return { user: recordFromIdentity(existing), created: false };
      }

      const bootstrapOrganization = options?.bootstrapOrganization?.trim();
      if (bootstrapOrganization !== undefined && bootstrapOrganization !== "") {
        const bootstrapRows = await transaction
          .select()
          .from(workspaces)
          .where(eq(workspaces.organization, bootstrapOrganization))
          .limit(1)
          .for("update");
        const bootstrap = bootstrapRows[0];
        if (bootstrap !== undefined && bootstrap.status === "active") {
          const existingBootstrapUsers = await transaction
            .select({ id: authUsers.id })
            .from(authUsers)
            .where(eq(authUsers.workspaceId, bootstrap.id))
            .limit(1);
          if (existingBootstrapUsers[0] === undefined) {
            const userId = randomUUID();
            const insertedUsers = await transaction
              .insert(authUsers)
              .values({
                id: userId,
                workspaceId: bootstrap.id,
                email,
                status: "active",
                role: "owner",
              })
              .onConflictDoNothing({ target: authUsers.email })
              .returning({ id: authUsers.id });
            if (insertedUsers[0] !== undefined) {
              const now = new Date();
              await transaction
                .update(workspaces)
                .set({ name: organizationName, updatedAt: now })
                .where(eq(workspaces.id, bootstrap.id));
              return {
                user: recordFromIdentity({
                  userId,
                  email,
                  userStatus: "active",
                  role: "owner",
                  passwordHash: null,
                  workspaceId: bootstrap.id,
                  workspaceName: organizationName,
                  organization: bootstrap.organization,
                  workspaceStatus: bootstrap.status,
                }),
                created: true,
              };
            }
            const racedRows = await transaction
              .select(identitySelection)
              .from(authUsers)
              .innerJoin(workspaces, eq(authUsers.workspaceId, workspaces.id))
              .where(eq(authUsers.email, email))
              .limit(1);
            const raced = racedRows[0];
            if (raced !== undefined) {
              return { user: recordFromIdentity(raced), created: false };
            }
          }
        }
      }

      const workspaceId = randomUUID();
      const identifier = workspaceIdentifier(organizationName, workspaceId);
      await transaction.insert(workspaces).values({
        id: workspaceId,
        slug: identifier,
        organization: identifier,
        name: organizationName,
        status: "active",
      });

      const insertedUsers = await transaction
        .insert(authUsers)
        .values({
          id: randomUUID(),
          workspaceId,
          email,
          status: "active",
          role: "owner",
        })
        .onConflictDoNothing({ target: authUsers.email })
        .returning({ id: authUsers.id });
      if (insertedUsers[0] !== undefined) {
        const createdRows = await transaction
          .select(identitySelection)
          .from(authUsers)
          .innerJoin(workspaces, eq(authUsers.workspaceId, workspaces.id))
          .where(eq(authUsers.id, insertedUsers[0].id))
          .limit(1);
        const created = createdRows[0];
        if (created === undefined) {
          throw new Error("Created auth user could not be loaded");
        }
        return { user: recordFromIdentity(created), created: true };
      }

      await transaction.delete(workspaces).where(eq(workspaces.id, workspaceId));
      const racedRows = await transaction
        .select(identitySelection)
        .from(authUsers)
        .innerJoin(workspaces, eq(authUsers.workspaceId, workspaces.id))
        .where(eq(authUsers.email, email))
        .limit(1);
      const raced = racedRows[0];
      if (raced === undefined) {
        throw new Error("Auth user creation conflicted but could not be loaded");
      }
      return { user: recordFromIdentity(raced), created: false };
    });
  }

  async issueMagicLink(input: IssueMagicLinkInput): Promise<void> {
    await this.#db.transaction(async (transaction) => {
      const users = await transaction
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(eq(authUsers.id, input.userId))
        .limit(1)
        .for("update");
      if (users[0] === undefined) {
        throw new Error("Cannot issue a magic link for an unknown user");
      }

      const now = new Date();
      await transaction
        .update(authMagicLinks)
        .set({ revokedAt: now })
        .where(
          and(
            eq(authMagicLinks.userId, input.userId),
            isNull(authMagicLinks.consumedAt),
            isNull(authMagicLinks.revokedAt),
          ),
        );
      await transaction.insert(authMagicLinks).values({
        id: input.id,
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      });
    });
  }

  async revokeMagicLink(id: string): Promise<void> {
    await this.#db
      .update(authMagicLinks)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(authMagicLinks.id, id),
          isNull(authMagicLinks.consumedAt),
          isNull(authMagicLinks.revokedAt),
        ),
      );
  }

  async verifyMagicLink(
    input: VerifyMagicLinkInput,
  ): Promise<AuthSessionProfile | null> {
    try {
      return await this.#db.transaction(async (transaction) => {
        const now = new Date();
        const consumed = await transaction
          .update(authMagicLinks)
          .set({ consumedAt: now })
          .where(
            and(
              eq(authMagicLinks.tokenHash, input.tokenHash),
              isNull(authMagicLinks.consumedAt),
              isNull(authMagicLinks.revokedAt),
              gt(authMagicLinks.expiresAt, now),
            ),
          )
          .returning({ userId: authMagicLinks.userId });
        const magicLink = consumed[0];
        if (magicLink === undefined) {
          return null;
        }

        const identityRows = await transaction
          .select(identitySelection)
          .from(authUsers)
          .innerJoin(workspaces, eq(authUsers.workspaceId, workspaces.id))
          .where(eq(authUsers.id, magicLink.userId))
          .limit(1);
        const identity = identityRows[0];
        if (
          identity === undefined ||
          identity.userStatus !== "active" ||
          identity.workspaceStatus !== "active"
        ) {
          throw new InactiveAuthIdentityError();
        }

        await transaction.insert(authSessions).values({
          id: input.sessionId,
          userId: magicLink.userId,
          tokenHash: input.sessionTokenHash,
          expiresAt: input.sessionExpiresAt,
        });
        return profileFromIdentity(identity, input.sessionExpiresAt);
      });
    } catch (error) {
      if (error instanceof InactiveAuthIdentityError) {
        return null;
      }
      throw error;
    }
  }

  async authenticateSession(
    token: string,
  ): Promise<AuthenticatedWorkspace | null> {
    if (!AUTH_TOKEN_PATTERN.test(token)) {
      return null;
    }
    const now = new Date();
    const sessions = await this.#db
      .update(authSessions)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(authSessions.tokenHash, hashAuthToken(token)),
          isNull(authSessions.revokedAt),
          gt(authSessions.expiresAt, now),
        ),
      )
      .returning({
        sessionId: authSessions.id,
        userId: authSessions.userId,
        expiresAt: authSessions.expiresAt,
      });
    const session = sessions[0];
    if (session === undefined) {
      return null;
    }

    const identities = await this.#db
      .select(identitySelection)
      .from(authUsers)
      .innerJoin(workspaces, eq(authUsers.workspaceId, workspaces.id))
      .where(
        and(
          eq(authUsers.id, session.userId),
          eq(authUsers.status, "active"),
          eq(workspaces.status, "active"),
        ),
      )
      .limit(1);
    const identity = identities[0];
    if (identity === undefined) {
      return null;
    }
    return AuthenticatedWorkspaceSchema.parse({
      workspaceId: identity.workspaceId,
      organization: identity.organization,
      tokenId: session.sessionId,
      credentialType: "session",
      userId: identity.userId,
      email: identity.email,
      workspaceName: identity.workspaceName,
      role: identity.role,
      sessionExpiresAt: session.expiresAt.toISOString(),
    });
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.#db
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(authSessions.id, sessionId),
          isNull(authSessions.revokedAt),
        ),
      );
  }
}
