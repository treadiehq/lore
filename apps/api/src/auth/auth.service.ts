import { randomBytes, randomUUID } from "node:crypto";
import {
  Inject,
  Injectable,
  NotFoundException,
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
import {
  apiDeploymentConfig,
  type AuthEmailConfig,
} from "../common/deployment-config.js";
import { AUTH_REPOSITORY } from "../common/tokens.js";

const INITIATION_LIMIT = 5;
const INITIATION_WINDOW_MS = 15 * 60 * 1_000;
const DEFAULT_SESSION_TTL_DAYS = 30;

interface InitiationWindow {
  startedAt: number;
  count: number;
}

type EnabledAuthEmailConfig = Exclude<AuthEmailConfig, { mode: "disabled" }>;

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
    this.#emailConfig = apiDeploymentConfig().auth;
    this.#sessionTtlMs = sessionTtlMs();
    this.#bootstrapOrganization =
      process.env.LORE_WORKSPACE_ORGANIZATION?.trim() || undefined;
  }

  assertEnabled(): void {
    this.#enabledEmailConfig();
  }

  #enabledEmailConfig(): EnabledAuthEmailConfig {
    if (this.#emailConfig.mode === "disabled") {
      throw new NotFoundException("Not Found");
    }
    return this.#emailConfig;
  }

  async signup(input: AuthSignupRequest): Promise<AuthInitiationResponse> {
    this.assertEnabled();
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
    this.assertEnabled();
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
    this.assertEnabled();
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
    this.assertEnabled();
    return AuthSessionResponseSchema.parse({
      session: this.#requireSessionProfile(workspace),
    });
  }

  async logout(workspace: AuthenticatedWorkspace): Promise<void> {
    this.assertEnabled();
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
    const emailConfig = this.#enabledEmailConfig();
    const token = createOpaqueToken();
    const magicLinkId = randomUUID();
    await this.#repository.issueMagicLink({
      id: magicLinkId,
      userId: user.userId,
      tokenHash: hashAuthToken(token),
      expiresAt: new Date(Date.now() + emailConfig.magicLinkTtlMs),
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
    const emailConfig = this.#enabledEmailConfig();
    const verifyUrl = new URL("/auth/verify", emailConfig.webOrigin);
    const fragment = new URLSearchParams({ token });
    if (showConnectorOnboarding) {
      fragment.set("onboarding", "connect");
    }
    verifyUrl.hash = fragment.toString();
    const link = verifyUrl.toString();
    if (emailConfig.mode === "local") {
      process.stdout.write(`[Lore auth] Magic link for ${email}: ${link}\n`);
      return;
    }

    const escapedLink = htmlEscape(link);
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${emailConfig.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: emailConfig.from,
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
