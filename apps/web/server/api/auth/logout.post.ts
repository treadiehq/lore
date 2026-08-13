import { defineEventHandler, setResponseStatus } from "h3";
import {
  assertSameOrigin,
  clearAuthCookie,
  getAuthToken,
  requestAuthApi,
  throwAuthUpstreamError,
} from "~/server/utils/auth";

export default defineEventHandler(async (event): Promise<void> => {
  assertSameOrigin(event);
  const token = getAuthToken(event);
  let revokeFailed = false;

  try {
    if (token !== undefined) {
      await requestAuthApi(event, "/v1/auth/logout", {
        method: "POST",
        token,
      });
    }
  } catch {
    revokeFailed = true;
  } finally {
    clearAuthCookie(event);
  }

  if (revokeFailed) {
    throwAuthUpstreamError(
      new Error("Session revocation failed"),
      401,
      "Unable to sign out",
    );
  }

  setResponseStatus(event, 204);
});
