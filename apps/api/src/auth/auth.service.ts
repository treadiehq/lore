import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import {
  AuthInitiationResponseSchema,
  AuthLoginRequestSchema,
  AuthPublicConfigResponseSchema,
  AuthSessionProfileSchema,
  AuthSessionResponseSchema,
  AuthSignupRequestSchema,
  AuthTokenSchema,
  AuthenticatedSessionResponseSchema,
  AuthVerifyRequestSchema,
  LocalOwnerBootstrapClaimRequestSchema,
  LocalOwnerLoginRequestSchema,
  PasswordChangeRequestSchema,
  PasswordChangeResponseSchema,
  PasswordResetConsumeRequestSchema,
  type AuthenticatedSessionResponse,
  type AuthenticatedWorkspace,
  type AuthInitiationResponse,
  type AuthLoginRequest,
  type AuthPublicConfigResponse,
  type AuthSessionProfile,
  type AuthSessionResponse,
  type AuthSignupRequest,
  type AuthVerifyRequest,
  type AuthVerifyResponse,
  type LocalOwnerBootstrapClaimRequest,
  type LocalOwnerLoginRequest,
  type PasswordChangeRequest,
  type PasswordChangeResponse,
  type PasswordResetConsumeRequest,
} from "@lore-co/core";
import {
  hashAuthToken,
  type AuthUserRecord,
  type PostgresAuthRepository,
} from "@lore-co/database";
import { hash, verify } from "@node-rs/argon2";
import {
  apiDeploymentConfig,
  type AuthConfig,
} from "../common/deployment-config.js";
import { AUTH_REPOSITORY } from "../common/tokens.js";

const INITIATION_LIMIT = 5;
const AUTH_ATTEMPT_LIMIT = 5;
const AUTH_ATTEMPT_WINDOW_MS = 15 * 60 * 1_000;
const MAX_RATE_WINDOWS = 10_000;
const ARGON2_OPTIONS = {
  algorithm: 2,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
} as const;

interface RateWindow {
  startedAt: number;
  count: number;
}

type MagicLinkConfig = Extract<AuthConfig, { mode: "magic_link" }>;
type LocalOwnerConfig = Extract<AuthConfig, { mode: "local_owner" }>;

function acceptedResponse(): AuthInitiationResponse {
  return AuthInitiationResponseSchema.parse({ accepted: true });
}

export function createOpaqueAuthToken(): string {
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

function secretMatches(candidate: string, expected: string): boolean {
  const candidateHash = createHash("sha256").update(candidate, "utf8").digest();
  const expectedHash = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

@Injectable()
export class AuthService {
  readonly #repository: PostgresAuthRepository;
  readonly #config: AuthConfig;
  readonly #bootstrapOrganization: string | undefined;
  readonly #rateWindows = new Map<string, RateWindow>();

  constructor(
    @Inject(AUTH_REPOSITORY) repository: PostgresAuthRepository,
  ) {
    this.#repository = repository;
    const deployment = apiDeploymentConfig();
    this.#config = deployment.auth;
    this.#bootstrapOrganization =
      deployment.workspaceBootstrap?.organization;
  }

  assertEnabled(): void {
    if (this.#config.mode === "disabled") {
      throw new NotFoundException("Not Found");
    }
  }

  async publicConfig(): Promise<AuthPublicConfigResponse> {
    if (this.#config.mode !== "local_owner") {
      return AuthPublicConfigResponseSchema.parse({ mode: this.#config.mode });
    }
    return AuthPublicConfigResponseSchema.parse({
      mode: this.#config.mode,
      bootstrapRequired: await this.#repository.isOwnerBootstrapRequired(
        this.#requiredBootstrapOrganization(),
      ),
    });
  }

  async signup(input: AuthSignupRequest): Promise<AuthInitiationResponse> {
    const config = this.#magicLinkConfig();
    const signup = AuthSignupRequestSchema.parse(input);
    if (!this.#allowAttempt(`magic:${signup.email}`, INITIATION_LIMIT)) {
      return acceptedResponse();
    }

    const provisioned = await this.#repository.findOrCreateSignupUser(signup, {
      ...(this.#bootstrapOrganization === undefined
        ? {}
        : { bootstrapOrganization: this.#bootstrapOrganization }),
    });
    if (!this.#canAuthenticate(provisioned.user)) {
      return acceptedResponse();
    }
    await this.#issueMagicLink(config, provisioned.user, provisioned.created);
    return acceptedResponse();
  }

  async login(input: AuthLoginRequest): Promise<AuthInitiationResponse> {
    const config = this.#magicLinkConfig();
    const login = AuthLoginRequestSchema.parse(input);
    if (!this.#allowAttempt(`magic:${login.email}`, INITIATION_LIMIT)) {
      return acceptedResponse();
    }

    const user = await this.#repository.findUserByEmail(login.email);
    if (user === null || !this.#canAuthenticate(user)) {
      return acceptedResponse();
    }
    await this.#issueMagicLink(config, user, false);
    return acceptedResponse();
  }

  async verify(input: AuthVerifyRequest): Promise<AuthVerifyResponse> {
    const config = this.#magicLinkConfig();
    const verification = AuthVerifyRequestSchema.parse(input);
    const authenticated = await this.#verifyMagicLink(
      verification.token,
      config.sessionTtlMs,
    );
    if (authenticated === null) {
      throw new UnauthorizedException("Invalid or expired magic link");
    }
    return authenticated;
  }

  async claimLocalOwner(
    input: LocalOwnerBootstrapClaimRequest,
    bootstrapToken: string,
    clientKey: string,
  ): Promise<AuthenticatedSessionResponse> {
    const config = this.#localOwnerConfig();
    const claim = LocalOwnerBootstrapClaimRequestSchema.parse(input);
    if (
      !this.#allowAttempt(`bootstrap-client:${clientKey}`) ||
      !this.#allowAttempt("bootstrap-global", AUTH_ATTEMPT_LIMIT * 4) ||
      !secretMatches(bootstrapToken, config.ownerBootstrapToken)
    ) {
      throw new UnauthorizedException("Bootstrap claim is unavailable");
    }

    const passwordHash = await this.#hashPassword(claim.password);
    const session = this.#newSession(config.sessionTtlMs);
    const profile = await this.#repository.claimFirstOwner({
      organization: this.#requiredBootstrapOrganization(),
      email: claim.email,
      passwordHash,
      ...session.repositoryInput,
    });
    if (profile === null) {
      throw new UnauthorizedException("Bootstrap claim is unavailable");
    }
    return AuthenticatedSessionResponseSchema.parse({
      sessionToken: session.token,
      session: profile,
    });
  }

  async passwordLogin(
    input: LocalOwnerLoginRequest,
    clientKey: string,
  ): Promise<AuthenticatedSessionResponse> {
    const config = this.#localOwnerConfig();
    const login = LocalOwnerLoginRequestSchema.parse(input);
    if (!this.#allowAttempt(`password:${clientKey}:${login.email}`)) {
      throw new HttpException(
        "Too many authentication attempts",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const user = await this.#repository.findUserByEmail(login.email);
    let passwordMatches = false;
    if (user?.passwordHash === null || user === null) {
      await this.#hashPassword(login.password);
    } else {
      passwordMatches = await this.#verifyPassword(
        user.passwordHash,
        login.password,
      );
    }
    const valid =
      user !== null &&
      user.organization === this.#requiredBootstrapOrganization() &&
      this.#canAuthenticate(user) &&
      passwordMatches;
    if (!valid || user === null) {
      throw new UnauthorizedException("Invalid email or password");
    }

    const session = this.#newSession(config.sessionTtlMs);
    const profile = await this.#repository.createSessionForUser({
      userId: user.userId,
      ...session.repositoryInput,
    });
    if (profile === null) {
      throw new UnauthorizedException("Invalid email or password");
    }
    return AuthenticatedSessionResponseSchema.parse({
      sessionToken: session.token,
      session: profile,
    });
  }

  async consumePasswordReset(
    input: PasswordResetConsumeRequest,
    clientKey: string,
  ): Promise<AuthenticatedSessionResponse> {
    const config = this.#localOwnerConfig();
    const reset = PasswordResetConsumeRequestSchema.parse(input);
    if (!this.#allowAttempt(`reset:${clientKey}`)) {
      throw new HttpException(
        "Too many authentication attempts",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const passwordHash = await this.#hashPassword(reset.password);
    const session = this.#newSession(config.sessionTtlMs);
    const profile = await this.#repository.consumePasswordReset({
      tokenHash: hashAuthToken(reset.token),
      passwordHash,
      ...session.repositoryInput,
    });
    if (profile === null) {
      throw new UnauthorizedException("Invalid or expired password reset");
    }
    return AuthenticatedSessionResponseSchema.parse({
      sessionToken: session.token,
      session: profile,
    });
  }

  async changePassword(
    workspace: AuthenticatedWorkspace,
    input: PasswordChangeRequest,
  ): Promise<PasswordChangeResponse> {
    this.#localOwnerConfig();
    const request = PasswordChangeRequestSchema.parse(input);
    const profile = this.#requireSessionProfile(workspace);
    if (
      profile.role !== "owner" ||
      profile.organization !== this.#requiredBootstrapOrganization()
    ) {
      throw new UnauthorizedException("An owner session is required");
    }
    const user = await this.#repository.findUserByEmail(profile.email);
    if (
      user === null ||
      user.userId !== profile.userId ||
      user.workspaceId !== profile.workspaceId ||
      user.passwordHash === null ||
      !(await this.#verifyPassword(user.passwordHash, request.currentPassword))
    ) {
      throw new UnauthorizedException("Current password is invalid");
    }
    const changed = await this.#repository.changeOwnerPassword({
      userId: profile.userId,
      workspaceId: profile.workspaceId,
      sessionId: workspace.tokenId,
      currentPasswordHash: user.passwordHash,
      newPasswordHash: await this.#hashPassword(request.newPassword),
    });
    if (!changed) {
      throw new UnauthorizedException("Current password is invalid");
    }
    return PasswordChangeResponseSchema.parse({ changed: true });
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

  #magicLinkConfig(): MagicLinkConfig {
    if (this.#config.mode === "disabled") {
      throw new NotFoundException("Not Found");
    }
    if (this.#config.mode !== "magic_link") {
      throw new NotFoundException("Not Found");
    }
    return this.#config;
  }

  #localOwnerConfig(): LocalOwnerConfig {
    if (this.#config.mode !== "local_owner") {
      throw new NotFoundException("Not Found");
    }
    return this.#config;
  }

  #requiredBootstrapOrganization(): string {
    if (this.#bootstrapOrganization === undefined) {
      throw new ServiceUnavailableException(
        "Owner bootstrap is not configured",
      );
    }
    return this.#bootstrapOrganization;
  }

  #allowAttempt(key: string, limit = AUTH_ATTEMPT_LIMIT): boolean {
    const now = Date.now();
    const current = this.#rateWindows.get(key);
    if (
      current === undefined ||
      now - current.startedAt >= AUTH_ATTEMPT_WINDOW_MS
    ) {
      if (current === undefined && this.#rateWindows.size >= MAX_RATE_WINDOWS) {
        for (const [windowKey, window] of this.#rateWindows) {
          if (now - window.startedAt >= AUTH_ATTEMPT_WINDOW_MS) {
            this.#rateWindows.delete(windowKey);
          }
        }
        if (this.#rateWindows.size >= MAX_RATE_WINDOWS) {
          const oldestKey = this.#rateWindows.keys().next().value as
            | string
            | undefined;
          if (oldestKey !== undefined) {
            this.#rateWindows.delete(oldestKey);
          }
        }
      }
      this.#rateWindows.set(key, { startedAt: now, count: 1 });
      return true;
    }
    if (current.count >= limit) {
      return false;
    }
    current.count += 1;
    return true;
  }

  #canAuthenticate(user: AuthUserRecord): boolean {
    return user.userStatus === "active" && user.workspaceStatus === "active";
  }

  #newSession(sessionTtlMs: number): {
    token: string;
    repositoryInput: {
      sessionId: string;
      sessionTokenHash: string;
      sessionExpiresAt: Date;
    };
  } {
    const token = createOpaqueAuthToken();
    return {
      token,
      repositoryInput: {
        sessionId: randomUUID(),
        sessionTokenHash: hashAuthToken(token),
        sessionExpiresAt: new Date(Date.now() + sessionTtlMs),
      },
    };
  }

  async #verifyMagicLink(
    token: string,
    sessionTtlMs: number,
  ): Promise<AuthVerifyResponse | null> {
    const session = this.#newSession(sessionTtlMs);
    const profile = await this.#repository.verifyMagicLink({
      tokenHash: hashAuthToken(token),
      ...session.repositoryInput,
    });
    return profile === null
      ? null
      : AuthenticatedSessionResponseSchema.parse({
          sessionToken: session.token,
          session: profile,
        });
  }

  async #hashPassword(password: string): Promise<string> {
    return await hash(password, ARGON2_OPTIONS);
  }

  async #verifyPassword(
    passwordHash: string,
    password: string,
  ): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  async #issueMagicLink(
    config: MagicLinkConfig,
    user: AuthUserRecord,
    showConnectorOnboarding: boolean,
  ): Promise<void> {
    const token = createOpaqueAuthToken();
    const magicLinkId = randomUUID();
    await this.#repository.issueMagicLink({
      id: magicLinkId,
      userId: user.userId,
      tokenHash: hashAuthToken(token),
      expiresAt: new Date(Date.now() + config.magicLinkTtlMs),
    });

    try {
      await this.#deliverMagicLink(
        config,
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
    config: MagicLinkConfig,
    email: string,
    token: string,
    showConnectorOnboarding: boolean,
  ): Promise<void> {
    const verifyUrl = new URL("/auth/verify", config.webOrigin);
    const fragment = new URLSearchParams({ token });
    if (showConnectorOnboarding) {
      fragment.set("onboarding", "connect");
    }
    verifyUrl.hash = fragment.toString();
    const link = verifyUrl.toString();
    if (config.delivery.mode === "local") {
      process.stdout.write(`[Lore auth] Magic link for ${email}: ${link}\n`);
      return;
    }

    const escapedLink = htmlEscape(link);
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.delivery.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: config.delivery.from,
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
      workspace.workspaceName === undefined ||
      workspace.role === undefined ||
      workspace.sessionExpiresAt === undefined
    ) {
      throw new UnauthorizedException(
        "An authenticated user session is required",
      );
    }
    return AuthSessionProfileSchema.parse({
      userId: workspace.userId,
      email: workspace.email,
      workspaceId: workspace.workspaceId,
      workspaceName: workspace.workspaceName,
      organization: workspace.organization,
      role: workspace.role,
      expiresAt: workspace.sessionExpiresAt,
    });
  }
}
