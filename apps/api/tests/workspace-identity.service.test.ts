import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceIdentityService } from "../src/workspace-identity/workspace-identity.service.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("WorkspaceIdentityService", () => {
  it("returns safe identity fields for a workspace token", () => {
    vi.stubEnv("LORE_SERVER_VERSION", "0.1.4");
    vi.stubEnv("LORE_SERVER_REVISION", "revision-123");

    expect(
      new WorkspaceIdentityService().get({
        workspaceId: "22222222-2222-4222-8222-222222222222",
        workspaceName: "Acme Engineering",
        organization: "acme",
        tokenId: "33333333-3333-4333-8333-333333333333",
        credentialType: "workspace_token",
      }),
    ).toEqual({
      workspaceId: "22222222-2222-4222-8222-222222222222",
      workspaceName: "Acme Engineering",
      organization: "acme",
      credentialType: "workspace_token",
      server: {
        version: "0.1.4",
        revision: "revision-123",
      },
    });
  });

  it("includes role for sessions without exposing user or token fields", () => {
    vi.stubEnv("LORE_SERVER_VERSION", "0.1.4");

    const identity = new WorkspaceIdentityService().get({
      workspaceId: "22222222-2222-4222-8222-222222222222",
      workspaceName: "Acme Engineering",
      organization: "acme",
      tokenId: "33333333-3333-4333-8333-333333333333",
      credentialType: "session",
      userId: "11111111-1111-4111-8111-111111111111",
      email: "owner@example.com",
      role: "owner",
      sessionExpiresAt: "2026-09-18T12:00:00.000Z",
    });

    expect(identity.role).toBe("owner");
    expect(identity).not.toHaveProperty("tokenId");
    expect(identity).not.toHaveProperty("email");
    expect(identity.server.revision).toBeNull();
  });
});
