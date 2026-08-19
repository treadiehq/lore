#!/usr/bin/env node

import { randomUUID } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 10_000;

function usage() {
  return `Lore deployment smoke test

Usage:
  LORE_WORKSPACE_TOKEN=... node scripts/deployment-smoke.mjs --api-url <url> [options]

Options:
  --api-url <url>            Public API origin (or LORE_API_URL)
  --web-url <url>            Optional public dashboard origin (or LORE_WEB_URL)
  --expected-version <value> Require the reported server version
  --expected-revision <value> Require the reported image revision
  --write-canary             Create, read, and delete one verification learning
  --timeout-ms <ms>          Request timeout (default: 10000)
  --json                     Print machine-readable output
  --help                     Show this help

The workspace token is accepted only through LORE_WORKSPACE_TOKEN so it does not
appear in command history or process arguments.
`;
}

function normalizeOrigin(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) origin`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${name} must be an HTTP(S) origin without a path`);
  }
  return url.origin;
}

function parseArguments(argv, environment) {
  const options = {
    apiUrl: environment.LORE_API_URL?.trim(),
    webUrl: environment.LORE_WEB_URL?.trim(),
    expectedVersion: undefined,
    expectedRevision: undefined,
    writeCanary: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--") {
      continue;
    }
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(usage());
      return null;
    }
    if (flag === "--write-canary") {
      options.writeCanary = true;
      continue;
    }
    if (flag === "--json") {
      options.json = true;
      continue;
    }
    if (
      ![
        "--api-url",
        "--web-url",
        "--expected-version",
        "--expected-revision",
        "--timeout-ms",
      ].includes(flag)
    ) {
      throw new Error(`Unknown option: ${flag}\nTry: deployment-smoke --help`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    index += 1;
    if (flag === "--api-url") options.apiUrl = value;
    if (flag === "--web-url") options.webUrl = value;
    if (flag === "--expected-version") options.expectedVersion = value;
    if (flag === "--expected-revision") options.expectedRevision = value;
    if (flag === "--timeout-ms") {
      options.timeoutMs = Number(value);
      if (
        !Number.isInteger(options.timeoutMs) ||
        options.timeoutMs < 1_000 ||
        options.timeoutMs > 120_000
      ) {
        throw new Error("--timeout-ms must be an integer from 1000 to 120000");
      }
    }
  }
  if (options.apiUrl === undefined || options.apiUrl === "") {
    throw new Error("--api-url or LORE_API_URL is required");
  }
  const token = environment.LORE_WORKSPACE_TOKEN?.trim();
  if (token === undefined || token.length < 24) {
    throw new Error("LORE_WORKSPACE_TOKEN is required and must be valid");
  }
  return {
    ...options,
    apiUrl: normalizeOrigin(options.apiUrl, "API URL"),
    webUrl:
      options.webUrl === undefined || options.webUrl === ""
        ? undefined
        : normalizeOrigin(options.webUrl, "Web URL"),
    token,
  };
}

async function request(url, options, timeoutMs) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error(`Request failed: ${new URL(url).pathname}`);
  }
  return response;
}

async function json(response, expectedStatus, label) {
  if (response.status !== expectedStatus) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function run(options) {
  const checks = [];
  const auth = { authorization: `Bearer ${options.token}` };

  const liveness = await json(
    await request(`${options.apiUrl}/health`, {}, options.timeoutMs),
    200,
    "API liveness",
  );
  if (liveness.status !== "ok" || liveness.check !== "liveness") {
    throw new Error("API liveness response is incompatible");
  }
  checks.push("api_liveness");

  const readiness = await json(
    await request(`${options.apiUrl}/health/ready`, {}, options.timeoutMs),
    200,
    "API readiness",
  );
  if (readiness.status !== "ok" || readiness.check !== "readiness") {
    throw new Error("API readiness response is incompatible");
  }
  checks.push("api_readiness");

  const unauthenticated = await request(
    `${options.apiUrl}/v1/learnings?limit=1`,
    {},
    options.timeoutMs,
  );
  if (unauthenticated.status !== 401) {
    throw new Error(
      `Unauthenticated API boundary returned HTTP ${unauthenticated.status}`,
    );
  }
  checks.push("unauthenticated_rejection");

  const identity = await json(
    await request(
      `${options.apiUrl}/v1/workspace/identity`,
      { headers: auth },
      options.timeoutMs,
    ),
    200,
    "Workspace identity",
  );
  if (
    typeof identity.workspaceId !== "string" ||
    identity.credentialType !== "workspace_token" ||
    typeof identity.server?.version !== "string"
  ) {
    throw new Error("Workspace identity response is incompatible");
  }
  if (
    options.expectedVersion !== undefined &&
    identity.server.version !== options.expectedVersion
  ) {
    throw new Error(
      `Expected server version ${options.expectedVersion}, received ${identity.server.version}`,
    );
  }
  if (
    options.expectedRevision !== undefined &&
    identity.server.revision !== options.expectedRevision
  ) {
    throw new Error(
      `Expected server revision ${options.expectedRevision}, received ${identity.server.revision ?? "none"}`,
    );
  }
  checks.push("authenticated_identity");

  await json(
    await request(
      `${options.apiUrl}/v1/learnings?limit=1`,
      { headers: auth },
      options.timeoutMs,
    ),
    200,
    "Authenticated learning list",
  );
  checks.push("migrated_schema");

  if (options.webUrl !== undefined) {
    const webHealth = await json(
      await request(`${options.webUrl}/health`, {}, options.timeoutMs),
      200,
      "Web liveness",
    );
    if (webHealth.status !== "ok") {
      throw new Error("Web liveness response is incompatible");
    }
    const page = await request(
      options.webUrl,
      { headers: { accept: "text/html" } },
      options.timeoutMs,
    );
    if (
      !page.ok ||
      !page.headers.get("content-type")?.toLowerCase().includes("text/html")
    ) {
      throw new Error("Web root did not return HTML");
    }
    checks.push("web_liveness", "web_html");
  }

  let canaryId = null;
  if (options.writeCanary) {
    const marker = randomUUID();
    try {
      const created = await json(
        await request(
          `${options.apiUrl}/v1/learnings`,
          {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({
              content: `Deployment verification canary ${marker}`,
              scope: { organization: identity.organization },
              category: "other",
              source: {
                agent: "deployment-smoke",
                sessionId: marker,
                rawText: null,
                redacted: true,
              },
            }),
          },
          options.timeoutMs,
        ),
        201,
        "Canary create",
      );
      canaryId = created.memory?.id;
      if (typeof canaryId !== "string") {
        throw new Error("Canary create response is incompatible");
      }
      const fetched = await json(
        await request(
          `${options.apiUrl}/v1/learnings/${canaryId}`,
          { headers: auth },
          options.timeoutMs,
        ),
        200,
        "Canary read",
      );
      if (fetched.memory?.id !== canaryId) {
        throw new Error("Canary read returned the wrong learning");
      }
      checks.push("write_read_canary");
    } finally {
      if (canaryId !== null) {
        const removed = await request(
          `${options.apiUrl}/v1/learnings/${canaryId}`,
          { method: "DELETE", headers: auth },
          options.timeoutMs,
        );
        if (removed.status !== 200) {
          throw new Error(`Canary cleanup returned HTTP ${removed.status}`);
        }
        checks.push("canary_cleanup");
      }
    }
  }

  return {
    status: "ok",
    apiUrl: options.apiUrl,
    webUrl: options.webUrl ?? null,
    workspaceId: identity.workspaceId,
    server: identity.server,
    checks,
  };
}

try {
  const options = parseArguments(process.argv.slice(2), process.env);
  if (options !== null) {
    const result = await run(options);
    process.stdout.write(
      options.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `deployment: ok\nserver_version: ${result.server.version}\nchecks: ${result.checks.join(", ")}\n`,
    );
  }
} catch (error) {
  const message =
    error instanceof Error ? error.message : "Deployment smoke test failed";
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
}
