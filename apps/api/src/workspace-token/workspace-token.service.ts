import { randomBytes } from "node:crypto";
import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  CreateWorkspaceTokenRequestSchema,
  CreateWorkspaceTokenResponseSchema,
  ListWorkspaceTokensResponseSchema,
  RevokeWorkspaceTokenResponseSchema,
  WorkspaceTokenSecretSchema,
  type AuthenticatedWorkspace,
  type CreateWorkspaceTokenRequest,
  type CreateWorkspaceTokenResponse,
  type ListWorkspaceTokensResponse,
  type RevokeWorkspaceTokenResponse,
} from "@lore-co/core";
import type { PostgresPilotRepository } from "@lore-co/database";
import { PILOT_REPOSITORY } from "../common/tokens.js";

function requireDashboardSession(
  workspace: AuthenticatedWorkspace,
): AuthenticatedWorkspace & { credentialType: "session"; userId: string } {
  if (
    workspace.credentialType !== "session" ||
    workspace.userId === undefined
  ) {
    throw new ForbiddenException(
      "A dashboard session is required to manage workspace tokens",
    );
  }
  return workspace as AuthenticatedWorkspace & {
    credentialType: "session";
    userId: string;
  };
}

function createWorkspaceTokenSecret(): string {
  return WorkspaceTokenSecretSchema.parse(
    `lore_${randomBytes(32).toString("base64url")}`,
  );
}

@Injectable()
export class WorkspaceTokenService {
  readonly #repository: PostgresPilotRepository;

  constructor(
    @Inject(PILOT_REPOSITORY) repository: PostgresPilotRepository,
  ) {
    this.#repository = repository;
  }

  async list(
    authenticated: AuthenticatedWorkspace,
  ): Promise<ListWorkspaceTokensResponse> {
    const workspace = requireDashboardSession(authenticated);
    const tokens = await this.#repository.listWorkspaceTokens(
      workspace.workspaceId,
    );
    return ListWorkspaceTokensResponseSchema.parse({ tokens });
  }

  async create(
    authenticated: AuthenticatedWorkspace,
    input: CreateWorkspaceTokenRequest,
  ): Promise<CreateWorkspaceTokenResponse> {
    const workspace = requireDashboardSession(authenticated);
    const request = CreateWorkspaceTokenRequestSchema.parse(input);
    const token = createWorkspaceTokenSecret();
    const expiresAt =
      request.expiresInDays === undefined
        ? undefined
        : new Date(
            Date.now() + request.expiresInDays * 24 * 60 * 60 * 1_000,
          );
    const workspaceToken = await this.#repository.createWorkspaceToken({
      workspaceId: workspace.workspaceId,
      name: request.name,
      token,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    return CreateWorkspaceTokenResponseSchema.parse({
      token,
      workspaceToken,
    });
  }

  async revoke(
    authenticated: AuthenticatedWorkspace,
    tokenId: string,
  ): Promise<RevokeWorkspaceTokenResponse> {
    const workspace = requireDashboardSession(authenticated);
    const workspaceToken = await this.#repository.revokeWorkspaceToken(
      workspace.workspaceId,
      tokenId,
    );
    if (workspaceToken === null) {
      throw new NotFoundException("Active workspace token not found");
    }
    return RevokeWorkspaceTokenResponseSchema.parse({ workspaceToken });
  }
}
