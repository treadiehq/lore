import type { ContextPackingOptions } from "@lore-co/retrieval";

function positiveInteger(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function contextPackingOptions(
  requestedItems?: number,
): ContextPackingOptions {
  return {
    ...(requestedItems === undefined ? {} : { requestedItems }),
    maxItems: positiveInteger(
      "CONTEXT_MAX_ITEMS",
      process.env.CONTEXT_MAX_ITEMS,
      10,
    ),
    maxCharacters: positiveInteger(
      "CONTEXT_MAX_CHARACTERS",
      process.env.CONTEXT_MAX_CHARACTERS,
      12_000,
    ),
    maxEstimatedTokens: positiveInteger(
      "CONTEXT_MAX_ESTIMATED_TOKENS",
      process.env.CONTEXT_MAX_ESTIMATED_TOKENS,
      4_000,
    ),
  };
}
