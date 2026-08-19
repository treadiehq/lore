import { createError, defineEventHandler } from "h3";
import {
  requestAuthApi,
  throwAuthUpstreamError,
} from "~/server/utils/auth";
import type { AuthPublicConfig } from "~/types/auth";
import { e2eAuthConfig } from "~/server/utils/e2e-fixture";

function isAuthPublicConfig(value: unknown): value is AuthPublicConfig {
  if (typeof value !== "object" || value === null || !("mode" in value)) {
    return false;
  }
  const config = value as Record<string, unknown>;
  return (
    config.mode === "disabled" ||
    config.mode === "magic_link" ||
    (config.mode === "local_owner" &&
      typeof config.bootstrapRequired === "boolean")
  );
}

export default defineEventHandler(async (event): Promise<AuthPublicConfig> => {
  if (process.env.NUXT_E2E_FIXTURE === "1") {
    return e2eAuthConfig();
  }
  let response: unknown;
  try {
    response = await requestAuthApi<unknown>(event, "/v1/auth/config", {
      method: "GET",
    });
  } catch (error) {
    throwAuthUpstreamError(error, 404, "Authentication is not available");
  }
  if (!isAuthPublicConfig(response)) {
    throw createError({
      statusCode: 502,
      statusMessage: "Authentication service returned an invalid response",
    });
  }
  return response;
});
