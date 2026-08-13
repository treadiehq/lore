import {
  createError,
  deleteCookie,
  getCookie,
  getHeader,
  getRequestURL,
  setCookie,
  type H3Event,
} from "h3";
import { $fetch } from "ofetch";
import { useRuntimeConfig } from "#imports";
import type { AuthSession } from "~/types/auth";

const AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

type AuthApiMethod = "GET" | "POST";

interface AuthApiRequestOptions {
  method: AuthApiMethod;
  body?: unknown;
  token?: string;
}

function configuredCookieName(event: H3Event): string {
  const configured = String(
    useRuntimeConfig(event).authCookieName ?? "lore_session",
  ).trim();
  return COOKIE_NAME_PATTERN.test(configured) ? configured : "lore_session";
}

function configuredCookieSecure(event: H3Event): boolean {
  const value: unknown = useRuntimeConfig(event).authCookieSecure;
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.toLowerCase() === "true";
  }
  return process.env.NODE_ENV === "production";
}

function cookieOptions(event: H3Event) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: configuredCookieSecure(event),
    path: "/",
  };
}

export function getLoreApiUrl(event: H3Event): string {
  const configured = String(
    useRuntimeConfig(event).loreApiUrl ?? "http://localhost:3004",
  )
    .trim()
    .replace(/\/+$/u, "");

  try {
    const url = new URL(configured);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return configured;
    }
  } catch {
    // Invalid configuration is reported without echoing its value.
  }

  throw createError({
    statusCode: 503,
    statusMessage: "Authentication service is not configured",
  });
}

export function getAuthToken(event: H3Event): string | undefined {
  const token = getCookie(event, configuredCookieName(event))?.trim();
  return token === "" ? undefined : token;
}

export function setAuthCookie(event: H3Event, token: string): void {
  setCookie(event, configuredCookieName(event), token, {
    ...cookieOptions(event),
    maxAge: AUTH_COOKIE_MAX_AGE,
  });
}

export function clearAuthCookie(event: H3Event): void {
  deleteCookie(event, configuredCookieName(event), cookieOptions(event));
}

export function assertSameOrigin(event: H3Event): void {
  const origin = getHeader(event, "origin");
  if (origin === undefined) {
    return;
  }

  let normalizedOrigin: string;
  try {
    normalizedOrigin = new URL(origin).origin;
  } catch {
    normalizedOrigin = "";
  }

  if (normalizedOrigin !== getRequestURL(event).origin) {
    throw createError({
      statusCode: 403,
      statusMessage: "Cross-origin request rejected",
    });
  }
}

export function isStateChangingMethod(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

export async function requestAuthApi<T>(
  event: H3Event,
  path: string,
  options: AuthApiRequestOptions,
): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (options.token !== undefined) {
    headers.authorization = `Bearer ${options.token}`;
  }

  return await $fetch<T>(`${getLoreApiUrl(event)}${path}`, {
    method: options.method,
    headers,
    retry: 0,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

function upstreamStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  if ("statusCode" in error && typeof error.statusCode === "number") {
    return error.statusCode;
  }
  if ("status" in error && typeof error.status === "number") {
    return error.status;
  }
  return undefined;
}

export function throwAuthUpstreamError(
  error: unknown,
  clientStatus: number,
  clientMessage: string,
): never {
  const status = upstreamStatus(error);
  throw createError({
    statusCode:
      status !== undefined && status >= 400 && status < 500
        ? clientStatus
        : 502,
    statusMessage:
      status !== undefined && status >= 400 && status < 500
        ? clientMessage
        : "Authentication service is temporarily unavailable",
  });
}

export function isAuthSession(value: unknown): value is AuthSession {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const session = value as Record<string, unknown>;
  return (
    typeof session.userId === "string" &&
    typeof session.email === "string" &&
    typeof session.workspaceId === "string" &&
    typeof session.workspaceName === "string" &&
    typeof session.organization === "string"
  );
}
