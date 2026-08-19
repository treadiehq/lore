import { Injectable } from "@nestjs/common";
import {
  WorkspaceIdentityResponseSchema,
  type AuthenticatedWorkspace,
  type WorkspaceIdentityResponse,
} from "@lore-co/core";
import packageMetadata from "../../package.json" with { type: "json" };

function optionalRevision(value: string | undefined): string | null {
  const revision = value?.trim();
  return revision === undefined || revision === "" ? null : revision;
}

@Injectable()
export class WorkspaceIdentityService {
  get(workspace: AuthenticatedWorkspace): WorkspaceIdentityResponse {
    return WorkspaceIdentityResponseSchema.parse({
      workspaceId: workspace.workspaceId,
      workspaceName: workspace.workspaceName ?? workspace.organization,
      organization: workspace.organization,
      credentialType: workspace.credentialType ?? "workspace_token",
      ...(workspace.role === undefined ? {} : { role: workspace.role }),
      server: {
        version:
          process.env.LORE_SERVER_VERSION?.trim() || packageMetadata.version,
        revision: optionalRevision(process.env.LORE_SERVER_REVISION),
      },
    });
  }
}
