import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const servers: Array<ReturnType<typeof createServer>> = [];
const token = "lore_abcdefghijklmnopqrstuvwxyz0123456789ABCDE";

async function fixture(): Promise<{
  origin: string;
  methods: string[];
}> {
  const methods: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    const authenticated = request.headers.authorization === `Bearer ${token}`;
    methods.push(`${request.method} ${url.pathname}`);

    response.setHeader("content-type", "application/json");
    if (url.pathname === "/health") {
      response.end(JSON.stringify({ status: "ok", check: "liveness" }));
      return;
    }
    if (url.pathname === "/health/ready") {
      response.end(JSON.stringify({ status: "ok", check: "readiness" }));
      return;
    }
    if (!authenticated && url.pathname.startsWith("/v1/")) {
      response.statusCode = 401;
      response.end(JSON.stringify({ message: "Unauthorized" }));
      return;
    }
    if (url.pathname === "/v1/workspace/identity") {
      response.end(
        JSON.stringify({
          workspaceId: "00000000-0000-4000-8000-000000000001",
          workspaceName: "Smoke",
          organization: "smoke",
          credentialType: "workspace_token",
          server: { version: "0.1.5", revision: "fixture" },
        }),
      );
      return;
    }
    if (url.pathname === "/v1/learnings" && request.method === "GET") {
      response.end(
        JSON.stringify({ memories: [], total: 0, limit: 1, offset: 0 }),
      );
      return;
    }
    if (url.pathname === "/v1/learnings" && request.method === "POST") {
      response.statusCode = 201;
      response.end(
        JSON.stringify({
          memory: { id: "00000000-0000-4000-8000-000000000002" },
          inserted: true,
        }),
      );
      return;
    }
    if (
      url.pathname ===
      "/v1/learnings/00000000-0000-4000-8000-000000000002"
    ) {
      if (request.method === "DELETE") {
        response.end(JSON.stringify({ forgotten: true }));
        return;
      }
      response.end(
        JSON.stringify({
          memory: { id: "00000000-0000-4000-8000-000000000002" },
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: "Not found" }));
  });
  servers.push(server);
  await new Promise<void>((resolvePromise) =>
    server.listen(0, "127.0.0.1", resolvePromise),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fixture server did not bind");
  }
  return { origin: `http://127.0.0.1:${address.port}`, methods };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolvePromise, reject) =>
          server.close((error) =>
            error === undefined ? resolvePromise() : reject(error),
          ),
        ),
    ),
  );
});

describe("deployment smoke script", () => {
  it("checks health, authentication, schema, and release identity", async () => {
    const { origin } = await fixture();
    const result = await execute(
      process.execPath,
      [
        resolve("scripts/deployment-smoke.mjs"),
        "--api-url",
        origin,
        "--expected-version",
        "0.1.5",
        "--expected-revision",
        "fixture",
        "--json",
      ],
      {
        env: { ...process.env, LORE_WORKSPACE_TOKEN: token },
      },
    );

    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "ok",
      server: { version: "0.1.5", revision: "fixture" },
      checks: [
        "api_liveness",
        "api_readiness",
        "unauthenticated_rejection",
        "authenticated_identity",
        "migrated_schema",
      ],
    });
  });

  it("cleans up a write/read deployment canary", async () => {
    const { origin, methods } = await fixture();
    await execute(
      process.execPath,
      [
        resolve("scripts/deployment-smoke.mjs"),
        "--api-url",
        origin,
        "--write-canary",
      ],
      {
        env: { ...process.env, LORE_WORKSPACE_TOKEN: token },
      },
    );

    expect(methods).toContain("POST /v1/learnings");
    expect(methods).toContain(
      "GET /v1/learnings/00000000-0000-4000-8000-000000000002",
    );
    expect(methods).toContain(
      "DELETE /v1/learnings/00000000-0000-4000-8000-000000000002",
    );
  });
});
