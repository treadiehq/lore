import { createHash } from "node:crypto";
import {
  AuthLoginRequestSchema,
  AuthSignupRequestSchema,
  AuthTokenSchema,
  CreateWorkspaceTokenRequestSchema,
  WorkspaceTokenSecretSchema,
} from "@lore-co/core";
import type {
  IssueMagicLinkInput,
  PostgresAuthRepository,
} from "@lore-co/database";
import { AuthService } from "../apps/api/src/auth/auth.service.js";
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
});

describe("passwordless email delivery", () => {
  it("sends a hashed, one-time link through Resend in production mode", async () => {
    vi.stubEnv("AUTH_EMAIL_MODE", "resend");
    vi.stubEnv("AUTH_WEB_ORIGIN", "https://lore.example.com");
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
