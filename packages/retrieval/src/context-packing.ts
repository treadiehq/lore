import { createHash } from "node:crypto";
import type { ContextPacking, Memory } from "@lore-co/core";

export const DEFAULT_CONTEXT_MAX_CHARACTERS = 12_000;
export const DEFAULT_CONTEXT_MAX_ESTIMATED_TOKENS = 4_000;
export const DEFAULT_CONTEXT_MAX_ITEMS = 10;

export interface ContextPackingOptions {
  requestedItems?: number;
  maxItems?: number;
  maxCharacters?: number;
  maxEstimatedTokens?: number;
}

export interface PackedMemoryContext {
  memories: Memory[];
  text: string;
  packing: ContextPacking;
}

export function countCharacters(text: string): number {
  return Array.from(text).length;
}

export function estimateTokens(text: string): number {
  const bytes = Buffer.byteLength(text, "utf8");
  return bytes === 0 ? 0 : Math.ceil(bytes / 3);
}

function contextText(memories: readonly Memory[]): string {
  if (memories.length === 0) {
    return "";
  }
  return [
    "Relevant shared engineering knowledge:",
    ...memories.map((memory, index) => `${index + 1}. ${memory.content}`),
  ].join("\n");
}

export function packRelevantMemories(
  memories: readonly Memory[],
  options: ContextPackingOptions = {},
): PackedMemoryContext {
  const maxItems = Math.min(
    Math.max(options.maxItems ?? DEFAULT_CONTEXT_MAX_ITEMS, 1),
    DEFAULT_CONTEXT_MAX_ITEMS,
  );
  const maxCharacters = Math.max(
    options.maxCharacters ?? DEFAULT_CONTEXT_MAX_CHARACTERS,
    1,
  );
  const maxEstimatedTokens = Math.max(
    options.maxEstimatedTokens ?? DEFAULT_CONTEXT_MAX_ESTIMATED_TOKENS,
    1,
  );
  const included: Memory[] = [];
  const omitted: ContextPacking["omitted"] = [];

  for (const memory of memories) {
    if (included.length >= maxItems) {
      omitted.push({ memoryId: memory.id, reason: "items" });
      continue;
    }
    const candidateText = contextText([...included, memory]);
    if (countCharacters(candidateText) > maxCharacters) {
      omitted.push({ memoryId: memory.id, reason: "characters" });
      continue;
    }
    if (estimateTokens(candidateText) > maxEstimatedTokens) {
      omitted.push({ memoryId: memory.id, reason: "estimated_tokens" });
      continue;
    }
    included.push(memory);
  }

  const text = contextText(included);
  const utf8Bytes = Buffer.byteLength(text, "utf8");
  return {
    memories: included,
    text,
    packing: {
      policyVersion: "context-pack-v1",
      estimator: "utf8-bytes-div-3-v1",
      limits: {
        requestedItems: options.requestedItems ?? null,
        effectiveItems: maxItems,
        maxCharacters,
        maxEstimatedTokens,
      },
      usage: {
        retrievedItems: memories.length,
        includedItems: included.length,
        omittedItems: omitted.length,
        characters: countCharacters(text),
        utf8Bytes,
        estimatedTokens: estimateTokens(text),
      },
      includedMemoryIds: included.map((memory) => memory.id),
      omitted,
      contextSha256: createHash("sha256").update(text, "utf8").digest("hex"),
    },
  };
}
