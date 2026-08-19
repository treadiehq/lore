import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { WorkspaceHttpRequest } from "./request-context.js";

@Injectable()
export class SessionAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<WorkspaceHttpRequest>();
    if (
      request.workspace?.credentialType !== "session" ||
      request.workspace.userId === undefined
    ) {
      throw new UnauthorizedException(
        "An authenticated user session is required",
      );
    }
    return true;
  }
}
