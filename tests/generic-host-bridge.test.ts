import { GenericAgentAdapter } from "@lore-co/adapter-generic";
import { describe, expect, it } from "vitest";

const now = "2026-08-13T12:00:00.000Z";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const eventId = "11111111-1111-4111-8111-111111111111";
const memoryId = "44444444-4444-4444-8444-444444444444";
const context = "Fail over before restarting the incident service.";
const memory = {
  id: memoryId,
  content: context,
  scope: { organization: "acme", repo: "acme/service" },
  category: "convention" as const,
  status: "active" as const,
  source: { agent: "human" },
  fingerprint: "1".repeat(64),
  supersedesMemoryId: null,
  createdAt: now,
  updatedAt: now,
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
    retrievedItems: 1,
    includedItems: 1,
    omittedItems: 0,
    characters: context.length,
    utf8Bytes: context.length,
    estimatedTokens: 17,
  },
  includedMemoryIds: [memoryId],
  omitted: [],
  contextSha256: "2".repeat(64),
};

function event(
  type: "observation" | "paired_turn" | "context_delivery",
  body: Record<string, unknown>,
) {
  return {
    id: eventId,
    workspaceId,
    connector: body.connector,
    externalEventId: body.eventId,
    type,
    agent:
      type === "context_delivery"
        ? (body.task as Record<string, unknown>).agent
        : body.agent,
    sessionId: body.sessionId,
    conversationId: body.conversationId ?? null,
    payload: {},
    redacted: false,
    requestId: "request-1",
    occurredAt: now,
    receivedAt: now,
  };
}

function receipt() {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    workspaceId,
    eventId,
    requestId: "request-1",
    memoryIds: [memoryId],
    packing,
    deliveredAt: now,
  };
}

describe("GenericAgentAdapter host bridge", () => {
  it("forces the configured agent on audited observations", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const adapter = new GenericAgentAdapter({
      id: "incident-agent",
      baseUrl: "http://lore.test",
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          event: event("observation", requestBody),
          replayed: false,
          memories: [],
          created: 0,
          duplicates: 0,
          reconciled: 0,
          superseded: 0,
        });
      },
    });
    const hostInput = {
      connector: "pager-webhook",
      eventId: "incident-42:opened",
      sessionId: "incident-42",
      agent: "spoofed-agent",
      scope: { project: "incidents" },
      repo: "acme/service",
      prompt: "Investigate elevated errors",
      messages: [{ role: "user" as const, content: "Investigate elevated errors" }],
      occurredAt: now,
    };

    const result = await adapter.observeEvent(hostInput);

    expect(requestBody).toMatchObject({
      connector: "pager-webhook",
      eventId: "incident-42:opened",
      sessionId: "incident-42",
      agent: "incident-agent",
      task: "Investigate elevated errors",
      scope: { project: "incidents", repo: "acme/service" },
    });
    expect(result.event.type).toBe("observation");
    expect(result.replayed).toBe(false);
  });

  it("prepares audited delivery with receipt, memories, and injected context", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const adapter = new GenericAgentAdapter({
      id: "model-service",
      baseUrl: "http://lore.test",
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          event: event("context_delivery", requestBody),
          receipt: receipt(),
          replayed: false,
          memories: [memory],
          context,
          packing,
        });
      },
    });

    const prepared = await adapter.prepareDelivery({
      connector: "model-api",
      eventId: "request-77",
      sessionId: "conversation-9",
      task: "Resolve the incident",
      repo: "acme/service",
    });

    expect(
      (requestBody?.task as Record<string, unknown> | undefined)?.agent,
    ).toBe("model-service");
    expect(prepared.event.type).toBe("context_delivery");
    expect(prepared.receipt.memoryIds).toEqual([memoryId]);
    expect(prepared.memories).toEqual([memory]);
    expect(prepared.prompt.indexOf(context)).toBeLessThan(
      prepared.prompt.indexOf("Resolve the incident"),
    );
  });

  it("processes a stable paired turn and forwards idempotency", async () => {
    let requestBody: Record<string, unknown> | undefined;
    let requestHeaders: Headers | undefined;
    const adapter = new GenericAgentAdapter({
      id: "incident-agent",
      baseUrl: "http://lore.test",
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requestHeaders = new Headers(init?.headers);
        return Response.json({
          requestId: "request-1",
          event: event("paired_turn", requestBody),
          replayed: false,
          observation: {
            memories: [],
            created: 0,
            duplicates: 0,
            reconciled: 0,
            superseded: 0,
          },
          context: { memories: [memory], text: context, packing },
          receipt: receipt(),
        });
      },
    });

    const result = await adapter.processTurn(
      {
        connector: "pager-webhook",
        eventId: "incident-42:reply-3",
        sessionId: "incident-42",
        previousAssistant: "Restart the service.",
        currentUserPrompt: "No, fail over first.",
        repo: "acme/service",
      },
      "incident-42:reply-3",
    );

    expect(requestBody).toMatchObject({
      connector: "pager-webhook",
      eventId: "incident-42:reply-3",
      sessionId: "incident-42",
      agent: "incident-agent",
      currentUser: { content: "No, fail over first." },
      scope: { repo: "acme/service" },
    });
    expect(requestHeaders?.get("idempotency-key")).toBe(
      "incident-42:reply-3",
    );
    expect(result.receipt.id).toBe(receipt().id);
    expect(result.memories).toEqual([memory]);
    expect(result.prompt.indexOf(context)).toBeLessThan(
      result.prompt.indexOf("No, fail over first."),
    );
  });

  it("rejects conflicting normalized scope", () => {
    const adapter = new GenericAgentAdapter({
      id: "incident-agent",
      baseUrl: "http://lore.test",
      fetch: async () => Response.json({}),
    });

    expect(() =>
      adapter.toTurn({
        connector: "pager-webhook",
        eventId: "incident-42:reply-4",
        sessionId: "incident-42",
        previousAssistant: "Restart.",
        currentUserPrompt: "Fail over.",
        scope: { repo: "acme/one" },
        repo: "acme/two",
      }),
    ).toThrow("Conflicting repo");
  });
});
