import type { AuthenticatedWorkspace, WorkspaceToken } from "@lore-co/core";
import type { PostgresPilotRepository } from "@lore-co/database";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceTokenService } from "../apps/api/src/workspace-token/workspace-token.service.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const tokenId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";

const dashboardSession: AuthenticatedWorkspace = {
  workspaceId,
  organization: "acme",
  tokenId: "44444444-4444-4444-8444-444444444444",
  credentialType: "session",
  userId,
  email: "owner@example.com",
  workspaceName: "Acme",
  role: "owner",
  sessionExpiresAt: "2099-01-01T00:00:00.000Z",
};

function token(overrides: Partial<WorkspaceToken> = {}): WorkspaceToken {
  return {
    id: tokenId,
    name: "Dante’s MacBook",
    tokenPrefix: "lore_abcd",
    status: "active",
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: "2026-08-13T04:00:00.000Z",
    ...overrides,
  };
}

describe("workspace token management", () => {
  it("scopes listing to the dashboard session workspace", async () => {
    const listWorkspaceTokens = vi.fn(async () => [token()]);
    const repository = {
      listWorkspaceTokens,
    } as unknown as PostgresPilotRepository;

    const result = await new WorkspaceTokenService(repository).list(
      dashboardSession,
    );

    expect(listWorkspaceTokens).toHaveBeenCalledWith(workspaceId);
    expect(result.tokens).toEqual([token()]);
  });

  it("generates the secret server-side and returns it only at creation", async () => {
    const createWorkspaceToken = vi.fn(
      async (input: {
        workspaceId: string;
        name: string;
        token: string;
        expiresAt?: Date;
      }) =>
        token({
          name: input.name,
          expiresAt: input.expiresAt?.toISOString() ?? null,
        }),
    );
    const repository = {
      createWorkspaceToken,
    } as unknown as PostgresPilotRepository;

    const result = await new WorkspaceTokenService(repository).create(
      dashboardSession,
      {
        name: " CI ",
        expiresInDays: 30,
      },
    );

    expect(result.token).toMatch(/^lore_[A-Za-z0-9_-]{43}$/u);
    expect(result.workspaceToken.name).toBe("CI");
    expect(createWorkspaceToken).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        name: "CI",
        token: result.token,
        expiresAt: expect.any(Date),
      }),
    );
  });

  it("rejects workspace credentials that are not dashboard sessions", async () => {
    const repository = {} as PostgresPilotRepository;
    await expect(
      new WorkspaceTokenService(repository).list({
        workspaceId,
        organization: "acme",
        tokenId: "55555555-5555-4555-8555-555555555555",
        credentialType: "workspace_token",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects member sessions", async () => {
    const repository = {} as PostgresPilotRepository;
    await expect(
      new WorkspaceTokenService(repository).list({
        ...dashboardSession,
        role: "member",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("reports missing or already-revoked tokens", async () => {
    const repository = {
      revokeWorkspaceToken: vi.fn(async () => null),
    } as unknown as PostgresPilotRepository;

    await expect(
      new WorkspaceTokenService(repository).revoke(dashboardSession, tokenId),
    ).rejects.toMatchObject({ status: 404 });
  });
});
