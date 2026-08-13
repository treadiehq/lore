import {
  createError,
  defineEventHandler,
  getHeader,
  getMethod,
  getRequestURL,
  sendRedirect,
} from "h3";
import { getAuthToken } from "~/server/utils/auth";

const PUBLIC_PAGES = new Set(["/auth/verify", "/login", "/signup"]);

function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/health" ||
    PUBLIC_PAGES.has(pathname.replace(/\/+$/u, "") || "/") ||
    pathname === "/api/auth" ||
    pathname.startsWith("/api/auth/") ||
    pathname === "/_nuxt" ||
    pathname.startsWith("/_nuxt/")
  );
}

export default defineEventHandler((event) => {
  if (process.env.NUXT_E2E_FIXTURE === "1") {
    return;
  }
  const pathname = getRequestURL(event).pathname;
  if (isPublicPath(pathname) || getAuthToken(event) !== undefined) {
    return;
  }

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    throw createError({
      statusCode: 401,
      statusMessage: "Authentication required",
    });
  }

  const method = getMethod(event).toUpperCase();
  const accept = getHeader(event, "accept") ?? "";
  if (
    (method === "GET" || method === "HEAD") &&
    accept.toLowerCase().includes("text/html")
  ) {
    return sendRedirect(event, "/login", 302);
  }

  throw createError({
    statusCode: 401,
    statusMessage: "Authentication required",
  });
});
