const DEFAULT_LOCAL_WEB_ORIGIN = "http://localhost:3002";
const DEFAULT_MAGIC_LINK_TTL_MINUTES = 15;
const DEFAULT_PASSWORD_RESET_TTL_MINUTES = 15;
const DEFAULT_SESSION_TTL_DAYS = 30;
const DEFAULT_API_PORT = 3004;
const WORKSPACE_TOKEN_MINIMUM_LENGTH = 24;
const OWNER_BOOTSTRAP_TOKEN_BYTES = 32;

type Environment = Readonly<Record<string, string | undefined>>;

export type AuthMode = "magic_link" | "local_owner" | "disabled";

export type MagicLinkDeliveryConfig =
  | {
      mode: "local";
    }
  | {
      mode: "resend";
      apiKey: string;
      from: string;
    };

export type AuthConfig =
  | {
      mode: "disabled";
    }
  | {
      mode: "magic_link";
      webOrigin: string;
      magicLinkTtlMs: number;
      sessionTtlMs: number;
      delivery: MagicLinkDeliveryConfig;
    }
  | {
      mode: "local_owner";
      webOrigin: string;
      ownerBootstrapToken: string;
      passwordResetTtlMs: number;
      sessionTtlMs: number;
    };

export interface ApiDeploymentConfig {
  auth: AuthConfig;
  corsOrigins: string[];
  databaseUrl: string | null;
  server: {
    host: string;
    port: number;
    jsonBodyLimit: string;
  };
  workspaceBootstrap: {
    token: string;
    organization: string;
    name: string;
  } | null;
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
  reason: string,
): string {
  const value = environmentValue(environment, name);
  if (value === undefined) {
    throw new Error(`${name} is required ${reason}`);
  }
  return value;
}

function parsePort(environment: Environment): number {
  const raw =
    environmentValue(environment, "API_PORT") ??
    environmentValue(environment, "PORT");
  if (raw === undefined) {
    return DEFAULT_API_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`API_PORT must be an integer from 1 to 65535, got "${raw}"`);
  }
  return port;
}

function parseDatabaseUrl(environment: Environment): string | null {
  const value = environmentValue(environment, "DATABASE_URL");
  if (value === undefined) {
    if (environment.NODE_ENV === "production") {
      throw new Error("DATABASE_URL is required in production");
    }
    return null;
  }

  let databaseUrl: URL;
  try {
    databaseUrl = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (
    databaseUrl.protocol !== "postgres:" &&
    databaseUrl.protocol !== "postgresql:"
  ) {
    throw new Error("DATABASE_URL must use the postgres or postgresql protocol");
  }
  return value;
}

function workspaceBootstrapConfig(
  environment: Environment,
): ApiDeploymentConfig["workspaceBootstrap"] {
  const token = environmentValue(environment, "LORE_WORKSPACE_TOKEN");
  const organization = environmentValue(
    environment,
    "LORE_WORKSPACE_ORGANIZATION",
  );
  if ((token === undefined) !== (organization === undefined)) {
    throw new Error(
      "LORE_WORKSPACE_TOKEN and LORE_WORKSPACE_ORGANIZATION must be configured together",
    );
  }
  if (token === undefined || organization === undefined) {
    if (environment.NODE_ENV === "production") {
      throw new Error(
        "LORE_WORKSPACE_TOKEN and LORE_WORKSPACE_ORGANIZATION are required in production",
      );
    }
    return null;
  }
  if (token.length < WORKSPACE_TOKEN_MINIMUM_LENGTH) {
    throw new Error(
      `LORE_WORKSPACE_TOKEN must contain at least ${WORKSPACE_TOKEN_MINIMUM_LENGTH} characters`,
    );
  }
  return {
    token,
    organization,
    name: environmentValue(environment, "LORE_WORKSPACE_NAME") ?? organization,
  };
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
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(origin.hostname);
  if (requireHttps && origin.protocol !== "https:" && !loopback) {
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

function durationMs(
  environment: Environment,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
  unit: "days" | "minutes",
): number {
  const raw = environmentValue(environment, name);
  const value = raw === undefined ? defaultValue : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  const multiplier =
    unit === "days" ? 24 * 60 * 60 * 1_000 : 60 * 1_000;
  return value * multiplier;
}

function sessionTtlMs(environment: Environment): number {
  return durationMs(
    environment,
    "AUTH_SESSION_TTL_DAYS",
    DEFAULT_SESSION_TTL_DAYS,
    1,
    365,
    "days",
  );
}

function passwordResetTtlMs(environment: Environment): number {
  return durationMs(
    environment,
    "AUTH_PASSWORD_RESET_TTL_MINUTES",
    DEFAULT_PASSWORD_RESET_TTL_MINUTES,
    1,
    60,
    "minutes",
  );
}

function authMode(environment: Environment): AuthMode {
  const configured = environmentValue(environment, "AUTH_MODE");
  if (configured !== undefined) {
    if (
      configured !== "magic_link" &&
      configured !== "local_owner" &&
      configured !== "disabled"
    ) {
      throw new Error(
        'AUTH_MODE must be "magic_link", "local_owner", or "disabled"',
      );
    }
    return configured;
  }

  const legacy = environmentValue(environment, "AUTH_EMAIL_MODE");
  if (legacy === "local" || legacy === "resend") {
    return "magic_link";
  }
  if (legacy === "disabled") {
    return "disabled";
  }
  if (legacy !== undefined) {
    throw new Error(
      'AUTH_EMAIL_MODE must be "disabled", "local", or "resend"',
    );
  }
  if (environment.NODE_ENV === "production") {
    throw new Error(
      "AUTH_MODE is required in production (AUTH_EMAIL_MODE remains supported for compatibility)",
    );
  }
  return "disabled";
}

function authWebOrigin(
  environment: Environment,
  fallback: string | undefined,
  reason: string,
): string {
  const configured =
    environmentValue(environment, "AUTH_WEB_ORIGIN") ?? fallback;
  const value =
    configured ??
    requiredEnvironment(environment, "AUTH_WEB_ORIGIN", reason);
  const origin = parseOrigin(
    "AUTH_WEB_ORIGIN",
    value,
    environment.NODE_ENV === "production",
  );
  const parsed = new URL(origin);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(
    parsed.hostname,
  );
  if (parsed.protocol !== "https:" && !loopback) {
    throw new Error(
      "AUTH_WEB_ORIGIN must use HTTPS unless it is a loopback origin",
    );
  }
  return origin;
}

function ownerBootstrapToken(environment: Environment): string {
  const token = requiredEnvironment(
    environment,
    "LORE_OWNER_BOOTSTRAP_TOKEN",
    "when AUTH_MODE=local_owner",
  );
  const isBase64Url =
    /^[A-Za-z0-9_-]{43}$/u.test(token) &&
    Buffer.from(token, "base64url").byteLength === OWNER_BOOTSTRAP_TOKEN_BYTES;
  const isHex = /^[a-fA-F0-9]{64}$/u.test(token);
  if (!isBase64Url && !isHex) {
    throw new Error(
      "LORE_OWNER_BOOTSTRAP_TOKEN must be a 256-bit base64url or hexadecimal secret",
    );
  }
  if (token === environmentValue(environment, "LORE_WORKSPACE_TOKEN")) {
    throw new Error(
      "LORE_OWNER_BOOTSTRAP_TOKEN must be distinct from LORE_WORKSPACE_TOKEN",
    );
  }
  return token;
}

function magicLinkDelivery(
  environment: Environment,
): MagicLinkDeliveryConfig {
  const configured = environmentValue(environment, "AUTH_EMAIL_MODE");
  const mode = configured ?? "local";
  if (mode !== "local" && mode !== "resend") {
    throw new Error(
      'AUTH_EMAIL_MODE must be "local" or "resend" when AUTH_MODE=magic_link',
    );
  }
  if (mode === "local" && environment.NODE_ENV === "production") {
    throw new Error("AUTH_EMAIL_MODE=local is not allowed in production");
  }
  if (mode === "local") {
    return { mode };
  }
  return {
    mode,
    apiKey: requiredEnvironment(
      environment,
      "RESEND_API_KEY",
      "when AUTH_EMAIL_MODE=resend",
    ),
    from: requiredEnvironment(
      environment,
      "AUTH_EMAIL_FROM",
      "when AUTH_EMAIL_MODE=resend",
    ),
  };
}

export function apiDeploymentConfig(
  environment: Environment = process.env,
): ApiDeploymentConfig {
  const mode = authMode(environment);
  const common = {
    databaseUrl: parseDatabaseUrl(environment),
    server: {
      host: environmentValue(environment, "API_HOST") ?? "0.0.0.0",
      port: parsePort(environment),
      jsonBodyLimit:
        environmentValue(environment, "API_JSON_BODY_LIMIT") ?? "1mb",
    },
    workspaceBootstrap: workspaceBootstrapConfig(environment),
  };
  if (mode === "disabled") {
    return {
      ...common,
      auth: { mode },
      corsOrigins: parseCorsOrigins(environment, undefined),
    };
  }

  const delivery =
    mode === "magic_link" ? magicLinkDelivery(environment) : undefined;
  const webOrigin = authWebOrigin(
    environment,
    delivery?.mode === "local"
      ? DEFAULT_LOCAL_WEB_ORIGIN
      : undefined,
    `when AUTH_MODE=${mode}`,
  );
  if (environmentValue(environment, "NUXT_ORIGIN") === undefined) {
    if (
      environment.NODE_ENV === "production" ||
      mode === "local_owner" ||
      delivery?.mode === "resend"
    ) {
      throw new Error(`NUXT_ORIGIN is required when AUTH_MODE=${mode}`);
    }
  }
  const corsOrigins = parseCorsOrigins(environment, webOrigin);
  if (!corsOrigins.includes(webOrigin)) {
    throw new Error("NUXT_ORIGIN must include AUTH_WEB_ORIGIN");
  }

  if (mode === "local_owner") {
    if (common.databaseUrl === null) {
      throw new Error("DATABASE_URL is required when AUTH_MODE=local_owner");
    }
    if (common.workspaceBootstrap === null) {
      throw new Error(
        "Workspace bootstrap is required when AUTH_MODE=local_owner",
      );
    }
    return {
      ...common,
      auth: {
        mode,
        webOrigin,
        ownerBootstrapToken: ownerBootstrapToken(environment),
        passwordResetTtlMs: passwordResetTtlMs(environment),
        sessionTtlMs: sessionTtlMs(environment),
      },
      corsOrigins,
    };
  }

  if (delivery === undefined) {
    throw new Error("Magic-link delivery is not configured");
  }
  return {
    ...common,
    auth: {
      mode,
      webOrigin,
      magicLinkTtlMs: magicLinkTtlMs(environment),
      sessionTtlMs: sessionTtlMs(environment),
      delivery,
    },
    corsOrigins,
  };
}
