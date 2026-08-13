import {
  createError,
  defineEventHandler,
  readBody,
  setResponseStatus,
} from "h3";
import {
  assertSameOrigin,
  requestAuthApi,
  throwAuthUpstreamError,
} from "~/server/utils/auth";
import type { AuthMessageResponse } from "~/types/auth";

export default defineEventHandler(async (event): Promise<AuthMessageResponse> => {
  assertSameOrigin(event);
  const body = await readBody<unknown>(event);
  const input =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : {};
  const organizationName =
    typeof input.organizationName === "string"
      ? input.organizationName.trim()
      : "";
  const email = typeof input.email === "string" ? input.email.trim() : "";

  if (
    organizationName === "" ||
    organizationName.length > 200 ||
    email === "" ||
    email.length > 320
  ) {
    throw createError({
      statusCode: 400,
      statusMessage: "Invalid signup request",
    });
  }

  try {
    await requestAuthApi(event, "/v1/auth/signup", {
      method: "POST",
      body: { organizationName, email },
    });
  } catch (error) {
    throwAuthUpstreamError(error, 400, "Unable to start signup");
  }

  setResponseStatus(event, 202);
  return {
    message:
      "If the request can be completed, a sign-in link will arrive shortly.",
  };
});
