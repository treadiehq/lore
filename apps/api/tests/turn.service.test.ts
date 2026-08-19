import { describe, expect, it, vi } from "vitest";
import type { SharedMemoryEngine } from "@lore-co/core";
import type { PostgresPilotRepository } from "@lore-co/database";
import type { EmbeddingIndexerService } from "../src/retrieval/embedding-indexer.service.js";
import { TurnService } from "../src/turn/turn.service.js";

const workspace = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  organization: "acme",
};

describe("TurnService scope behavior", () => {
  it("keeps task path evidence while restoring repository candidate context", async () => {
    const observe = vi.fn(async () => ({
      memories: [],
      created: 0,
      duplicates: 0,
      reconciled: 0,
      superseded: 0,
    }));
    const getContext = vi.fn(async () => ({ memories: [], hits: [] }));
    const event = {
      id: "22222222-2222-4222-8222-222222222222",
      workspaceId: workspace.workspaceId,
      connector: "lore-cli",
      externalEventId: "turn-1",
      type: "paired_turn" as const,
      agent: "codex",
      sessionId: "session-1",
      conversationId: null,
      payload: {},
      redacted: false,
      requestId: "request-1",
      occurredAt: "2026-08-18T12:00:00.000Z",
      receivedAt: "2026-08-18T12:00:01.000Z",
    };
    const repository = {
      beginIdempotency: vi.fn(async () => ({ state: "claimed" })),
      recordConnectorEvent: vi.fn(async () => event),
      recordProvenance: vi.fn(async () => undefined),
      recordDeliveryReceipt: vi.fn(async (input: {
        packing: unknown;
        querySha256: string;
        retrievalPolicyVersion: string;
      }) => ({
        id: "33333333-3333-4333-8333-333333333333",
        workspaceId: workspace.workspaceId,
        eventId: event.id,
        requestId: "request-1",
        memoryIds: [],
        packing: input.packing,
        querySha256: input.querySha256,
        retrievalPolicyVersion: input.retrievalPolicyVersion,
        hits: [],
        deliveredAt: "2026-08-18T12:00:02.000Z",
      })),
      completeIdempotency: vi.fn(async () => undefined),
      abandonIdempotency: vi.fn(async () => undefined),
    };
    const service = new TurnService(
      { observe, getContext } as unknown as SharedMemoryEngine,
      repository as unknown as PostgresPilotRepository,
      { indexMemories: vi.fn(async () => 0) } as unknown as EmbeddingIndexerService,
    );

    await service.process(
      {
        connector: "lore-cli",
        eventId: "turn-1",
        agent: "codex",
        sessionId: "session-1",
        previousAssistant: {
          content: "RepositoryFactory handles persistence.",
        },
        currentUser: {
          content: "No, use AccountStore instead.",
        },
        scope: { repo: "accounts", path: "src/accounts" },
        learningScope: {},
        task: "Update account persistence",
      },
      workspace,
      "request-1",
    );

    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: {
          organization: "acme",
          repo: "accounts",
          path: "src/accounts",
        },
      }),
    );
    expect(getContext).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: {
          organization: "acme",
          repo: "accounts",
          path: "src/accounts",
        },
      }),
      { workspaceId: workspace.workspaceId },
    );
  });

  it("does not create native OpenCode learning without repository evidence", async () => {
    const observe = vi.fn();
    const getContext = vi.fn(async () => ({ memories: [], hits: [] }));
    const event = {
      id: "44444444-4444-4444-8444-444444444444",
      workspaceId: workspace.workspaceId,
      connector: "lore-opencode-plugin",
      externalEventId: "opencode-turn-without-repository",
      type: "paired_turn" as const,
      agent: "opencode",
      sessionId: "opencode-session",
      conversationId: null,
      payload: {},
      redacted: false,
      requestId: "request-opencode",
      occurredAt: "2026-08-18T12:00:00.000Z",
      receivedAt: "2026-08-18T12:00:01.000Z",
    };
    const repository = {
      beginIdempotency: vi.fn(async () => ({ state: "claimed" })),
      recordConnectorEvent: vi.fn(async () => event),
      recordProvenance: vi.fn(async () => undefined),
      recordDeliveryReceipt: vi.fn(async (input: {
        packing: unknown;
        querySha256: string;
        retrievalPolicyVersion: string;
      }) => ({
        id: "55555555-5555-4555-8555-555555555555",
        workspaceId: workspace.workspaceId,
        eventId: event.id,
        requestId: event.requestId,
        memoryIds: [],
        packing: input.packing,
        querySha256: input.querySha256,
        retrievalPolicyVersion: input.retrievalPolicyVersion,
        hits: [],
        deliveredAt: "2026-08-18T12:00:02.000Z",
      })),
      completeIdempotency: vi.fn(async () => undefined),
      abandonIdempotency: vi.fn(async () => undefined),
    };
    const service = new TurnService(
      { observe, getContext } as unknown as SharedMemoryEngine,
      repository as unknown as PostgresPilotRepository,
      {
        indexMemories: vi.fn(async () => 0),
      } as unknown as EmbeddingIndexerService,
    );

    await service.process(
      {
        connector: "lore-opencode-plugin",
        eventId: "opencode-turn-without-repository",
        agent: "opencode",
        sessionId: "opencode-session",
        previousAssistant: { content: "Use the old store." },
        currentUser: { content: "No, use AccountStore." },
        scope: {},
        learningScope: {},
      },
      workspace,
      event.requestId,
    );

    expect(observe).not.toHaveBeenCalled();
    expect(getContext).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "opencode",
        scope: { organization: workspace.organization },
      }),
      { workspaceId: workspace.workspaceId },
    );
  });
});
