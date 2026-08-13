import { describe, expect, it, vi } from "vitest";
import type { SharedMemoryEngine } from "@lore-co/core";
import type { PostgresPilotRepository } from "@lore-co/database";
import type { EmbeddingIndexerService } from "../src/retrieval/embedding-indexer.service.js";
import { InteractionService } from "../src/interaction/interaction.service.js";

const workspace = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  organization: "acme",
  tokenId: "22222222-2222-4222-8222-222222222222",
};

const event = {
  id: "33333333-3333-4333-8333-333333333333",
  workspaceId: workspace.workspaceId,
  connector: "lore-cli",
  externalEventId: "prompt-1",
  type: "observation" as const,
  agent: "claude",
  sessionId: "session-1",
  conversationId: null,
  payload: {},
  redacted: true,
  requestId: "request-1",
  occurredAt: "2026-08-13T12:00:00.000Z",
  receivedAt: "2026-08-13T12:00:01.000Z",
};

const memory = {
  id: "44444444-4444-4444-8444-444444444444",
  workspaceId: workspace.workspaceId,
  content: "Always use AccountStore. api_key=[REDACTED:CREDENTIAL]",
  scope: { organization: "acme" },
  category: "convention" as const,
  status: "active" as const,
  source: {
    agent: "claude",
    sessionId: "session-1",
    messageId: "message-1",
    rawText: "Always use AccountStore. api_key=[REDACTED:CREDENTIAL]",
    workspaceId: workspace.workspaceId,
    eventId: event.id,
    redacted: true,
  },
  confidence: 0.92,
  confirmation: "implicit" as const,
  fingerprint: "0".repeat(64),
  supersedesMemoryId: null,
  createdAt: "2026-08-13T12:00:01.000Z",
  updatedAt: "2026-08-13T12:00:01.000Z",
  deletedAt: null,
};

const request = {
  connector: "lore-cli",
  eventId: "prompt-1",
  agent: "claude",
  sessionId: "session-1",
  scope: { repo: "accounts" },
  task: "Implement account storage",
  messages: [
    {
      role: "user" as const,
      id: "message-1",
      content: "Always use AccountStore. api_key=super-secret-value",
    },
  ],
  occurredAt: "2026-08-13T12:00:00.000Z",
};

describe("InteractionService auditable observations", () => {
  it("redacts, tenant-scopes, records provenance, and completes replay state", async () => {
    const observe = vi.fn(async () => ({
      memories: [memory],
      created: 1,
      duplicates: 0,
      reconciled: 0,
      superseded: 0,
    }));
    const recordObservationEvent = vi.fn(async (input) => ({
      event: { ...event, payload: input.payload },
      inserted: true,
    }));
    const recordProvenance = vi.fn(async () => ({}));
    const completeObservationEvent = vi.fn(async (input) => ({
      ...event,
      payload: { response: input.response },
    }));
    const completeObservationIdempotency = vi.fn(async () => undefined);
    const repository = {
      beginObservationIdempotency: vi.fn(async () => ({ state: "claimed" })),
      recordObservationEvent,
      recordProvenance,
      completeObservationEvent,
      completeObservationIdempotency,
      abandonIdempotency: vi.fn(async () => undefined),
    } as unknown as PostgresPilotRepository;
    const service = new InteractionService(
      { observe } as unknown as SharedMemoryEngine,
      {
        indexMemories: vi.fn(async () => 1),
      } as unknown as EmbeddingIndexerService,
      repository,
    );

    const result = await service.observeEvent(
      request,
      workspace,
      "request-1",
    );

    expect(result).toMatchObject({
      replayed: false,
      created: 1,
      event: { type: "observation" },
    });
    expect(JSON.stringify(recordObservationEvent.mock.calls[0]?.[0])).not.toContain(
      "super-secret-value",
    );
    expect(recordObservationEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: expect.objectContaining({
          scope: { repo: "accounts" },
          learningScope: {},
        }),
      }),
    );
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: workspace.workspaceId,
        eventId: event.id,
        scope: { organization: "acme" },
        messages: [
          expect.objectContaining({
            content:
              "Always use AccountStore. api_key=[REDACTED:CREDENTIAL]",
          }),
        ],
      }),
    );
    expect(recordProvenance).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: event.id,
        sourceMessageId: "message-1",
        excerpt:
          "Always use AccountStore. api_key=[REDACTED:CREDENTIAL]",
        confidence: 0.92,
        confirmation: "implicit",
        redacted: true,
      }),
    );
    expect(completeObservationIdempotency).toHaveBeenCalledOnce();
  });

  it("replays an identical observation without extracting again", async () => {
    const response = {
      event,
      replayed: false,
      memories: [memory],
      created: 1,
      duplicates: 0,
      reconciled: 0,
      superseded: 0,
    };
    const observe = vi.fn();
    const service = new InteractionService(
      { observe } as unknown as SharedMemoryEngine,
      { indexMemories: vi.fn() } as unknown as EmbeddingIndexerService,
      {
        beginObservationIdempotency: vi.fn(async () => ({
          state: "replay",
          response,
        })),
      } as unknown as PostgresPilotRepository,
    );

    await expect(
      service.observeEvent(request, workspace, "request-2"),
    ).resolves.toMatchObject({ replayed: true, event: { id: event.id } });
    expect(observe).not.toHaveBeenCalled();
  });

  it("rejects a changed request for the same connector event", async () => {
    const service = new InteractionService(
      {} as SharedMemoryEngine,
      {} as EmbeddingIndexerService,
      {
        beginObservationIdempotency: vi.fn(async () => ({
          state: "conflict",
        })),
      } as unknown as PostgresPilotRepository,
    );

    await expect(
      service.observeEvent(request, workspace, "request-2"),
    ).rejects.toMatchObject({ status: 409 });
  });
});
