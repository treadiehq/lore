import {
  LoreClient,
  SharedMemoryApiError,
  SharedMemoryClient,
} from "@lore-co/sdk";
import { describe, expect, it } from "vitest";

const memory = {
  id: "00000000-0000-4000-8000-000000000001",
  content: "Account writes must use AccountStore.",
  scope: { organization: "acme", repo: "accounts" },
  category: "convention" as const,
  status: "active" as const,
  source: { agent: "human", sessionId: "session-1" },
  fingerprint: "0".repeat(64),
  supersedesMemoryId: null,
  createdAt: "2026-08-12T20:00:00.000Z",
  updatedAt: "2026-08-12T20:00:00.000Z",
  suppressedAt: null,
  deletedAt: null,
};

const packing = {
  policyVersion: "context-pack-v1" as const,
  estimator: "utf8-bytes-div-3-v1" as const,
  limits: {
    requestedItems: null,
    effectiveItems: 10,
    maxCharacters: 20_000,
    maxEstimatedTokens: 8_000,
  },
  usage: {
    retrievedItems: 0,
    includedItems: 0,
    omittedItems: 0,
    characters: 0,
    utf8Bytes: 0,
    estimatedTokens: 0,
  },
  includedMemoryIds: [],
  omitted: [],
  contextSha256: "0".repeat(64),
};

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("SharedMemoryClient requests", () => {
  it("gets and strictly validates authenticated workspace identity", async () => {
    let request: { url: string; method?: string } | undefined;
    const identity = {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      workspaceName: "Acme Engineering",
      organization: "acme",
      credentialType: "workspace_token" as const,
      server: { version: "0.1.4", revision: null },
    };
    const client = new LoreClient({
      baseUrl: "http://lore.test/",
      headers: { authorization: "Bearer workspace-token" },
      fetch: async (input, init) => {
        request = {
          url: input instanceof Request ? input.url : String(input),
          ...(init?.method === undefined ? {} : { method: init.method }),
        };
        return response(identity);
      },
    });

    await expect(client.getWorkspaceIdentity()).resolves.toEqual(identity);
    expect(request).toEqual({
      url: "http://lore.test/v1/workspace/identity",
      method: "GET",
    });
  });

  it("sends observation JSON and serializes list filters", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const injectedFetch: typeof fetch = async (input, init) => {
      requests.push({
        url: input instanceof Request ? input.url : String(input),
        ...(init === undefined ? {} : { init }),
      });
      if ((init?.method ?? "GET") === "POST") {
        return response({ memories: [memory], created: 1, duplicates: 0 });
      }
      return response({
        memories: [memory],
        total: 1,
        limit: 2,
        offset: 1,
      });
    };
    const client = new SharedMemoryClient({
      baseUrl: "http://memory.test/",
      fetch: injectedFetch,
      headers: { authorization: "Bearer local-test" },
    });
    const interaction = {
      agent: "claude",
      repo: "accounts",
      sessionId: "session-1",
      messages: [
        {
          role: "user" as const,
          content: "Always use AccountStore.",
          id: "message-1",
        },
      ],
    };

    await client.observe(interaction);
    await client.listMemories({
      organization: "acme",
      repo: "accounts",
      category: ["convention", "correction"],
      status: "active",
      query: "AccountStore",
      limit: 2,
      offset: 1,
    });

    expect(requests[0]?.url).toBe("http://memory.test/v1/interactions");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual(interaction);
    expect(new Headers(requests[0]?.init?.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
      "Bearer local-test",
    );

    const listUrl = new URL(requests[1]?.url ?? "");
    expect(listUrl.pathname).toBe("/v1/memories");
    expect(listUrl.searchParams.getAll("category")).toEqual([
      "convention",
      "correction",
    ]);
    expect(listUrl.searchParams.getAll("status")).toEqual(["active"]);
    expect(listUrl.searchParams.get("organization")).toBe("acme");
    expect(listUrl.searchParams.get("repo")).toBe("accounts");
    expect(listUrl.searchParams.get("query")).toBe("AccountStore");
    expect(listUrl.searchParams.get("limit")).toBe("2");
    expect(listUrl.searchParams.get("offset")).toBe("1");
  });

  it("binds fetch to the global receiver for browser compatibility", async () => {
    let receiver: unknown;
    const browserFetch: typeof fetch = async function (this: unknown) {
      receiver = this;
      return response({
        memories: [],
        total: 0,
        limit: 50,
        offset: 0,
      });
    };
    const client = new LoreClient({
      baseUrl: "http://lore.test",
      fetch: browserFetch,
    });

    await client.listLearnings({});

    expect(receiver).toBe(globalThis);
  });

  it("exposes learning-oriented routes and scoped list filters", async () => {
    const urls: string[] = [];
    const client = new LoreClient({
      baseUrl: "http://lore.test",
      fetch: async (input) => {
        urls.push(input instanceof Request ? input.url : String(input));
        return response({
          memories: [memory],
          total: 1,
          limit: 50,
          offset: 0,
        });
      },
    });

    await client.listLearnings({
      repo: "accounts",
      path: "src/api",
      component: "billing",
    });

    const url = new URL(urls[0] ?? "");
    expect(url.pathname).toBe("/v1/learnings");
    expect(url.searchParams.get("repo")).toBe("accounts");
    expect(url.searchParams.get("path")).toBe("src/api");
    expect(url.searchParams.get("component")).toBe("billing");
  });

  it("inspects learning provenance and sends scoped human corrections", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const event = {
      id: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      connector: "lore-cli",
      externalEventId: "event-1",
      type: "observation" as const,
      agent: "codex",
      sessionId: "session-1",
      conversationId: null,
      payload: {},
      redacted: false,
      requestId: "request-1",
      occurredAt: "2026-08-13T12:00:00.000Z",
      receivedAt: "2026-08-13T12:00:01.000Z",
    };
    const replacement = {
      ...memory,
      id: "00000000-0000-4000-8000-000000000002",
      content: "Account writes must use BillingAccountStore.",
      supersedesMemoryId: memory.id,
    };
    const client = new LoreClient({
      baseUrl: "http://lore.test",
      fetch: async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const method = init?.method ?? "GET";
        requests.push({
          url,
          method,
          ...(init?.body === undefined
            ? {}
            : { body: JSON.parse(String(init.body)) as unknown }),
        });
        return url.endsWith("/inspection")
          ? response({
              learning: memory,
              sourceEvent: event,
              provenance: [
                {
                  record: {
                    id: "33333333-3333-4333-8333-333333333333",
                    workspaceId: event.workspaceId,
                    memoryId: memory.id,
                    eventId: event.id,
                    messageRole: "user",
                    sourceMessageId: "message-1",
                    excerpt: memory.content,
                    redacted: false,
                    confidence: 1,
                    confirmation: "explicit",
                    metadata: {},
                    createdAt: event.receivedAt,
                  },
                  event,
                },
              ],
              predecessor: null,
              successor: replacement,
            })
          : response({ memory: replacement, supersededMemory: memory });
      },
    });

    const inspection = await client.inspectLearning(memory.id);
    await client.correctLearning(memory.id, {
      content: replacement.content,
      category: "correction",
      scope: { repo: "accounts", component: "billing" },
      source: {
        agent: "human",
        sessionId: "dashboard-correction",
        rawText: replacement.content,
      },
    });

    expect(inspection.provenance[0]?.event.connector).toBe("lore-cli");
    expect(requests[0]).toMatchObject({
      url: `http://lore.test/v1/learnings/${memory.id}/inspection`,
      method: "GET",
    });
    expect(requests[1]).toMatchObject({
      url: `http://lore.test/v1/learnings/${memory.id}/corrections`,
      method: "POST",
      body: {
        content: replacement.content,
        category: "correction",
        scope: { repo: "accounts", component: "billing" },
        source: {
          agent: "human",
          sessionId: "dashboard-correction",
          rawText: replacement.content,
        },
      },
    });
  });

  it("registers a Devin session for ambient transcript polling", async () => {
    let request:
      | { url: string; method?: string; body?: unknown }
      | undefined;
    const client = new LoreClient({
      baseUrl: "http://lore.test",
      fetch: async (input, init) => {
        request = {
          url: input instanceof Request ? input.url : String(input),
          ...(init?.method === undefined ? {} : { method: init.method }),
          body: JSON.parse(String(init?.body)) as unknown,
        };
        return response({
          registered: true,
          sessionId: "devin-session",
          status: "active",
        });
      },
    });

    await client.registerDevinSession({
      organizationId: "org-acme",
      sessionId: "devin-session",
      repo: "acme/accounts",
    });

    expect(request).toEqual({
      url: "http://lore.test/v1/connectors/devin/sessions",
      method: "POST",
      body: {
        organizationId: "org-acme",
        sessionId: "devin-session",
        repo: "acme/accounts",
      },
    });
  });

  it("serializes observations and filtered activity paging", async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    const client = new LoreClient({
      baseUrl: "http://lore.test",
      fetch: async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        requests.push({
          url,
          ...(init?.body === undefined
            ? {}
            : { body: JSON.parse(String(init.body)) as unknown }),
        });
        if (url.endsWith("/v1/observations")) {
          return response({
            event: {
              id: "11111111-1111-4111-8111-111111111111",
              workspaceId: "22222222-2222-4222-8222-222222222222",
              connector: "lore-cli",
              externalEventId: "prompt-1",
              type: "observation",
              agent: "codex",
              sessionId: "session-1",
              conversationId: null,
              payload: {},
              redacted: false,
              requestId: "request-1",
              occurredAt: "2026-08-13T12:00:00.000Z",
              receivedAt: "2026-08-13T12:00:01.000Z",
            },
            replayed: false,
            memories: [],
            created: 0,
            duplicates: 0,
            reconciled: 0,
            superseded: 0,
          });
        }
        return response({
          activities: [],
          total: 0,
          limit: 25,
          offset: 50,
          hasMore: false,
        });
      },
    });
    const observation = {
      connector: "lore-cli",
      eventId: "prompt-1",
      agent: "codex",
      sessionId: "session-1",
      messages: [{ role: "user" as const, content: "Use AccountStore." }],
      occurredAt: "2026-08-13T12:00:00.000Z",
    };

    await client.observeEvent(observation);
    await client.listActivity({
      type: "observation",
      agent: "codex",
      connector: "lore-cli",
      from: "2026-08-13T10:00:00.000Z",
      to: "2026-08-13T12:00:00.000Z",
      limit: 25,
      offset: 50,
    });

    expect(requests[0]).toEqual({
      url: "http://lore.test/v1/observations",
      body: observation,
    });
    const activityUrl = new URL(requests[1]?.url ?? "");
    expect(activityUrl.pathname).toBe("/v1/activity");
    expect(Object.fromEntries(activityUrl.searchParams)).toMatchObject({
      type: "observation",
      agent: "codex",
      connector: "lore-cli",
      from: "2026-08-13T10:00:00.000Z",
      to: "2026-08-13T12:00:00.000Z",
      limit: "25",
      offset: "50",
    });
  });

  it("processes typed turns and forwards an optional idempotency key", async () => {
    let request:
      | { url: string; body: unknown; headers: Headers }
      | undefined;
    const event = {
      id: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      connector: "incident-bot",
      externalEventId: "incident-42:reply-3",
      type: "paired_turn" as const,
      agent: "incident-agent",
      sessionId: "incident-42",
      conversationId: null,
      payload: {},
      redacted: false,
      requestId: "request-1",
      occurredAt: "2026-08-13T12:00:00.000Z",
      receivedAt: "2026-08-13T12:00:01.000Z",
    };
    const client = new LoreClient({
      baseUrl: "http://lore.test",
      fetch: async (input, init) => {
        request = {
          url: input instanceof Request ? input.url : String(input),
          body: JSON.parse(String(init?.body)) as unknown,
          headers: new Headers(init?.headers),
        };
        return response({
          requestId: "request-1",
          event,
          replayed: false,
          observation: {
            memories: [],
            created: 0,
            duplicates: 0,
            reconciled: 0,
            superseded: 0,
          },
          context: { memories: [], text: "", packing },
          receipt: {
            id: "33333333-3333-4333-8333-333333333333",
            workspaceId: event.workspaceId,
            eventId: event.id,
            requestId: "request-1",
            memoryIds: [],
            packing,
            deliveredAt: "2026-08-13T12:00:01.000Z",
          },
        });
      },
    });
    const turn = {
      connector: "incident-bot",
      eventId: "incident-42:reply-3",
      agent: "incident-agent",
      sessionId: "incident-42",
      previousAssistant: { content: "Restart the service." },
      currentUser: { content: "Use the failover first." },
      scope: { repo: "acme/service" },
    };

    await client.processTurn(turn, "incident-42:reply-3");

    expect(request?.url).toBe("http://lore.test/v1/turns");
    expect(request?.body).toEqual(turn);
    expect(request?.headers.get("idempotency-key")).toBe(
      "incident-42:reply-3",
    );
  });

  it("gets and updates policy and reviews proposal details", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const workspaceId = "22222222-2222-4222-8222-222222222222";
    const proposal = {
      ...memory,
      status: "proposed" as const,
    };
    const metadata = {
      memoryId: proposal.id,
      workspaceId,
      policyMode: "proposal_only" as const,
      reason: "Review required.",
      provenance: proposal.source,
      proposedAt: proposal.createdAt,
      decision: null,
      reviewerId: null,
      decisionReason: null,
      decidedAt: null,
      decisionTargetMemoryId: null,
    };
    const client = new LoreClient({
      baseUrl: "http://lore.test",
      fetch: async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const method = init?.method ?? "GET";
        requests.push({
          url,
          method,
          ...(init?.body === undefined
            ? {}
            : { body: JSON.parse(String(init.body)) as unknown }),
        });
        if (url.endsWith("/v1/workspace/policy")) {
          return response({
            workspaceId,
            learningMode: method === "PATCH" ? "proposal_only" : "trust_tiered",
            llmConflictAnalysisEnabled: method === "PATCH",
            updatedAt: "2026-08-18T12:00:00.000Z",
          });
        }
        if (url.endsWith("/proposal")) {
          return response({
            memory: proposal,
            metadata,
            conflicts: [],
            conflictTargets: [],
          });
        }
        return response({
          proposal: { ...proposal, status: "active" },
          metadata: {
            ...metadata,
            decision: "approve",
            reviewerId: "33333333-3333-4333-8333-333333333333",
            decisionReason: "Durable convention.",
            decidedAt: "2026-08-18T12:01:00.000Z",
          },
          conflicts: [],
          supersededMemory: null,
        });
      },
    });

    await client.getWorkspaceLearningPolicy();
    await client.updateWorkspaceLearningPolicy({
      learningMode: "proposal_only",
      llmConflictAnalysisEnabled: true,
    });
    await client.getProposal(proposal.id);
    await client.reviewProposal(proposal.id, {
      decision: "approve",
      reason: "Durable convention.",
      scope: { organization: "acme" },
    });

    expect(requests).toEqual([
      {
        url: "http://lore.test/v1/workspace/policy",
        method: "GET",
      },
      {
        url: "http://lore.test/v1/workspace/policy",
        method: "PATCH",
        body: {
          learningMode: "proposal_only",
          llmConflictAnalysisEnabled: true,
        },
      },
      {
        url: `http://lore.test/v1/memories/${proposal.id}/proposal`,
        method: "GET",
      },
      {
        url: `http://lore.test/v1/memories/${proposal.id}/review`,
        method: "POST",
        body: {
          decision: "approve",
          reason: "Durable convention.",
          scope: { organization: "acme" },
        },
      },
    ]);
  });

  it("throws a structured API error with server details", async () => {
    const client = new SharedMemoryClient({
      baseUrl: "http://memory.test",
      fetch: async () =>
        response(
          {
            message: "Only active memories can be corrected",
            error: "Conflict",
          },
          409,
        ),
    });

    const promise = client.correct(memory.id, {
      content: "Use AccountStore.",
    });
    await expect(promise).rejects.toMatchObject({
      name: "SharedMemoryApiError",
      status: 409,
      method: "POST",
      url: `http://memory.test/v1/memories/${memory.id}/corrections`,
      details: {
        message: "Only active memories can be corrected",
        error: "Conflict",
      },
    });
    await expect(promise).rejects.toBeInstanceOf(SharedMemoryApiError);
  });
});
