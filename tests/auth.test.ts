import { createHash } from "node:crypto";
import {
  AuthLoginRequestSchema,
  AuthSignupRequestSchema,
  AuthTokenSchema,
  CreateWorkspaceTokenRequestSchema,
  WorkspaceIdentityResponseSchema,
  WorkspaceTokenSecretSchema,
} from "@lore-co/core";
import type {
  IssueMagicLinkInput,
  PostgresAuthRepository,
} from "@lore-co/database";
import { AuthService } from "../apps/api/src/auth/auth.service.js";
import { apiDeploymentConfig } from "../apps/api/src/common/deployment-config.js";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("passwordless auth contracts", () => {
  it("normalizes email addresses for signup and login", () => {
    expect(
      AuthSignupRequestSchema.parse({
        organizationName: " Acme Engineering ",
        email: " Owner@Example.COM ",
      }),
    ).toEqual({
      organizationName: "Acme Engineering",
      email: "owner@example.com",
    });
    expect(
      AuthLoginRequestSchema.parse({ email: " Owner@Example.COM " }),
    ).toEqual({ email: "owner@example.com" });
  });

  it("rejects password fields and malformed magic tokens", () => {
    expect(() =>
      AuthSignupRequestSchema.parse({
        organizationName: "Acme",
        email: "owner@example.com",
        password: "not-supported",
      }),
    ).toThrow();
    expect(() => AuthTokenSchema.parse("short-token")).toThrow();
    expect(() => AuthTokenSchema.parse("!".repeat(43))).toThrow();
  });

  it("validates named workspace token creation without accepting raw secrets", () => {
    expect(
      CreateWorkspaceTokenRequestSchema.parse({
        name: " Dante’s MacBook ",
        expiresInDays: 90,
      }),
    ).toEqual({
      name: "Dante’s MacBook",
      expiresInDays: 90,
    });
    expect(
      WorkspaceTokenSecretSchema.parse(`lore_${"a".repeat(43)}`),
    ).toHaveLength(48);
    expect(() =>
      CreateWorkspaceTokenRequestSchema.parse({
        name: "CI",
        expiresInDays: 366,
        token: "caller-controlled-secret",
      }),
    ).toThrow();
  });

  it("accepts only the safe strict workspace identity contract", () => {
    const identity = {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      workspaceName: "Acme Engineering",
      organization: "acme",
      credentialType: "session" as const,
      role: "owner" as const,
      server: {
        version: "0.1.5",
        revision: "0123456789abcdef",
      },
    };

    expect(WorkspaceIdentityResponseSchema.parse(identity)).toEqual(identity);
    expect(() =>
      WorkspaceIdentityResponseSchema.parse({
        ...identity,
        token: "must-not-be-returned",
      }),
    ).toThrow();
    expect(() =>
      WorkspaceIdentityResponseSchema.parse({
        ...identity,
        server: { ...identity.server, unexpected: true },
      }),
    ).toThrow();
  });
});

describe("deployment auth configuration", () => {
  const productionBase = {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://lore:password@localhost:5432/lore",
    LORE_WORKSPACE_TOKEN: "workspace-token-12345678901234567890",
    LORE_WORKSPACE_ORGANIZATION: "example",
  } as const;

  it("disables browser authentication by default", () => {
    expect(apiDeploymentConfig({})).toMatchObject({
      auth: { mode: "disabled" },
      corsOrigins: [],
    });
  });

  it("rejects local magic-link logging in production", () => {
    expect(() =>
      apiDeploymentConfig({
        ...productionBase,
        AUTH_EMAIL_MODE: "local",
        AUTH_WEB_ORIGIN: "https://lore.example.com",
        NUXT_ORIGIN: "https://lore.example.com",
      }),
    ).toThrow("AUTH_EMAIL_MODE=local is not allowed in production");
  });

  it("requires matching HTTPS dashboard origins", () => {
    expect(() =>
      apiDeploymentConfig({
        ...productionBase,
        AUTH_EMAIL_MODE: "resend",
        AUTH_WEB_ORIGIN: "https://lore.example.com",
        NUXT_ORIGIN: "https://other.example.com",
        AUTH_EMAIL_FROM: "Lore <auth@example.com>",
        RESEND_API_KEY: "resend-test-key",
      }),
    ).toThrow("NUXT_ORIGIN must include AUTH_WEB_ORIGIN");
  });

  it("requires an explicit dashboard CORS origin in Resend mode", () => {
    expect(() =>
      apiDeploymentConfig({
        ...productionBase,
        AUTH_EMAIL_MODE: "resend",
        AUTH_WEB_ORIGIN: "https://lore.example.com",
        AUTH_EMAIL_FROM: "Lore <auth@example.com>",
        RESEND_API_KEY: "resend-test-key",
      }),
    ).toThrow("NUXT_ORIGIN is required when AUTH_MODE=magic_link");
  });

  it("accepts an aligned production dashboard origin", () => {
    expect(
      apiDeploymentConfig({
        ...productionBase,
        AUTH_EMAIL_MODE: "resend",
        AUTH_WEB_ORIGIN: "https://lore.example.com",
        NUXT_ORIGIN: "https://lore.example.com",
        AUTH_EMAIL_FROM: "Lore <auth@example.com>",
        RESEND_API_KEY: "resend-test-key",
      }),
    ).toMatchObject({
      auth: {
        mode: "magic_link",
        webOrigin: "https://lore.example.com",
        delivery: { mode: "resend" },
      },
      corsOrigins: ["https://lore.example.com"],
    });
  });
});

describe("passwordless email delivery", () => {
  it("returns not found without creating state when auth is disabled", async () => {
    vi.stubEnv("AUTH_EMAIL_MODE", "disabled");
    const repository = {
      findUserByEmail: vi.fn(),
      issueMagicLink: vi.fn(),
    } as unknown as PostgresAuthRepository;

    const service = new AuthService(repository);
    await expect(
      service.login({ email: "owner@example.com" }),
    ).rejects.toThrow("Not Found");
    expect(repository.findUserByEmail).not.toHaveBeenCalled();
    expect(repository.issueMagicLink).not.toHaveBeenCalled();
  });

  it("sends a hashed, one-time link through Resend in production mode", async () => {
    vi.stubEnv("AUTH_EMAIL_MODE", "resend");
    vi.stubEnv("AUTH_WEB_ORIGIN", "https://lore.example.com");
    vi.stubEnv("NUXT_ORIGIN", "https://lore.example.com");
    vi.stubEnv("AUTH_EMAIL_FROM", "Lore <auth@example.com>");
    vi.stubEnv("RESEND_API_KEY", "resend-test-key");
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    let issued: IssueMagicLinkInput | undefined;
    const repository = {
      findUserByEmail: vi.fn(async () => ({
        userId: "11111111-1111-4111-8111-111111111111",
        email: "owner@example.com",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        workspaceName: "Acme",
        organization: "acme-22222222-2222-4222-8222-222222222222",
        userStatus: "active",
        workspaceStatus: "active",
      })),
      issueMagicLink: vi.fn(async (input: IssueMagicLinkInput) => {
        issued = input;
      }),
      revokeMagicLink: vi.fn(),
    } as unknown as PostgresAuthRepository;

    const service = new AuthService(repository);
    await expect(
      service.login({ email: "owner@example.com" }),
    ).resolves.toEqual({ accepted: true });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.resend.com/emails");
    expect(options.headers).toMatchObject({
      authorization: "Bearer resend-test-key",
    });
    const payload = JSON.parse(String(options.body)) as {
      from: string;
      to: string[];
      text: string;
    };
    expect(payload).toMatchObject({
      from: "Lore <auth@example.com>",
      to: ["owner@example.com"],
    });
    expect(payload.text).not.toContain("onboarding=connect");
    const rawToken = /#token=([A-Za-z0-9_-]{43})/u.exec(payload.text)?.[1];
    expect(rawToken).toBeDefined();
    expect(issued?.tokenHash).toBe(
      createHash("sha256")
        .update(rawToken as string, "utf8")
        .digest("hex"),
    );
    expect(stdout).not.toHaveBeenCalled();
  });

  it("sends newly created workspaces to connector onboarding", async () => {
    vi.stubEnv("AUTH_EMAIL_MODE", "local");
    vi.stubEnv("AUTH_WEB_ORIGIN", "https://lore.example.com");
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const user = {
      userId: "11111111-1111-4111-8111-111111111111",
      email: "owner@example.com",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      workspaceName: "Acme",
      organization: "acme-22222222-2222-4222-8222-222222222222",
      userStatus: "active" as const,
      workspaceStatus: "active" as const,
    };
    const repository = {
      findOrCreateSignupUser: vi.fn(async () => ({ user, created: true })),
      issueMagicLink: vi.fn(),
      revokeMagicLink: vi.fn(),
    } as unknown as PostgresAuthRepository;

    const service = new AuthService(repository);
    await expect(
      service.signup({
        organizationName: "Acme",
        email: "owner@example.com",
      }),
    ).resolves.toEqual({ accepted: true });

    const output = stdout.mock.calls.flat().join("");
    expect(output).toContain("/auth/verify#token=");
    expect(output).toContain("&onboarding=connect");
  });
});
