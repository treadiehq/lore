import {
  createError,
  defineEventHandler,
  readBody,
  setResponseStatus,
} from "h3";
import {
  assertSameOrigin,
  isAuthSession,
  requestAuthApi,
  setAuthCookie,
  throwAuthUpstreamError,
} from "~/server/utils/auth";
import type {
  AuthMessageResponse,
  AuthPublicConfig,
  AuthSessionResponse,
} from "~/types/auth";
import { e2eSession } from "~/server/utils/e2e-fixture";

interface PasswordLoginApiResponse {
  sessionToken: string;
  session: unknown;
}

export default defineEventHandler(async (
  event,
): Promise<AuthMessageResponse | AuthSessionResponse> => {
  assertSameOrigin(event);
  const body = await readBody<unknown>(event);
  const input =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : {};
  const email = typeof input.email === "string" ? input.email.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";

  if (email === "" || email.length > 320) {
    throw createError({
      statusCode: 400,
      statusMessage: "Invalid login request",
    });
  }
  if (process.env.NUXT_E2E_FIXTURE === "1") {
    if (
      email !== "owner@example.com" ||
      password !== "correct horse battery staple"
    ) {
      throw createError({
        statusCode: 401,
        statusMessage: "Invalid email or password",
      });
    }
    setAuthCookie(event, "e2e-local-owner-session", e2eSession.expiresAt);
    return { session: e2eSession };
  }

  let config: AuthPublicConfig;
  try {
    config = await requestAuthApi<AuthPublicConfig>(event, "/v1/auth/config", {
      method: "GET",
    });
  } catch (error) {
    throwAuthUpstreamError(error, 404, "Authentication is not available");
  }
  if (config.mode === "disabled") {
    throw createError({
      statusCode: 404,
      statusMessage: "Authentication is not available",
    });
  }

  if (config.mode === "local_owner") {
    if (password.length < 12 || password.length > 1_024) {
      throw createError({
        statusCode: 400,
        statusMessage: "Invalid login request",
      });
    }
    let response: PasswordLoginApiResponse;
    try {
      response = await requestAuthApi<PasswordLoginApiResponse>(
        event,
        "/v1/auth/password/login",
        {
          method: "POST",
          body: { email, password },
        },
      );
    } catch (error) {
      throwAuthUpstreamError(error, 401, "Invalid email or password");
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
  }

  try {
    await requestAuthApi(event, "/v1/auth/login", {
      method: "POST",
      body: { email },
    });
  } catch (error) {
    throwAuthUpstreamError(error, 400, "Unable to start sign in");
  }

  setResponseStatus(event, 202);
  return {
    message:
      "If the request can be completed, a sign-in link will arrive shortly.",
  };
});
