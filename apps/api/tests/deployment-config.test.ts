import { describe, expect, it } from "vitest";
import { apiDeploymentConfig } from "../src/common/deployment-config.js";

const PRODUCTION_ENVIRONMENT = {
  NODE_ENV: "production",
  AUTH_MODE: "disabled",
  AUTH_EMAIL_MODE: "disabled",
  DATABASE_URL: "postgresql://lore:secret@postgres:5432/lore",
  LORE_WORKSPACE_TOKEN: "0123456789abcdefghijklmn",
  LORE_WORKSPACE_ORGANIZATION: "example",
} as const;

describe("api deployment config", () => {
  it("keeps development defaults compatible", () => {
    expect(apiDeploymentConfig({})).toMatchObject({
      auth: { mode: "disabled" },
      corsOrigins: [],
      databaseUrl: null,
      server: {
        host: "0.0.0.0",
        port: 3004,
        jsonBodyLimit: "1mb",
      },
      workspaceBootstrap: null,
    });
  });

  it("normalizes the container server configuration", () => {
    expect(
      apiDeploymentConfig({
        API_HOST: " 127.0.0.1 ",
        API_PORT: "3001",
        API_JSON_BODY_LIMIT: "2mb",
      }).server,
    ).toEqual({
      host: "127.0.0.1",
      port: 3001,
      jsonBodyLimit: "2mb",
    });
  });

  it("rejects invalid API ports", () => {
    expect(() => apiDeploymentConfig({ API_PORT: "0" })).toThrow(
      "API_PORT must be an integer",
    );
  });

  it("requires an explicit production auth mode", () => {
    expect(() =>
      apiDeploymentConfig({
        ...PRODUCTION_ENVIRONMENT,
        AUTH_MODE: undefined,
        AUTH_EMAIL_MODE: undefined,
      }),
    ).toThrow("AUTH_MODE is required in production");
  });

  it("requires the database and workspace bootstrap in production", () => {
    expect(() =>
      apiDeploymentConfig({
        ...PRODUCTION_ENVIRONMENT,
        DATABASE_URL: undefined,
      }),
    ).toThrow("DATABASE_URL is required in production");
    expect(() =>
      apiDeploymentConfig({
        ...PRODUCTION_ENVIRONMENT,
        LORE_WORKSPACE_TOKEN: undefined,
        LORE_WORKSPACE_ORGANIZATION: undefined,
      }),
    ).toThrow(
      "LORE_WORKSPACE_TOKEN and LORE_WORKSPACE_ORGANIZATION are required",
    );
  });

  it("accepts a complete headless production configuration", () => {
    expect(apiDeploymentConfig(PRODUCTION_ENVIRONMENT)).toMatchObject({
      auth: { mode: "disabled" },
      databaseUrl: PRODUCTION_ENVIRONMENT.DATABASE_URL,
      workspaceBootstrap: {
        token: PRODUCTION_ENVIRONMENT.LORE_WORKSPACE_TOKEN,
        organization: "example",
        name: "example",
      },
    });
  });

  it("requires HTTPS browser origins in production", () => {
    expect(() =>
      apiDeploymentConfig({
        ...PRODUCTION_ENVIRONMENT,
        NUXT_ORIGIN: "http://lore.example.com",
      }),
    ).toThrow("NUXT_ORIGIN must use HTTPS in production");
  });

  it("allows loopback HTTP origins for one-command self-hosting", () => {
    expect(
      apiDeploymentConfig({
        ...PRODUCTION_ENVIRONMENT,
        AUTH_MODE: "local_owner",
        AUTH_WEB_ORIGIN: "http://localhost:3000",
        NUXT_ORIGIN: "http://localhost:3000",
        LORE_OWNER_BOOTSTRAP_TOKEN: "b".repeat(64),
      }),
    ).toMatchObject({
      auth: {
        mode: "local_owner",
        webOrigin: "http://localhost:3000",
      },
      corsOrigins: ["http://localhost:3000"],
    });
  });

  it("maps legacy email modes to magic-link auth", () => {
    expect(
      apiDeploymentConfig({
        AUTH_EMAIL_MODE: "local",
        AUTH_WEB_ORIGIN: "http://localhost:3002",
      }),
    ).toMatchObject({
      auth: {
        mode: "magic_link",
        delivery: { mode: "local" },
      },
    });
  });

  it("accepts complete secure local-owner production configuration", () => {
    expect(
      apiDeploymentConfig({
        ...PRODUCTION_ENVIRONMENT,
        AUTH_MODE: "local_owner",
        AUTH_WEB_ORIGIN: "https://lore.example.com",
        NUXT_ORIGIN: "https://lore.example.com",
        LORE_OWNER_BOOTSTRAP_TOKEN: "b".repeat(64),
      }),
    ).toMatchObject({
      auth: {
        mode: "local_owner",
        webOrigin: "https://lore.example.com",
        ownerBootstrapToken: "b".repeat(64),
      },
    });
  });

  it("requires a distinct 256-bit local-owner bootstrap secret", () => {
    expect(() =>
      apiDeploymentConfig({
        ...PRODUCTION_ENVIRONMENT,
        AUTH_MODE: "local_owner",
        AUTH_WEB_ORIGIN: "https://lore.example.com",
        NUXT_ORIGIN: "https://lore.example.com",
        LORE_OWNER_BOOTSTRAP_TOKEN: "short",
      }),
    ).toThrow("must be a 256-bit");
    expect(() =>
      apiDeploymentConfig({
        ...PRODUCTION_ENVIRONMENT,
        AUTH_MODE: "local_owner",
        AUTH_WEB_ORIGIN: "https://lore.example.com",
        NUXT_ORIGIN: "https://lore.example.com",
        LORE_WORKSPACE_TOKEN: "b".repeat(64),
        LORE_OWNER_BOOTSTRAP_TOKEN: "b".repeat(64),
      }),
    ).toThrow("must be distinct");
  });
});
