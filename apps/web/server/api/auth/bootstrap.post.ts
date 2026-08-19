import { createError, defineEventHandler, readBody } from "h3";
import {
  assertSameOrigin,
  isAuthSession,
  requestAuthApi,
  setAuthCookie,
  throwAuthUpstreamError,
} from "~/server/utils/auth";
import type { AuthSessionResponse } from "~/types/auth";
import {
  claimE2eOwner,
  e2eSession,
} from "~/server/utils/e2e-fixture";

interface BootstrapApiResponse {
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
  const email = typeof input.email === "string" ? input.email.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  const bootstrapToken =
    typeof input.bootstrapToken === "string" ? input.bootstrapToken.trim() : "";
  if (
    email === "" ||
    email.length > 320 ||
    password.length < 12 ||
    password.length > 1_024 ||
    bootstrapToken.length < 43 ||
    bootstrapToken.length > 128
  ) {
    throw createError({
      statusCode: 400,
      statusMessage: "Invalid owner setup request",
    });
  }
  if (process.env.NUXT_E2E_FIXTURE === "1") {
    if (bootstrapToken !== "b".repeat(64)) {
      throw createError({
        statusCode: 401,
        statusMessage: "Owner setup is unavailable",
      });
    }
    claimE2eOwner();
    setAuthCookie(event, "e2e-local-owner-session", e2eSession.expiresAt);
    return { session: e2eSession };
  }

  let response: BootstrapApiResponse;
  try {
    response = await requestAuthApi<BootstrapApiResponse>(
      event,
      "/v1/auth/local-owner/bootstrap",
      {
        method: "POST",
        body: { email, password },
        bootstrapToken,
      },
    );
  } catch (error) {
    throwAuthUpstreamError(error, 401, "Owner setup is unavailable");
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
