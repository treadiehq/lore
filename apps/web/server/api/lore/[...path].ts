import {
  createError,
  defineEventHandler,
  getHeader,
  getMethod,
  getRequestURL,
  getRouterParam,
  readRawBody,
  sendProxy,
} from "h3";
import {
  assertSameOrigin,
  getAuthToken,
  getLoreApiUrl,
  isStateChangingMethod,
} from "~/server/utils/auth";
import { handleE2eLoreRequest } from "~/server/utils/e2e-fixture";

const BODY_METHODS = new Set(["DELETE", "PATCH", "POST", "PUT"]);
const SAFE_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "if-match",
  "if-none-match",
] as const;

export default defineEventHandler(async (event) => {
  const method = getMethod(event).toUpperCase();
  if (isStateChangingMethod(method)) {
    assertSameOrigin(event);
  }

  const path = (getRouterParam(event, "path") ?? "").replace(/^\/+/u, "");
  if (path === "" || !path.startsWith("v1/")) {
    throw createError({
      statusCode: 404,
      statusMessage: "Lore API route not found",
    });
  }
  if (process.env.NUXT_E2E_FIXTURE === "1") {
    return await handleE2eLoreRequest(event, path, method);
  }

  const token = getAuthToken(event);
  if (token === undefined) {
    throw createError({
      statusCode: 401,
      statusMessage: "Authentication required",
    });
  }

  const requestUrl = getRequestURL(event);
  const target = new URL(path, `${getLoreApiUrl(event)}/`);
  target.search = requestUrl.search;
  const headers: Record<string, string> = {};
  for (const name of SAFE_REQUEST_HEADERS) {
    const value = getHeader(event, name);
    if (value !== undefined) {
      headers[name] = value;
    }
  }
  headers.authorization = `Bearer ${token}`;

  const body = BODY_METHODS.has(method)
    ? await readRawBody(event)
    : undefined;

  return sendProxy(event, target.toString(), {
    fetchOptions: {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    },
    onResponse: () => {
      event.node.res.removeHeader("set-cookie");
      event.node.res.removeHeader("www-authenticate");
      event.node.res.removeHeader("access-control-allow-credentials");
      event.node.res.removeHeader("access-control-allow-origin");
    },
  });
});
