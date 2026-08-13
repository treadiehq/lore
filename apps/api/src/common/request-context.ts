import {
  InternalServerErrorException,
} from "@nestjs/common";
import type { AuthenticatedWorkspace } from "@lore-co/core";

export interface WorkspaceHttpRequest {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  originalUrl?: string;
  url?: string;
  requestId?: string;
  workspace?: AuthenticatedWorkspace;
}

export interface WorkspaceHttpResponse {
  setHeader(name: string, value: string): void;
}

export function requireRequestId(request: WorkspaceHttpRequest): string {
  if (request.requestId === undefined) {
    throw new InternalServerErrorException("Request ID was not initialized");
  }
  return request.requestId;
}

export function requireWorkspace(
  request: WorkspaceHttpRequest,
): AuthenticatedWorkspace {
  if (request.workspace === undefined) {
    throw new InternalServerErrorException(
      "Workspace authentication was not initialized",
    );
  }
  return request.workspace;
}
