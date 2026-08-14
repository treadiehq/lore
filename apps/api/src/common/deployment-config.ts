const DEFAULT_LOCAL_WEB_ORIGIN = "http://localhost:3002";
const DEFAULT_MAGIC_LINK_TTL_MINUTES = 15;

type Environment = Readonly<Record<string, string | undefined>>;

export type AuthEmailConfig =
  | {
      mode: "disabled";
    }
  | {
      mode: "local";
      webOrigin: string;
      magicLinkTtlMs: number;
    }
  | {
      mode: "resend";
      webOrigin: string;
      magicLinkTtlMs: number;
      apiKey: string;
      from: string;
    };

export interface ApiDeploymentConfig {
  auth: AuthEmailConfig;
  corsOrigins: string[];
}

function environmentValue(
  environment: Environment,
  name: string,
): string | undefined {
  const value = environment[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function requiredEnvironment(
  environment: Environment,
  name: string,
): string {
  const value = environmentValue(environment, name);
  if (value === undefined) {
    throw new Error(`${name} is required when AUTH_EMAIL_MODE=resend`);
  }
  return value;
}

function parseOrigin(name: string, value: string, requireHttps: boolean): string {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error(`${name} must contain valid HTTP(S) origins`);
  }
  if (
    (origin.protocol !== "http:" && origin.protocol !== "https:") ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new Error(`${name} must contain HTTP(S) origins without paths`);
  }
  if (requireHttps && origin.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS in production`);
  }
  return origin.origin;
}

function parseCorsOrigins(
  environment: Environment,
  defaultOrigin: string | undefined,
): string[] {
  const configured = environmentValue(environment, "NUXT_ORIGIN");
  const values =
    configured === undefined
      ? defaultOrigin === undefined
        ? []
        : [defaultOrigin]
      : configured
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean);
  if (values.length === 0 && configured !== undefined) {
    throw new Error("NUXT_ORIGIN must contain at least one origin");
  }
  return [
    ...new Set(
      values.map((origin) =>
        parseOrigin(
          "NUXT_ORIGIN",
          origin,
          environment.NODE_ENV === "production",
        ),
      ),
    ),
  ];
}

function magicLinkTtlMs(environment: Environment): number {
  const raw = environmentValue(environment, "AUTH_MAGIC_LINK_TTL_MINUTES");
  if (raw === undefined) {
    return DEFAULT_MAGIC_LINK_TTL_MINUTES * 60 * 1_000;
  }
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1_440) {
    throw new Error(
      "AUTH_MAGIC_LINK_TTL_MINUTES must be an integer from 1 to 1440",
    );
  }
  return minutes * 60 * 1_000;
}

export function apiDeploymentConfig(
  environment: Environment = process.env,
): ApiDeploymentConfig {
  const mode = environmentValue(environment, "AUTH_EMAIL_MODE") ?? "disabled";
  if (mode !== "disabled" && mode !== "local" && mode !== "resend") {
    throw new Error(
      'AUTH_EMAIL_MODE must be "disabled", "local", or "resend"',
    );
  }
  if (mode === "local" && environment.NODE_ENV === "production") {
    throw new Error("AUTH_EMAIL_MODE=local is not allowed in production");
  }
  if (mode === "disabled") {
    return {
      auth: { mode },
      corsOrigins: parseCorsOrigins(environment, undefined),
    };
  }

  const configuredWebOrigin = environmentValue(environment, "AUTH_WEB_ORIGIN");
  const webOrigin = parseOrigin(
    "AUTH_WEB_ORIGIN",
    configuredWebOrigin ??
      (mode === "local"
        ? DEFAULT_LOCAL_WEB_ORIGIN
        : requiredEnvironment(environment, "AUTH_WEB_ORIGIN")),
    mode === "resend" || environment.NODE_ENV === "production",
  );
  if (
    mode === "resend" &&
    environmentValue(environment, "NUXT_ORIGIN") === undefined
  ) {
    throw new Error("NUXT_ORIGIN is required when AUTH_EMAIL_MODE=resend");
  }
  const corsOrigins = parseCorsOrigins(environment, webOrigin);
  if (!corsOrigins.includes(webOrigin)) {
    throw new Error("NUXT_ORIGIN must include AUTH_WEB_ORIGIN");
  }

  const base = {
    webOrigin,
    magicLinkTtlMs: magicLinkTtlMs(environment),
  };
  return {
    auth:
      mode === "local"
        ? { mode, ...base }
        : {
            mode,
            ...base,
            apiKey: requiredEnvironment(environment, "RESEND_API_KEY"),
            from: requiredEnvironment(environment, "AUTH_EMAIL_FROM"),
          },
    corsOrigins,
  };
}
