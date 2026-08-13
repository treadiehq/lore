import type { Memory } from "@lore-co/core";
import {
  countCharacters,
  estimateTokens,
  packRelevantMemories,
} from "@lore-co/retrieval";
import { describe, expect, it } from "vitest";

function memory(id: string, content: string): Memory {
  return {
    id,
    content,
    scope: { organization: "acme", repo: "api" },
    category: "correction",
    status: "active",
    source: { agent: "human" },
    fingerprint: id.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
    supersedesMemoryId: null,
    createdAt: "2026-08-12T20:00:00.000Z",
    updatedAt: "2026-08-12T20:00:00.000Z",
    deletedAt: null,
  };
}

describe("token-aware context packing", () => {
  it("counts Unicode characters without splitting surrogate pairs", () => {
    expect(countCharacters("A😀界")).toBe(3);
    expect(estimateTokens("界")).toBe(1);
    expect(estimateTokens("😀")).toBe(2);
  });

  it("keeps complete ranked memories and skips oversized items", () => {
    const oversized = memory(
      "11111111-1111-4111-8111-111111111111",
      "x".repeat(500),
    );
    const fitting = memory(
      "22222222-2222-4222-8222-222222222222",
      "Use AccountStore.",
    );

    const packed = packRelevantMemories([oversized, fitting], {
      maxCharacters: 100,
      maxEstimatedTokens: 100,
      maxItems: 10,
      requestedItems: 5,
    });

    expect(packed.memories.map((item) => item.id)).toEqual([fitting.id]);
    expect(packed.text).toContain("1. Use AccountStore.");
    expect(packed.text).not.toContain("x".repeat(20));
    expect(packed.packing.omitted).toEqual([
      { memoryId: oversized.id, reason: "characters" },
    ]);
    expect(packed.packing.usage.includedItems).toBe(1);
  });

  it("produces stable audit metadata and enforces item limits", () => {
    const memories = [
      memory("33333333-3333-4333-8333-333333333333", "First rule."),
      memory("44444444-4444-4444-8444-444444444444", "Second rule."),
    ];
    const first = packRelevantMemories(memories, { maxItems: 1 });
    const second = packRelevantMemories(memories, { maxItems: 1 });

    expect(first.packing.contextSha256).toBe(second.packing.contextSha256);
    expect(first.packing.includedMemoryIds).toEqual([memories[0]?.id]);
    expect(first.packing.omitted).toEqual([
      { memoryId: memories[1]?.id, reason: "items" },
    ]);
  });
});
