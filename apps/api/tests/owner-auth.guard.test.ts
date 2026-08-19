import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { OwnerAuthGuard } from "../src/common/owner-auth.guard.js";

function context(workspace: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ workspace }),
    }),
  } as unknown as ExecutionContext;
}

describe("OwnerAuthGuard", () => {
  const base = {
    workspaceId: "22222222-2222-4222-8222-222222222222",
    organization: "local",
    tokenId: "33333333-3333-4333-8333-333333333333",
  };

  it("allows owner sessions", () => {
    expect(
      new OwnerAuthGuard().canActivate(
        context({
          ...base,
          credentialType: "session",
          userId: "11111111-1111-4111-8111-111111111111",
          role: "owner",
        }),
      ),
    ).toBe(true);
  });

  it("rejects members and workspace tokens", () => {
    expect(() =>
      new OwnerAuthGuard().canActivate(
        context({
          ...base,
          credentialType: "session",
          userId: "11111111-1111-4111-8111-111111111111",
          role: "member",
        }),
      ),
    ).toThrow("Workspace owner access is required");
    expect(() =>
      new OwnerAuthGuard().canActivate(
        context({ ...base, credentialType: "workspace_token" }),
      ),
    ).toThrow("Workspace owner access is required");
  });
});
