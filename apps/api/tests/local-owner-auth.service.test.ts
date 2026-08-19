import { hash } from "@node-rs/argon2";
import type { AuthSessionProfile } from "@lore-co/core";
import type { PostgresAuthRepository } from "@lore-co/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../src/auth/auth.service.js";

const bootstrapToken = "b".repeat(64);
const profile: AuthSessionProfile = {
  userId: "11111111-1111-4111-8111-111111111111",
  email: "owner@example.com",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  workspaceName: "Local Lore",
  organization: "local",
  role: "owner",
  expiresAt: "2099-01-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.stubEnv("AUTH_MODE", "local_owner");
  vi.stubEnv("AUTH_WEB_ORIGIN", "http://localhost:3002");
  vi.stubEnv("NUXT_ORIGIN", "http://localhost:3002");
  vi.stubEnv("DATABASE_URL", "postgresql://lore:password@localhost:5432/lore");
  vi.stubEnv("LORE_WORKSPACE_TOKEN", "workspace-token-12345678901234567890");
  vi.stubEnv("LORE_WORKSPACE_ORGANIZATION", "local");
  vi.stubEnv("LORE_OWNER_BOOTSTRAP_TOKEN", bootstrapToken);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("local-owner auth service", () => {
  it("reports bootstrap status without exposing the bootstrap secret", async () => {
    const repository = {
      isOwnerBootstrapRequired: vi.fn(async () => true),
    } as unknown as PostgresAuthRepository;
    const service = new AuthService(repository);

    await expect(service.publicConfig()).resolves.toEqual({
      mode: "local_owner",
      bootstrapRequired: true,
    });
    expect(JSON.stringify(await service.publicConfig())).not.toContain(
      bootstrapToken,
    );
  });

  it("disables generic signup and magic-link login", async () => {
    const repository = {} as PostgresAuthRepository;
    const service = new AuthService(repository);

    await expect(
      service.signup({
        organizationName: "Untrusted tenant",
        email: "attacker@example.com",
      }),
    ).rejects.toThrow("Not Found");
    await expect(
      service.login({ email: "attacker@example.com" }),
    ).rejects.toThrow("Not Found");
  });

  it("rejects an invalid bootstrap token before creating state", async () => {
    const repository = {
      claimFirstOwner: vi.fn(),
    } as unknown as PostgresAuthRepository;
    const service = new AuthService(repository);

    await expect(
      service.claimLocalOwner(
        {
          email: "owner@example.com",
          password: "correct horse battery staple",
        },
        "a".repeat(64),
        "127.0.0.1",
      ),
    ).rejects.toThrow("Bootstrap claim is unavailable");
    expect(repository.claimFirstOwner).not.toHaveBeenCalled();
  });

  it("stores an Argon2id hash and returns a normal owner session", async () => {
    let capturedPasswordHash = "";
    const repository = {
      claimFirstOwner: vi.fn(async (input: { passwordHash: string }) => {
        capturedPasswordHash = input.passwordHash;
        return profile;
      }),
    } as unknown as PostgresAuthRepository;
    const service = new AuthService(repository);

    await expect(
      service.claimLocalOwner(
        {
          email: "owner@example.com",
          password: "correct horse battery staple",
        },
        bootstrapToken,
        "127.0.0.1",
      ),
    ).resolves.toMatchObject({
      sessionToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      session: { role: "owner", email: "owner@example.com" },
    });
    expect(capturedPasswordHash).toMatch(/^\$argon2id\$/u);
    expect(capturedPasswordHash).not.toContain("correct horse battery staple");
  });

  it("logs in with a valid password and uses a static invalid error", async () => {
    const passwordHash = await hash("correct horse battery staple");
    const repository = {
      findUserByEmail: vi.fn(async (email: string) =>
        email === "owner@example.com"
          ? {
              ...profile,
              expiresAt: undefined,
              userStatus: "active",
              workspaceStatus: "active",
              passwordHash,
            }
          : null,
      ),
      createSessionForUser: vi.fn(async () => profile),
    } as unknown as PostgresAuthRepository;
    const service = new AuthService(repository);

    await expect(
      service.passwordLogin(
        {
          email: "owner@example.com",
          password: "correct horse battery staple",
        },
        "127.0.0.1",
      ),
    ).resolves.toMatchObject({ session: { email: "owner@example.com" } });
    await expect(
      service.passwordLogin(
        {
          email: "owner@example.com",
          password: "incorrect password value",
        },
        "127.0.0.2",
      ),
    ).rejects.toThrow("Invalid email or password");
    await expect(
      service.passwordLogin(
        {
          email: "unknown@example.com",
          password: "incorrect password value",
        },
        "127.0.0.3",
      ),
    ).rejects.toThrow("Invalid email or password");
  });

  it("rejects expired or replayed password reset tokens", async () => {
    const repository = {
      consumePasswordReset: vi.fn(async () => null),
    } as unknown as PostgresAuthRepository;
    const service = new AuthService(repository);

    await expect(
      service.consumePasswordReset(
        {
          token: "a".repeat(43),
          password: "replacement password value",
        },
        "127.0.0.1",
      ),
    ).rejects.toThrow("Invalid or expired password reset");
  });
});
