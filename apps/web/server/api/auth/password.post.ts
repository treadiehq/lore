import { createError, defineEventHandler, readBody } from "h3";
import {
  assertSameOrigin,
  getAuthToken,
  requestAuthApi,
  throwAuthUpstreamError,
} from "~/server/utils/auth";
import type { PasswordChangeResponse } from "~/types/auth";

export default defineEventHandler(async (
  event,
): Promise<PasswordChangeResponse> => {
  assertSameOrigin(event);
  const token = getAuthToken(event);
  if (token === undefined) {
    throw createError({
      statusCode: 401,
      statusMessage: "Authentication required",
    });
  }
  const body = await readBody<unknown>(event);
  const input =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : {};
  const currentPassword =
    typeof input.currentPassword === "string" ? input.currentPassword : "";
  const newPassword =
    typeof input.newPassword === "string" ? input.newPassword : "";
  if (
    currentPassword.length < 12 ||
    currentPassword.length > 1_024 ||
    newPassword.length < 12 ||
    newPassword.length > 1_024 ||
    currentPassword === newPassword
  ) {
    throw createError({
      statusCode: 400,
      statusMessage: "Invalid password change request",
    });
  }
  try {
    return await requestAuthApi<PasswordChangeResponse>(
      event,
      "/v1/auth/password/change",
      {
        method: "POST",
        token,
        body: { currentPassword, newPassword },
      },
    );
  } catch (error) {
    throwAuthUpstreamError(error, 401, "Current password is invalid");
  }
});
