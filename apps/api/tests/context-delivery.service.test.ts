import { describe, expect, it, vi } from "vitest";
import type { SharedMemoryEngine } from "@lore-co/core";
import type { PostgresPilotRepository } from "@lore-co/database";
import { ContextService } from "../src/context/context.service.js";

const workspace = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  organization: "acme",
  tokenId: "22222222-2222-4222-8222-222222222222",
};

const memory = {
  id: "33333333-3333-4333-8333-333333333333",
  workspaceId: workspace.workspaceId,
  content: "Account writes must use AccountStore.",
  scope: { organization: "acme", repo: "acme/accounts" },
  category: "convention" as const,
  status: "active" as const,
  source: { agent: "human" },
  fingerprint: "0".repeat(64),
  supersedesMemoryId: null,
  createdAt: "2026-08-12T20:00:00.000Z",
  updatedAt: "2026-08-12T20:00:00.000Z",
  suppressedAt: null,
  deletedAt: null,
};

describe("ContextService delivery receipts", () => {
  it("records the exact packed context and receipt", async () => {
    const event = {
      id: "44444444-4444-4444-8444-444444444444",
      workspaceId: workspace.workspaceId,
      connector: "github-devin-review",
      externalEventId: "review-1",
      type: "context_delivery" as const,
      agent: "devin",
      sessionId: "github:acme/accounts:pr:1:abc",
      conversationId: null,
      payload: {},
      redacted: false,
      requestId: "request-1",
      occurredAt: "2026-08-12T20:00:00.000Z",
      receivedAt: "2026-08-12T20:00:00.000Z",
    };
    const receipt = {
      id: "55555555-5555-4555-8555-555555555555",
      workspaceId: workspace.workspaceId,
      eventId: event.id,
      requestId: "request-1",
      memoryIds: [memory.id],
      packing: null,
      querySha256: null,
      retrievalPolicyVersion: "precision-v3",
      hits: [],
      deliveredAt: "2026-08-12T20:00:00.000Z",
    };
    const recordDeliveryReceipt = vi.fn(async (input) => ({
      ...receipt,
      packing: input.packing,
      querySha256: input.querySha256,
      retrievalPolicyVersion: input.retrievalPolicyVersion,
      hits: input.hits.map((hit) => ({
        memoryId: hit.memory.id,
        fingerprint: hit.memory.fingerprint,
        content: hit.memory.content,
        score: hit.score,
        reasons: hit.reasons,
        matchedTerms: hit.matchedTerms,
      })),
    }));
    const repository = {
      recordContextDeliveryEvent: vi.fn(async (input) => ({
        event: { ...event, payload: input.payload },
        inserted: true,
      })),
      recordDeliveryReceipt,
    } as unknown as PostgresPilotRepository;
    const engine = {
      getContext: vi.fn(async () => ({
        memories: [memory],
        hits: [
          {
            memory,
            score: 8,
            reasons: ["repository", "lexical"],
            matchedTerms: ["account", "accountstore"],
            lexicalRank: 1,
            semanticRank: null,
          },
        ],
      })),
    } as unknown as SharedMemoryEngine;
    const service = new ContextService(engine, repository);

    const result = await service.deliver(
      {
        connector: "github-devin-review",
        eventId: "review-1",
        sessionId: event.sessionId,
        task: {
          agent: "devin",
          repo: "acme/accounts",
          task: "Review PR #1",
        },
      },
      workspace,
      "request-1",
    );

    expect(result.context).toContain("AccountStore");
    expect(result.packing.contextSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.receipt.memoryIds).toEqual([memory.id]);
    expect(result.hits[0]).toMatchObject({
      memory: { id: memory.id },
      reasons: ["repository", "lexical"],
    });
    expect(result.receipt.hits[0]).toMatchObject({
      memoryId: memory.id,
      content: memory.content,
    });
    expect(recordDeliveryReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: event.id,
        memoryIds: [memory.id],
        querySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        retrievalPolicyVersion: "precision-v3",
        hits: result.hits,
        packing: result.packing,
      }),
    );
  });

  it("loads receipt details within the authenticated workspace", async () => {
    const detail = { receipt: { id: "receipt" } };
    const getDeliveryReceiptDetail = vi.fn(async () => detail);
    const service = new ContextService(
      {} as SharedMemoryEngine,
      { getDeliveryReceiptDetail } as unknown as PostgresPilotRepository,
    );

    await expect(
      service.getDelivery(
        "55555555-5555-4555-8555-555555555555",
        workspace,
      ),
    ).resolves.toBe(detail);
    expect(getDeliveryReceiptDetail).toHaveBeenCalledWith({
      workspaceId: workspace.workspaceId,
      receiptId: "55555555-5555-4555-8555-555555555555",
    });
  });

  it("suppresses feedback immediately and records the authenticated actor", async () => {
    const response = {
      feedback: {
        id: "66666666-6666-4666-8666-666666666666",
        workspaceId: workspace.workspaceId,
        receiptId: "55555555-5555-4555-8555-555555555555",
        memoryId: memory.id,
        action: "wrong",
        reason: "password=[REDACTED:CREDENTIAL]",
        actorId: workspace.tokenId,
        createdAt: "2026-08-12T20:00:00.000Z",
      },
      memory: {
        ...memory,
        status: "suppressed",
        suppressedAt: "2026-08-12T20:00:00.000Z",
      },
    };
    const recordDeliveryFeedback = vi.fn(async () => response);
    const service = new ContextService(
      {} as SharedMemoryEngine,
      { recordDeliveryFeedback } as unknown as PostgresPilotRepository,
    );

    await expect(
      service.recordFeedback(
        "55555555-5555-4555-8555-555555555555",
        {
          memoryId: memory.id,
          action: "wrong",
          reason: "password=super-secret-value",
        },
        workspace,
      ),
    ).resolves.toBe(response);
    expect(recordDeliveryFeedback).toHaveBeenCalledWith({
      workspaceId: workspace.workspaceId,
      receiptId: "55555555-5555-4555-8555-555555555555",
      memoryId: memory.id,
      action: "wrong",
      reason: "password=[REDACTED:CREDENTIAL]",
      actorId: workspace.tokenId,
    });
  });
});
