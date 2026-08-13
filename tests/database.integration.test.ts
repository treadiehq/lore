import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { promisify } from "node:util";
import {
  closeDatabase,
  createDatabase,
  PostgresMemoryRepository,
  PostgresPilotRepository,
  type DatabaseConnection,
} from "@lore-co/database";
import { SharedMemoryEngine } from "@lore-co/core";
import { HeuristicMemoryExtractor } from "@lore-co/extractor";
import { ScopedKeywordMemoryRetriever } from "@lore-co/retrieval";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

const run = promisify(execFile);
const explicitUrl = process.env.TEST_DATABASE_URL?.trim();
const databaseTestsEnabled =
  process.env.RUN_DATABASE_TESTS === "1" ||
  (explicitUrl !== undefined && explicitUrl !== "");
const databaseUrl =
  explicitUrl || "postgres://postgres:postgres@127.0.0.1:5433/lore_test";

function assertSafeTestDatabase(value: string): void {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error(
      "Database integration tests only run against localhost or loopback",
    );
  }
  const database = url.pathname.replace(/^\/+/u, "");
  if (!database.endsWith("_test")) {
    throw new Error(
      `Database integration tests require a database ending in "_test", got "${database}"`,
    );
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port =
    address !== null && typeof address === "object" ? address.port : null;
  server.close();
  await once(server, "close");
  if (port === null) {
    throw new Error("Could not reserve an API test port");
  }
  return port;
}

describe.skipIf(!databaseTestsEnabled)(
  "PostgresMemoryRepository integration",
  () => {
    let connection: DatabaseConnection;

    beforeAll(async () => {
      assertSafeTestDatabase(databaseUrl);
      await run(
        "pnpm",
        ["--filter", "@lore-co/database", "run", "db:migrate"],
        {
          cwd: new URL("..", import.meta.url),
          env: { ...process.env, DATABASE_URL: databaseUrl },
        },
      );
      connection = createDatabase(databaseUrl, { maxConnections: 1 });
    }, 30_000);

    beforeEach(async () => {
      await connection.client`
        TRUNCATE TABLE
          memory_provenance,
          connector_events,
          workspace_tokens,
          workspaces,
          memories
        CASCADE
      `;
    });

    afterAll(async () => {
      if (connection !== undefined) {
        await closeDatabase(connection);
      }
    });

    it("applies the migration and preserves repository idempotency, provenance, and superseding", async () => {
      const table = await connection.client`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'memories'
      `;
      expect(table).toHaveLength(1);

      const repository = new PostgresMemoryRepository(connection);
      const engine = new SharedMemoryEngine({
        repository,
        extractor: new HeuristicMemoryExtractor(),
        retriever: new ScopedKeywordMemoryRetriever(repository),
      });
      const interaction = {
        agent: "claude",
        repo: "payments",
        sessionId: "postgres-session",
        messages: [
          {
            role: "user" as const,
            id: "postgres-message",
            content:
              "Never call Stripe directly from API handlers. Use BillingService.",
          },
        ],
      };

      const first = await engine.observe(interaction);
      const duplicate = await engine.observe(interaction);
      expect(first).toMatchObject({ created: 1, duplicates: 0 });
      expect(first.memories[0]?.source).toMatchObject({
        agent: "claude",
        sessionId: "postgres-session",
        messageId: "postgres-message",
      });
      expect(duplicate).toMatchObject({ created: 0, duplicates: 1 });

      const correction = await engine.correct({
        memoryId: first.memories[0]!.id,
        content:
          "Stripe access from API handlers must go through BillingGateway.",
        source: { agent: "human", sessionId: "postgres-correction" },
      });
      expect(correction.memory.supersedesMemoryId).toBe(first.memories[0]!.id);
      expect(correction.supersededMemory.status).toBe("superseded");

      const context = await engine.getContext({
        agent: "codex",
        repo: "payments",
        task: "Review Stripe API handler access",
        symbols: ["BillingGateway"],
      });
      expect(context.memories.map((memory) => memory.id)).toEqual([
        correction.memory.id,
      ]);

      const manualInput = {
        content: "Integration tests belong under the integration directory.",
        scope: {
          repo: "payments",
          path: "integration",
          component: "testing",
        },
        category: "convention" as const,
        source: { agent: "human", sessionId: "postgres-manual" },
      };
      const manual = await engine.remember(manualInput);
      await engine.forget(manual.memory.id);
      const relearned = await engine.remember(manualInput);
      expect(relearned.inserted).toBe(true);
      expect(relearned.memory.id).not.toBe(manual.memory.id);
      expect(relearned.memory.scope).toMatchObject({
        path: "integration",
        component: "testing",
      });
    });

    it("stores pgvector embeddings and prevents semantic cross-workspace retrieval", async () => {
      const extension = await connection.client`
        SELECT extname FROM pg_extension WHERE extname = 'vector'
      `;
      expect(extension).toHaveLength(1);
      const firstWorkspace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const secondWorkspace = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      await connection.client`
        INSERT INTO workspaces (id, slug, organization, name)
        VALUES
          (${firstWorkspace}, 'semantic-a', 'semantic-a', 'Semantic A'),
          (${secondWorkspace}, 'semantic-b', 'semantic-b', 'Semantic B')
        ON CONFLICT (id) DO NOTHING
      `;
      const repository = new PostgresMemoryRepository(connection);
      const engine = new SharedMemoryEngine({
        repository,
        extractor: new HeuristicMemoryExtractor(),
        retriever: new ScopedKeywordMemoryRetriever(repository),
      });
      const remembered = await engine.remember({
        content: "Settlements complete asynchronously in a background worker.",
        scope: { organization: "semantic-a", repo: "billing" },
        source: { agent: "human", workspaceId: firstWorkspace },
      });
      const embedding = Array(1_536).fill(0.25) as number[];
      await repository.upsertEmbedding({
        memory: remembered.memory,
        model: "integration-embedding",
        embedding,
      });

      await expect(
        repository.search({
          workspaceId: firstWorkspace,
          scope: { organization: "semantic-a", repo: "billing" },
          embedding,
          model: "integration-embedding",
          limit: 10,
          minimumSimilarity: 0.65,
        }),
      ).resolves.toMatchObject([{ id: remembered.memory.id }]);
      await expect(
        repository.search({
          workspaceId: secondWorkspace,
          scope: { organization: "semantic-a", repo: "billing" },
          embedding,
          model: "integration-embedding",
          limit: 10,
          minimumSimilarity: 0.65,
        }),
      ).resolves.toEqual([]);
    });

    it("inspects complete tenant-safe provenance and both lineage directions", async () => {
      const pilot = new PostgresPilotRepository(connection);
      const firstWorkspace = await pilot.ensureWorkspaceToken({
        organization: "inspection-a",
        token: "inspection-workspace-token-00000001",
      });
      const secondWorkspace = await pilot.ensureWorkspaceToken({
        organization: "inspection-b",
        token: "inspection-workspace-token-00000002",
      });
      const observation = {
        connector: "lore-cli",
        eventId: "inspection-event-1",
        agent: "codex",
        sessionId: "inspection-session",
        learningScope: {},
        messages: [
          {
            role: "user" as const,
            id: "inspection-message",
            content: "Use AccountStore for all account writes.",
          },
        ],
        occurredAt: "2026-08-13T12:00:00.000Z",
      };
      const recorded = await pilot.recordObservationEvent({
        workspaceId: firstWorkspace.workspaceId,
        requestId: "inspection-request",
        observation,
        payload: { request: observation },
        redacted: false,
      });
      const sourceMessage = observation.messages[0];
      if (sourceMessage === undefined) {
        throw new Error("Inspection fixture requires a source message");
      }
      const repository = new PostgresMemoryRepository(connection);
      const engine = new SharedMemoryEngine({
        repository,
        extractor: new HeuristicMemoryExtractor(),
        retriever: new ScopedKeywordMemoryRetriever(repository),
      });
      const original = await engine.remember({
        content: sourceMessage.content,
        scope: { organization: "inspection-a", repo: "accounts" },
        category: "convention",
        source: {
          agent: "codex",
          sessionId: observation.sessionId,
          messageId: sourceMessage.id,
          rawText: sourceMessage.content,
          workspaceId: firstWorkspace.workspaceId,
          eventId: recorded.event.id,
        },
      });
      const middle = await engine.correct({
        memoryId: original.memory.id,
        content: "Use BillingAccountStore for all account writes.",
        scope: {
          organization: "inspection-a",
          repo: "accounts",
          component: "billing",
        },
        source: {
          agent: "human",
          sessionId: "inspection-dashboard",
          workspaceId: firstWorkspace.workspaceId,
          eventId: recorded.event.id,
        },
      });
      await pilot.recordProvenance({
        workspaceId: firstWorkspace.workspaceId,
        eventId: recorded.event.id,
        memory: middle.memory,
        messageRole: "user",
        sourceMessageId: sourceMessage.id,
        excerpt: sourceMessage.content,
        redacted: false,
        metadata: { connector: observation.connector },
      });
      const latest = await engine.correct({
        memoryId: middle.memory.id,
        content: "Use AccountWriteStore for all account writes.",
        source: {
          agent: "human",
          sessionId: "inspection-dashboard",
          workspaceId: firstWorkspace.workspaceId,
        },
      });

      await expect(
        pilot.inspectLearning({
          workspaceId: firstWorkspace.workspaceId,
          learningId: middle.memory.id,
        }),
      ).resolves.toMatchObject({
        learning: { id: middle.memory.id, status: "superseded" },
        sourceEvent: {
          id: recorded.event.id,
          connector: "lore-cli",
          externalEventId: observation.eventId,
        },
        provenance: [
          {
            record: {
              memoryId: middle.memory.id,
              sourceMessageId: sourceMessage.id,
            },
            event: { id: recorded.event.id, type: "observation" },
          },
        ],
        predecessor: { id: original.memory.id },
        successor: { id: latest.memory.id },
      });
      await expect(
        pilot.inspectLearning({
          workspaceId: secondWorkspace.workspaceId,
          learningId: middle.memory.id,
        }),
      ).resolves.toBeNull();
    });
  },
);

describe.skipIf(!databaseTestsEnabled)(
  "authenticated paired-turn API integration",
  () => {
    let administration: DatabaseConnection;
    let apiProcess: ChildProcess;
    let baseUrl: string;
    let apiOutput = "";
    const token = "integration-workspace-token-00000001";

    beforeAll(async () => {
      assertSafeTestDatabase(databaseUrl);
      await run(
        "pnpm",
        ["--filter", "@lore-co/database", "run", "db:migrate"],
        {
          cwd: new URL("..", import.meta.url),
          env: { ...process.env, DATABASE_URL: databaseUrl },
        },
      );
      await run("pnpm", ["--filter", "@lore-co/api", "build"], {
        cwd: new URL("..", import.meta.url),
        env: process.env,
      });
      administration = createDatabase(databaseUrl, { maxConnections: 1 });
    }, 30_000);

    beforeEach(async () => {
      await administration.client`
        TRUNCATE TABLE
          auth_sessions,
          auth_magic_links,
          auth_users,
          delivery_receipts,
          memory_provenance,
          connector_events,
          idempotency_records,
          workspace_tokens,
          workspaces,
          memories
        CASCADE
      `;
      const port = await availablePort();
      baseUrl = `http://127.0.0.1:${port}`;
      apiOutput = "";
      apiProcess = spawn(process.execPath, ["apps/api/dist/main.js"], {
        cwd: new URL("..", import.meta.url),
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          API_HOST: "127.0.0.1",
          API_PORT: String(port),
          LORE_WORKSPACE_TOKEN: token,
          LORE_WORKSPACE_ORGANIZATION: "integration",
          AUTH_EMAIL_MODE: "local",
          AUTH_WEB_ORIGIN: "http://localhost:3002",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let lastError = "";
      apiProcess.stderr?.on("data", (chunk: Buffer) => {
        lastError += chunk.toString();
      });
      apiProcess.stdout?.on("data", (chunk: Buffer) => {
        apiOutput += chunk.toString();
      });
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (apiProcess.exitCode !== null) {
          throw new Error(`API exited during startup: ${lastError}`);
        }
        try {
          const health = await fetch(`${baseUrl}/health`);
          if (health.ok) {
            return;
          }
        } catch {
          // The listener is not ready yet.
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      throw new Error(`API did not become ready: ${lastError}`);
    });

    afterEach(async () => {
      if (apiProcess !== undefined && apiProcess.exitCode === null) {
        apiProcess.kill("SIGTERM");
        await once(apiProcess, "exit");
      }
    });

    afterAll(async () => {
      if (administration !== undefined) {
        await closeDatabase(administration);
      }
    });

    it("authenticates, redacts, reconciles, delivers, records activity, and replays", async () => {
      const health = await fetch(`${baseUrl}/health/ready`);
      expect(health.status).toBe(200);
      const unauthorized = await fetch(`${baseUrl}/v1/context`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: "claude",
          repo: "accounts",
          task: "Use AccountStore",
        }),
      });
      expect(unauthorized.status).toBe(401);

      const observationRequest = {
        connector: "lore-cli",
        eventId: "claude:session-0:prompt-1",
        agent: "claude",
        sessionId: "session-0",
        scope: { repo: "accounts" },
        task: "Implement account persistence",
        messages: [
          {
            role: "user",
            id: "prompt-message-1",
            content:
              "Always use AccountStore for account writes. password=super-secret-value",
          },
        ],
        occurredAt: "2026-08-13T12:00:00.000Z",
      };
      const sendObservation = (body: unknown) =>
        fetch(`${baseUrl}/v1/observations`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
      const firstObservation = await sendObservation(observationRequest);
      expect(firstObservation.status).toBe(200);
      expect(
        (await firstObservation.json()) as {
          replayed: boolean;
          event: { type: string };
        },
      ).toMatchObject({
        replayed: false,
        event: { type: "observation" },
      });
      const replayedObservation = await sendObservation(observationRequest);
      expect(replayedObservation.status).toBe(200);
      expect(
        (await replayedObservation.json()) as { replayed: boolean },
      ).toMatchObject({ replayed: true });
      const conflictingObservation = await sendObservation({
        ...observationRequest,
        task: "A changed request",
      });
      expect(conflictingObservation.status).toBe(409);

      const request = {
        connector: "lore-cli",
        eventId: "codex:session-1:prompt-2",
        agent: "codex",
        sessionId: "session-1",
        previousAssistant: {
          content: "Call RepositoryFactory from this handler.",
        },
        currentUser: {
          content:
            "No, RepositoryFactory is deprecated. Use AccountStore instead. api_key=super-secret-value",
        },
        repo: "accounts",
        task: "Fix account persistence with AccountStore",
      };
      const sendTurn = (body: unknown) =>
        fetch(`${baseUrl}/v1/turns`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "idempotency-key": request.eventId,
          },
          body: JSON.stringify(body),
        });
      const first = await sendTurn(request);
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as {
        replayed: boolean;
        observation: { created: number };
        context: {
          text: string;
          packing: { usage: { estimatedTokens: number } };
        };
        receipt: { id: string; packing: unknown };
      };
      expect(firstBody.replayed).toBe(false);
      expect(firstBody.observation.created).toBeGreaterThan(0);
      expect(firstBody.context.text).toContain("AccountStore");
      expect(firstBody.context.packing.usage.estimatedTokens).toBeGreaterThan(0);
      expect(firstBody.receipt.id).toBeTruthy();
      expect(firstBody.receipt.packing).not.toBeNull();

      const replay = await sendTurn(request);
      expect(replay.status).toBe(200);
      expect((await replay.json()) as { replayed: boolean }).toMatchObject({
        replayed: true,
      });
      const conflict = await sendTurn({
        ...request,
        currentUser: { content: "Always use a different store." },
      });
      expect(conflict.status).toBe(409);

      const context = await fetch(`${baseUrl}/v1/context/deliveries`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          connector: "lore-cli",
          eventId: "claude:session-1:context-1",
          sessionId: "session-1",
          task: {
            agent: "claude",
            repo: "accounts",
            task: "Implement account persistence with AccountStore",
          },
        }),
      });
      expect(context.status).toBe(200);
      const contextBody = (await context.json()) as {
        context: string;
        packing: { includedMemoryIds: string[] };
        event: { type: string };
      };
      expect(contextBody.context).toContain("AccountStore");
      expect(contextBody.packing.includedMemoryIds).not.toHaveLength(0);
      expect(contextBody.event.type).toBe("context_delivery");

      const activity = await fetch(`${baseUrl}/v1/activity`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(activity.status).toBe(200);
      const activityBody = (await activity.json()) as {
        total: number;
        limit: number;
        offset: number;
        hasMore: boolean;
        activities: Array<{ receipt: unknown }>;
      };
      expect(activityBody.total).toBe(3);
      expect(activityBody).toMatchObject({
        limit: 50,
        offset: 0,
        hasMore: false,
      });
      expect(
        activityBody.activities.filter((item) => item.receipt !== null),
      ).toHaveLength(2);

      const filteredActivity = await fetch(
        `${baseUrl}/v1/activity?type=observation&agent=claude&connector=lore-cli&limit=1&offset=0`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(filteredActivity.status).toBe(200);
      expect(
        (await filteredActivity.json()) as {
          total: number;
          limit: number;
          offset: number;
          activities: Array<{ event: { type: string } }>;
        },
      ).toMatchObject({
        total: 1,
        limit: 1,
        offset: 0,
        activities: [{ event: { type: "observation" } }],
      });

      const persisted = await administration.client`
        SELECT payload::text AS payload
        FROM connector_events
        LIMIT 1
      `;
      expect(String(persisted[0]?.payload)).not.toContain(
        "super-secret-value",
      );
      const provenance = await administration.client`
        SELECT
          mp.source_message_id,
          mp.excerpt,
          mp.confidence,
          mp.confirmation
        FROM memory_provenance mp
        INNER JOIN connector_events ce ON ce.id = mp.event_id
        WHERE ce.type = 'observation'
      `;
      expect(provenance[0]).toMatchObject({
        source_message_id: "prompt-message-1",
      });
      expect(String(provenance[0]?.excerpt)).not.toContain(
        "super-secret-value",
      );
    });

    it("serves authenticated tenant-isolated inspection with provenance and lineage", async () => {
      const headers = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      };
      const observation = await fetch(`${baseUrl}/v1/observations`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          connector: "lore-cli",
          eventId: "inspection-api-event",
          agent: "codex",
          sessionId: "inspection-api-session",
          messages: [
            {
              role: "user",
              id: "inspection-api-message",
              content: "Always use AccountStore for account writes.",
            },
          ],
          occurredAt: "2026-08-13T12:00:00.000Z",
        }),
      });
      expect(observation.status).toBe(200);
      const observationBody = (await observation.json()) as {
        memories: Array<{ id: string; scope: { organization?: string } }>;
      };
      const original = observationBody.memories[0];
      expect(original).toBeDefined();

      const correction = await fetch(
        `${baseUrl}/v1/learnings/${original!.id}/corrections`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            content: "Always use BillingAccountStore for account writes.",
            category: "correction",
            scope: {
              organization: "client-supplied-organization",
              repo: "accounts",
              component: "billing",
            },
            source: {
              agent: "human",
              sessionId: "dashboard-correction",
              rawText: "Corrected in the inspection dashboard.",
            },
          }),
        },
      );
      expect(correction.status).toBe(201);
      const correctionBody = (await correction.json()) as {
        memory: {
          id: string;
          scope: { organization?: string; component?: string };
          supersedesMemoryId: string | null;
        };
      };
      expect(correctionBody.memory).toMatchObject({
        scope: { organization: "integration", component: "billing" },
        supersedesMemoryId: original!.id,
      });

      const originalInspection = await fetch(
        `${baseUrl}/v1/learnings/${original!.id}/inspection`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(originalInspection.status).toBe(200);
      await expect(originalInspection.json()).resolves.toMatchObject({
        learning: { id: original!.id, status: "superseded" },
        provenance: [
          {
            record: {
              memoryId: original!.id,
              sourceMessageId: "inspection-api-message",
            },
            event: {
              connector: "lore-cli",
              externalEventId: "inspection-api-event",
              type: "observation",
            },
          },
        ],
        predecessor: null,
        successor: { id: correctionBody.memory.id },
      });

      const replacementInspection = await fetch(
        `${baseUrl}/v1/learnings/${correctionBody.memory.id}/inspection`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(replacementInspection.status).toBe(200);
      await expect(replacementInspection.json()).resolves.toMatchObject({
        learning: { id: correctionBody.memory.id, status: "active" },
        predecessor: { id: original!.id },
        successor: null,
      });

      const otherTenantToken =
        "inspection-other-tenant-token-123456789012345";
      await new PostgresPilotRepository(administration).ensureWorkspaceToken({
        organization: "inspection-other",
        token: otherTenantToken,
      });
      const isolatedInspection = await fetch(
        `${baseUrl}/v1/learnings/${original!.id}/inspection`,
        { headers: { authorization: `Bearer ${otherTenantToken}` } },
      );
      expect(isolatedInspection.status).toBe(404);
    });

    it("signs up and logs in with a single-use passwordless session", async () => {
      const authRequest = (path: string, body?: unknown, bearer?: string) =>
        fetch(`${baseUrl}/v1/auth/${path}`, {
          method: body === undefined && path === "session" ? "GET" : "POST",
          headers: {
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
            ...(bearer === undefined
              ? {}
              : { authorization: `Bearer ${bearer}` }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const unknownLogin = await authRequest("login", {
        email: "unknown@example.com",
      });
      const unknownBody = await unknownLogin.text();
      expect(unknownLogin.status).toBe(202);

      const signup = await authRequest("signup", {
        organizationName: "Acme Engineering",
        email: " Owner@Example.com ",
      });
      const signupBody = await signup.text();
      expect(signup.status).toBe(202);
      expect(signupBody).toBe(unknownBody);

      let magicToken: string | undefined;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        magicToken = /#token=([A-Za-z0-9_-]{43})/u.exec(apiOutput)?.[1];
        if (magicToken !== undefined) {
          break;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      }
      expect(magicToken).toBeDefined();
      const magicHash = createHash("sha256")
        .update(magicToken as string, "utf8")
        .digest("hex");
      const magicRows = await administration.client`
        SELECT token_hash
        FROM auth_magic_links
        WHERE token_hash = ${magicHash}
      `;
      expect(magicRows).toHaveLength(1);
      expect(JSON.stringify(magicRows)).not.toContain(magicToken);

      const verified = await authRequest("verify", {
        token: magicToken,
      });
      expect(verified.status).toBe(200);
      const verifiedBody = (await verified.json()) as {
        sessionToken: string;
        session: {
          email: string;
          workspaceName: string;
          organization: string;
        };
      };
      expect(verifiedBody.session).toMatchObject({
        email: "owner@example.com",
        workspaceName: "Acme Engineering",
        organization: "integration",
      });
      const sessionHash = createHash("sha256")
        .update(verifiedBody.sessionToken, "utf8")
        .digest("hex");
      const sessionRows = await administration.client`
        SELECT token_hash
        FROM auth_sessions
        WHERE token_hash = ${sessionHash}
      `;
      expect(sessionRows).toHaveLength(1);
      expect(JSON.stringify(sessionRows)).not.toContain(
        verifiedBody.sessionToken,
      );

      const otherTenantToken = "other-tenant-token-12345678901234567890";
      await new PostgresPilotRepository(administration).ensureWorkspaceToken({
        organization: "other-tenant",
        token: otherTenantToken,
        workspaceName: "Other Tenant",
      });
      const otherTenantMemory = await fetch(`${baseUrl}/v1/memories`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${otherTenantToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          content: "This learning belongs only to the bootstrap workspace.",
          repo: "private-repository",
          source: { agent: "human" },
        }),
      });
      expect(otherTenantMemory.status).toBe(201);
      const sessionMemories = await fetch(`${baseUrl}/v1/memories`, {
        headers: {
          authorization: `Bearer ${verifiedBody.sessionToken}`,
        },
      });
      expect(sessionMemories.status).toBe(200);
      expect(
        (await sessionMemories.json()) as { memories: unknown[] },
      ).toMatchObject({ memories: [] });

      const replay = await authRequest("verify", { token: magicToken });
      expect(replay.status).toBe(401);
      const session = await authRequest(
        "session",
        undefined,
        verifiedBody.sessionToken,
      );
      expect(session.status).toBe(200);
      await expect(session.json()).resolves.toMatchObject({
        session: {
          email: "owner@example.com",
          workspaceName: "Acme Engineering",
        },
      });

      const workspaceCredentialList = await fetch(
        `${baseUrl}/v1/workspace-tokens`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      );
      expect(workspaceCredentialList.status).toBe(403);

      const createManagedToken = await fetch(
        `${baseUrl}/v1/workspace-tokens`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${verifiedBody.sessionToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Integration test connector",
            expiresInDays: 30,
          }),
        },
      );
      expect(createManagedToken.status).toBe(201);
      const managedTokenBody = (await createManagedToken.json()) as {
        token: string;
        workspaceToken: {
          id: string;
          name: string;
          tokenPrefix: string;
          status: string;
        };
      };
      expect(managedTokenBody.token).toMatch(
        /^lore_[A-Za-z0-9_-]{43}$/u,
      );
      expect(managedTokenBody.workspaceToken).toMatchObject({
        name: "Integration test connector",
        status: "active",
      });
      expect(managedTokenBody.workspaceToken.tokenPrefix).toBe(
        managedTokenBody.token.slice(0, 8),
      );

      const managedHash = createHash("sha256")
        .update(managedTokenBody.token, "utf8")
        .digest("hex");
      const managedRows = await administration.client`
        SELECT token_hash
        FROM workspace_tokens
        WHERE id = ${managedTokenBody.workspaceToken.id}
      `;
      expect(managedRows).toHaveLength(1);
      expect(managedRows[0]?.token_hash).toBe(managedHash);
      expect(JSON.stringify(managedRows)).not.toContain(managedTokenBody.token);

      const managedTokenList = await fetch(
        `${baseUrl}/v1/workspace-tokens`,
        {
          headers: {
            authorization: `Bearer ${verifiedBody.sessionToken}`,
          },
        },
      );
      expect(managedTokenList.status).toBe(200);
      const managedTokenListText = await managedTokenList.text();
      expect(managedTokenListText).toContain("Integration test connector");
      expect(managedTokenListText).not.toContain(managedTokenBody.token);

      const managedCredentialRequest = await fetch(`${baseUrl}/v1/memories`, {
        headers: { authorization: `Bearer ${managedTokenBody.token}` },
      });
      expect(managedCredentialRequest.status).toBe(200);

      const revokeManagedToken = await fetch(
        `${baseUrl}/v1/workspace-tokens/${managedTokenBody.workspaceToken.id}`,
        {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${verifiedBody.sessionToken}`,
          },
        },
      );
      expect(revokeManagedToken.status).toBe(200);
      await expect(revokeManagedToken.json()).resolves.toMatchObject({
        workspaceToken: { status: "revoked" },
      });
      const revokedCredentialRequest = await fetch(
        `${baseUrl}/v1/memories`,
        {
          headers: { authorization: `Bearer ${managedTokenBody.token}` },
        },
      );
      expect(revokedCredentialRequest.status).toBe(401);

      const context = await fetch(`${baseUrl}/v1/context`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${verifiedBody.sessionToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          agent: "dashboard",
          task: "Inspect current learnings",
        }),
      });
      expect(context.status).toBe(200);

      const logout = await authRequest(
        "logout",
        undefined,
        verifiedBody.sessionToken,
      );
      expect(logout.status).toBe(204);
      const afterLogout = await authRequest(
        "session",
        undefined,
        verifiedBody.sessionToken,
      );
      expect(afterLogout.status).toBe(401);
    });
  },
);
