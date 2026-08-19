import { createError, defineEventHandler, readBody } from "h3";
import {
  assertSameOrigin,
  isAuthSession,
  requestAuthApi,
  setAuthCookie,
  throwAuthUpstreamError,
} from "~/server/utils/auth";
import type { AuthSessionResponse } from "~/types/auth";
import { e2eSession } from "~/server/utils/e2e-fixture";

interface ResetApiResponse {
  sessionToken: string;
  session: unknown;
}

export default defineEventHandler(async (event): Promise<AuthSessionResponse> => {
  assertSameOrigin(event);
  const body = await readBody<unknown>(event);
  const input =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : {};
  const token = typeof input.token === "string" ? input.token.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (
    !/^[A-Za-z0-9_-]{43}$/u.test(token) ||
    password.length < 12 ||
    password.length > 1_024
  ) {
    throw createError({
      statusCode: 400,
      statusMessage: "Invalid password reset request",
    });
  }
  if (process.env.NUXT_E2E_FIXTURE === "1") {
    if (token !== "r".repeat(43)) {
      throw createError({
        statusCode: 401,
        statusMessage: "Password reset is invalid or expired",
      });
    }
    setAuthCookie(event, "e2e-local-owner-session", e2eSession.expiresAt);
    return { session: e2eSession };
  }

  let response: ResetApiResponse;
  try {
    response = await requestAuthApi<ResetApiResponse>(
      event,
      "/v1/auth/password/reset",
      {
        method: "POST",
        body: { token, password },
      },
    );
  } catch (error) {
    throwAuthUpstreamError(error, 401, "Password reset is invalid or expired");
  }
  if (
    typeof response?.sessionToken !== "string" ||
    !isAuthSession(response.session)
  ) {
    throw createError({
      statusCode: 502,
      statusMessage: "Authentication service returned an invalid response",
    });
  }
  setAuthCookie(event, response.sessionToken, response.session.expiresAt);
  return { session: response.session };
});
