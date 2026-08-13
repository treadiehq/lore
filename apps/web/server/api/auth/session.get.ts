import { createError, defineEventHandler } from "h3";
import {
  getAuthToken,
  isAuthSession,
  requestAuthApi,
  throwAuthUpstreamError,
} from "~/server/utils/auth";
import type { AuthSessionResponse } from "~/types/auth";
import { e2eSession } from "~/server/utils/e2e-fixture";

interface SessionApiResponse {
  session: unknown;
}

export default defineEventHandler(async (event): Promise<AuthSessionResponse> => {
  if (process.env.NUXT_E2E_FIXTURE === "1") {
    return { session: e2eSession };
  }
  const token = getAuthToken(event);
  if (token === undefined) {
    throw createError({
      statusCode: 401,
      statusMessage: "Authentication required",
    });
  }

  let response: SessionApiResponse;
  try {
    response = await requestAuthApi<SessionApiResponse>(
      event,
      "/v1/auth/session",
      {
        method: "GET",
        token,
      },
    );
  } catch (error) {
    throwAuthUpstreamError(error, 401, "Authentication required");
  }

  if (!isAuthSession(response?.session)) {
    throw createError({
      statusCode: 502,
      statusMessage: "Authentication service returned an invalid response",
    });
  }

  return { session: response.session };
});
