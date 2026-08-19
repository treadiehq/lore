import {
  MemoryConflictAnalysisSchema,
  type MemoryConflictAnalyzer,
} from "@lore-co/core";
import {
  OpenAiCompatibleHttpProvider,
  type ExtractorEnvironment,
} from "@lore-co/extractor";

export function createConfiguredConflictAnalyzer(
  environment: ExtractorEnvironment,
): MemoryConflictAnalyzer | null {
  const providerName = environment.EXTRACTOR_PROVIDER?.trim() || "heuristic";
  if (providerName === "heuristic") {
    return null;
  }
  const baseUrl = environment.EXTRACTOR_BASE_URL?.trim();
  const apiKey = environment.EXTRACTOR_API_KEY?.trim();
  const model = environment.EXTRACTOR_MODEL?.trim();
  if (
    (providerName !== "hybrid" &&
      providerName !== "openai-compatible") ||
    baseUrl === undefined ||
    baseUrl === "" ||
    apiKey === undefined ||
    apiKey === "" ||
    model === undefined ||
    model === ""
  ) {
    return null;
  }

  const provider = new OpenAiCompatibleHttpProvider({
    baseUrl,
    apiKey,
    model,
    timeoutMs: 10_000,
  });
  return {
    async analyze({ proposal, target }) {
      return provider.generateStructured(
        {
          schemaName: "memory_conflict_analysis",
          systemPrompt:
            "Compare two redacted engineering-memory statements. Classify whether they conflict, are merely related, or do not conflict. Explain concisely using only the supplied statements and scope. Never recommend activation, replacement, or suppression. Return JSON only.",
          prompt: JSON.stringify({
            output: {
              classification: "conflict|related|not_conflict",
              explanation: "concise safe explanation",
            },
            proposal: {
              content: proposal.content,
              category: proposal.category,
              scope: proposal.scope,
            },
            existing: {
              content: target.content,
              category: target.category,
              scope: target.scope,
            },
          }),
        },
        MemoryConflictAnalysisSchema,
      );
    },
  };
}
