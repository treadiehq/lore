import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { WorkspaceHttpRequest } from "./request-context.js";

@Injectable()
export class OwnerAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<WorkspaceHttpRequest>();
    if (request.workspace === undefined) {
      throw new UnauthorizedException(
        "An authenticated user session is required",
      );
    }
    if (
      request.workspace.credentialType !== "session" ||
      request.workspace.userId === undefined
    ) {
      throw new ForbiddenException("Workspace owner access is required");
    }
    if (request.workspace.role !== "owner") {
      throw new ForbiddenException("Workspace owner access is required");
    }
    return true;
  }
}
