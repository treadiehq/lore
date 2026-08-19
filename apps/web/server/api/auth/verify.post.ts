import { createError, defineEventHandler, readBody } from "h3";
import {
  assertSameOrigin,
  isAuthSession,
  requestAuthApi,
  setAuthCookie,
  throwAuthUpstreamError,
} from "~/server/utils/auth";
import type { AuthSessionResponse } from "~/types/auth";

interface VerifyApiResponse {
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

  if (token === "" || token.length > 4096) {
    throw createError({
      statusCode: 400,
      statusMessage: "Invalid verification request",
    });
  }

  let response: VerifyApiResponse;
  try {
    response = await requestAuthApi<VerifyApiResponse>(
      event,
      "/v1/auth/verify",
      {
        method: "POST",
        body: { token },
      },
    );
  } catch (error) {
    throwAuthUpstreamError(
      error,
      401,
      "This sign-in link is invalid or expired",
    );
  }

  if (
    typeof response?.sessionToken !== "string" ||
    response.sessionToken.trim() === "" ||
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
