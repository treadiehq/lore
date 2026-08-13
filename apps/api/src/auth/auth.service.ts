import { randomBytes, randomUUID } from "node:crypto";
import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import {
  AuthInitiationResponseSchema,
  AuthLoginRequestSchema,
  AuthSessionProfileSchema,
  AuthSessionResponseSchema,
  AuthSignupRequestSchema,
  AuthTokenSchema,
  AuthVerifyRequestSchema,
  AuthVerifyResponseSchema,
  type AuthenticatedWorkspace,
  type AuthInitiationResponse,
  type AuthLoginRequest,
  type AuthSessionProfile,
  type AuthSessionResponse,
  type AuthSignupRequest,
  type AuthVerifyRequest,
  type AuthVerifyResponse,
} from "@lore-co/core";
import {
  hashAuthToken,
  type AuthUserRecord,
  type PostgresAuthRepository,
} from "@lore-co/database";
import { AUTH_REPOSITORY } from "../common/tokens.js";

const INITIATION_LIMIT = 5;
const INITIATION_WINDOW_MS = 15 * 60 * 1_000;
const DEFAULT_MAGIC_LINK_TTL_MINUTES = 15;
const DEFAULT_SESSION_TTL_DAYS = 30;

interface InitiationWindow {
  startedAt: number;
  count: number;
}

type AuthEmailConfig =
  | {
      mode: "local";
      webOrigin: string;
      magicLinkTtlMs: number;
    }
  | {
      mode: "resend";
      webOrigin: string;
      magicLinkTtlMs: number;
      apiKey: string;
      from: string;
    };

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required when AUTH_EMAIL_MODE=resend`);
  }
  return value;
}

function magicLinkTtlMs(): number {
  const raw = process.env.AUTH_MAGIC_LINK_TTL_MINUTES?.trim();
  if (raw === undefined || raw === "") {
    return DEFAULT_MAGIC_LINK_TTL_MINUTES * 60 * 1_000;
  }
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1_440) {
    throw new Error(
      "AUTH_MAGIC_LINK_TTL_MINUTES must be an integer from 1 to 1440",
    );
  }
  return minutes * 60 * 1_000;
}

function sessionTtlMs(): number {
  const raw = process.env.AUTH_SESSION_TTL_DAYS?.trim();
  if (raw === undefined || raw === "") {
    return DEFAULT_SESSION_TTL_DAYS * 24 * 60 * 60 * 1_000;
  }
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error(
      "AUTH_SESSION_TTL_DAYS must be an integer from 1 to 365",
    );
  }
  return days * 24 * 60 * 60 * 1_000;
}

function authEmailConfig(): AuthEmailConfig {
  const mode = process.env.AUTH_EMAIL_MODE?.trim() || "local";
  if (mode !== "local" && mode !== "resend") {
    throw new Error('AUTH_EMAIL_MODE must be either "local" or "resend"');
  }

  const configuredOrigin = process.env.AUTH_WEB_ORIGIN?.trim();
  const rawOrigin = configuredOrigin || "http://localhost:3002";
  let origin: URL;
  try {
    origin = new URL(rawOrigin);
  } catch {
    throw new Error("AUTH_WEB_ORIGIN must be a valid HTTP(S) origin");
  }
  if (
    (origin.protocol !== "http:" && origin.protocol !== "https:") ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new Error("AUTH_WEB_ORIGIN must be an HTTP(S) origin without a path");
  }

  if (mode === "resend" && origin.protocol !== "https:") {
    throw new Error("AUTH_WEB_ORIGIN must use HTTPS with Resend delivery");
  }

  const base = {
    webOrigin: origin.origin,
    magicLinkTtlMs: magicLinkTtlMs(),
  };
  return mode === "local"
    ? { mode, ...base }
    : {
        mode,
        ...base,
        apiKey: requiredEnvironment("RESEND_API_KEY"),
        from: requiredEnvironment("AUTH_EMAIL_FROM"),
      };
}

function acceptedResponse(): AuthInitiationResponse {
  return AuthInitiationResponseSchema.parse({ accepted: true });
}

function createOpaqueToken(): string {
  return AuthTokenSchema.parse(randomBytes(32).toString("base64url"));
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

@Injectable()
export class AuthService {
  readonly #repository: PostgresAuthRepository;
  readonly #emailConfig: AuthEmailConfig;
  readonly #sessionTtlMs: number;
  readonly #bootstrapOrganization: string | undefined;
  readonly #initiationWindows = new Map<string, InitiationWindow>();

  constructor(
    @Inject(AUTH_REPOSITORY) repository: PostgresAuthRepository,
  ) {
    this.#repository = repository;
    this.#emailConfig = authEmailConfig();
    this.#sessionTtlMs = sessionTtlMs();
    this.#bootstrapOrganization =
      process.env.LORE_WORKSPACE_ORGANIZATION?.trim() || undefined;
  }

  async signup(input: AuthSignupRequest): Promise<AuthInitiationResponse> {
    const signup = AuthSignupRequestSchema.parse(input);
    if (!this.#allowInitiation(signup.email)) {
      return acceptedResponse();
    }

    const provisioned = await this.#repository.findOrCreateSignupUser(signup, {
      ...(this.#bootstrapOrganization === undefined
        ? {}
        : { bootstrapOrganization: this.#bootstrapOrganization }),
    });
    if (!this.#canInitiate(provisioned.user)) {
      return acceptedResponse();
    }
    await this.#issueMagicLink(provisioned.user, provisioned.created);
    return acceptedResponse();
  }

  async login(input: AuthLoginRequest): Promise<AuthInitiationResponse> {
    const login = AuthLoginRequestSchema.parse(input);
    if (!this.#allowInitiation(login.email)) {
      return acceptedResponse();
    }

    const user = await this.#repository.findUserByEmail(login.email);
    if (user === null || !this.#canInitiate(user)) {
      return acceptedResponse();
    }
    await this.#issueMagicLink(user, false);
    return acceptedResponse();
  }

  async verify(input: AuthVerifyRequest): Promise<AuthVerifyResponse> {
    const verification = AuthVerifyRequestSchema.parse(input);
    const sessionToken = createOpaqueToken();
    const session = await this.#repository.verifyMagicLink({
      tokenHash: hashAuthToken(verification.token),
      sessionId: randomUUID(),
      sessionTokenHash: hashAuthToken(sessionToken),
      sessionExpiresAt: new Date(Date.now() + this.#sessionTtlMs),
    });
    if (session === null) {
      throw new UnauthorizedException("Invalid or expired magic link");
    }
    return AuthVerifyResponseSchema.parse({ sessionToken, session });
  }

  session(workspace: AuthenticatedWorkspace): AuthSessionResponse {
    return AuthSessionResponseSchema.parse({
      session: this.#requireSessionProfile(workspace),
    });
  }

  async logout(workspace: AuthenticatedWorkspace): Promise<void> {
    this.#requireSessionProfile(workspace);
    await this.#repository.revokeSession(workspace.tokenId);
  }

  #allowInitiation(email: string): boolean {
    const now = Date.now();
    const current = this.#initiationWindows.get(email);
    if (
      current === undefined ||
      now - current.startedAt >= INITIATION_WINDOW_MS
    ) {
      this.#initiationWindows.set(email, { startedAt: now, count: 1 });
      return true;
    }
    if (current.count >= INITIATION_LIMIT) {
      return false;
    }
    current.count += 1;
    return true;
  }

  #canInitiate(user: AuthUserRecord): boolean {
    return user.userStatus === "active" && user.workspaceStatus === "active";
  }

  async #issueMagicLink(
    user: AuthUserRecord,
    showConnectorOnboarding: boolean,
  ): Promise<void> {
    const token = createOpaqueToken();
    const magicLinkId = randomUUID();
    await this.#repository.issueMagicLink({
      id: magicLinkId,
      userId: user.userId,
      tokenHash: hashAuthToken(token),
      expiresAt: new Date(Date.now() + this.#emailConfig.magicLinkTtlMs),
    });

    try {
      await this.#deliverMagicLink(
        user.email,
        token,
        showConnectorOnboarding,
      );
    } catch {
      try {
        await this.#repository.revokeMagicLink(magicLinkId);
      } catch {
        // The generic response below intentionally hides both failures.
      }
      throw new ServiceUnavailableException(
        "Authentication email is temporarily unavailable",
      );
    }
  }

  async #deliverMagicLink(
    email: string,
    token: string,
    showConnectorOnboarding: boolean,
  ): Promise<void> {
    const verifyUrl = new URL("/auth/verify", this.#emailConfig.webOrigin);
    const fragment = new URLSearchParams({ token });
    if (showConnectorOnboarding) {
      fragment.set("onboarding", "connect");
    }
    verifyUrl.hash = fragment.toString();
    const link = verifyUrl.toString();
    if (this.#emailConfig.mode === "local") {
      process.stdout.write(`[Lore auth] Magic link for ${email}: ${link}\n`);
      return;
    }

    const escapedLink = htmlEscape(link);
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#emailConfig.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: this.#emailConfig.from,
        to: [email],
        subject: showConnectorOnboarding
          ? "Activate your Lore workspace"
          : "Sign in to Lore",
        text: `${showConnectorOnboarding ? "Activate your Lore workspace" : "Use this link to sign in to Lore"}:\n\n${link}\n\nThis link expires soon and can only be used once.`,
        html: `<p>${showConnectorOnboarding ? "Activate your Lore workspace" : "Use this link to sign in to Lore"}:</p><p><a href="${escapedLink}">${escapedLink}</a></p><p>This link expires soon and can only be used once.</p>`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error("Authentication email delivery failed");
    }
  }

  #requireSessionProfile(
    workspace: AuthenticatedWorkspace,
  ): AuthSessionProfile {
    if (
      workspace.credentialType !== "session" ||
      workspace.userId === undefined ||
      workspace.email === undefined ||
      workspace.workspaceName === undefined
    ) {
      throw new UnauthorizedException("An authenticated user session is required");
    }
    return AuthSessionProfileSchema.parse({
      userId: workspace.userId,
      email: workspace.email,
      workspaceId: workspace.workspaceId,
      workspaceName: workspace.workspaceName,
      organization: workspace.organization,
    });
  }
}
