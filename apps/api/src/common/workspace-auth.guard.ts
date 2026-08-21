import { randomUUID } from "node:crypto";
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  AuthenticatedWorkspaceSchema,
  type AuthenticatedWorkspace,
} from "@lore-co/core";
import type {
  PostgresAuthRepository,
  PostgresPilotRepository,
} from "@lore-co/database";
import { IS_PUBLIC_KEY } from "./public.decorator.js";
import { AUTH_REPOSITORY, PILOT_REPOSITORY } from "./tokens.js";
import type {
  WorkspaceHttpRequest,
  WorkspaceHttpResponse,
} from "./request-context.js";
import { FixedWindowRateLimiter } from "./fixed-window-rate-limiter.js";

const RATE_WINDOW_MS = 60_000;
const MAX_RATE_WINDOWS = 10_000;

function firstHeader(
  headers: WorkspaceHttpRequest["headers"],
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function rateLimitPerMinute(): number {
  const raw = process.env.API_RATE_LIMIT_PER_MINUTE?.trim();
  if (raw === undefined || raw === "") {
    return 120;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100_000) {
    throw new Error(
      "API_RATE_LIMIT_PER_MINUTE must be an integer from 1 to 100000",
    );
  }
  return value;
}

@Injectable()
export class WorkspaceAuthGuard implements CanActivate {
  readonly #pilotRepository: PostgresPilotRepository;
  readonly #authRepository: PostgresAuthRepository;
  readonly #reflector: Reflector;
  readonly #rateLimiter = new FixedWindowRateLimiter({
    limit: rateLimitPerMinute(),
    windowMs: RATE_WINDOW_MS,
    maxKeys: MAX_RATE_WINDOWS,
  });

  constructor(
    @Inject(PILOT_REPOSITORY) pilotRepository: PostgresPilotRepository,
    @Inject(AUTH_REPOSITORY) authRepository: PostgresAuthRepository,
    reflector: Reflector,
  ) {
    this.#pilotRepository = pilotRepository;
    this.#authRepository = authRepository;
    this.#reflector = reflector;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<WorkspaceHttpRequest>();
    const response = http.getResponse<WorkspaceHttpResponse>();
    this.#initializeRequest(request, response);

    const isPublic =
      this.#reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;
    if (isPublic) {
      return true;
    }

    const authorization = firstHeader(request.headers, "authorization");
    const match =
      authorization === undefined
        ? null
        : /^Bearer ([^\s]+)$/u.exec(authorization.trim());
    if (match?.[1] === undefined) {
      response.setHeader("www-authenticate", 'Bearer realm="lore"');
      throw new UnauthorizedException("A workspace bearer token is required");
    }

    const workspaceToken =
      await this.#pilotRepository.authenticateToken(match[1]);
    let workspace: AuthenticatedWorkspace | null;
    if (workspaceToken === null) {
      workspace = await this.#authRepository.authenticateSession(match[1]);
    } else {
      workspace = AuthenticatedWorkspaceSchema.parse({
        ...workspaceToken,
        credentialType: "workspace_token",
      });
    }
    if (workspace === null) {
      response.setHeader("www-authenticate", 'Bearer realm="lore"');
      throw new UnauthorizedException("Invalid or expired bearer token");
    }
    this.#checkRateLimit(workspace.tokenId);
    request.workspace = workspace;
    return true;
  }

  #initializeRequest(
    request: WorkspaceHttpRequest,
    response: WorkspaceHttpResponse,
  ): void {
    const incoming = firstHeader(request.headers, "x-request-id")?.trim();
    const requestId =
      incoming !== undefined &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(incoming)
        ? incoming
        : randomUUID();
    request.requestId = requestId;
    response.setHeader("x-request-id", requestId);
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("content-security-policy", "default-src 'none'");
    if ((request.originalUrl ?? request.url ?? "").startsWith("/v1/")) {
      response.setHeader("cache-control", "no-store");
    }
  }

  #checkRateLimit(tokenId: string): void {
    if (this.#rateLimiter.allow(tokenId)) {
      return;
    }
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: "Too Many Requests",
        message: "Workspace request rate exceeded",
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
