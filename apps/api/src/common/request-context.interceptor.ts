import { randomUUID } from "node:crypto";
import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import type {
  WorkspaceHttpRequest,
  WorkspaceHttpResponse,
} from "./request-context.js";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function firstHeader(
  headers: WorkspaceHttpRequest["headers"],
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<WorkspaceHttpRequest>();
    const response = http.getResponse<WorkspaceHttpResponse>();
    const proposed = firstHeader(request.headers, "x-request-id")?.trim();
    const requestId =
      request.requestId ??
      (proposed !== undefined && REQUEST_ID_PATTERN.test(proposed)
        ? proposed
        : randomUUID());
    request.requestId = requestId;

    response.setHeader("x-request-id", requestId);
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("content-security-policy", "default-src 'none'");
    if ((request.originalUrl ?? request.url ?? "").startsWith("/v1/")) {
      response.setHeader("cache-control", "no-store");
    }
    return next.handle();
  }
}
