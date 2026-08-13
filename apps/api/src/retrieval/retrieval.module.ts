import { Global, Module } from "@nestjs/common";
import type { MemoryRepository, MemoryRetriever } from "@lore-co/core";
import {
  HybridMemoryRetriever,
  OpenAiCompatibleEmbeddingProvider,
  ScopedKeywordMemoryRetriever,
  type EmbeddingProvider,
  type SemanticMemoryStore,
} from "@lore-co/retrieval";
import {
  EMBEDDING_PROVIDER,
  MEMORY_EMBEDDING_INDEXER,
  MEMORY_REPOSITORY,
  MEMORY_RETRIEVER,
  SEMANTIC_MEMORY_STORE,
} from "../common/tokens.js";
import { DatabaseModule } from "../database/database.module.js";
import { EmbeddingIndexerService } from "./embedding-indexer.service.js";

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("Embedding timeout and dimensions must be positive integers");
  }
  return parsed;
}

function unitInterval(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error("SEMANTIC_MIN_SIMILARITY must be a number from 0 to 1");
  }
  return parsed;
}

function createEmbeddingProvider(): EmbeddingProvider | null {
  const mode = process.env.RETRIEVAL_MODE?.trim() || "auto";
  if (!["auto", "lexical", "hybrid"].includes(mode)) {
    throw new Error(
      'RETRIEVAL_MODE must be one of "auto", "lexical", or "hybrid"',
    );
  }
  if (mode === "lexical") {
    return null;
  }
  const apiKey = process.env.EMBEDDING_API_KEY?.trim() ?? "";
  if (apiKey === "" && mode === "auto") {
    return null;
  }
  if (apiKey === "") {
    throw new Error(
      "Hybrid retrieval requires EMBEDDING_API_KEY; use RETRIEVAL_MODE=lexical to disable it",
    );
  }
  return new OpenAiCompatibleEmbeddingProvider({
    baseUrl:
      process.env.EMBEDDING_BASE_URL?.trim() || "https://api.openai.com/v1",
    apiKey,
    model:
      process.env.EMBEDDING_MODEL?.trim() || "text-embedding-3-small",
    dimensions: positiveInteger(
      process.env.EMBEDDING_DIMENSIONS,
      1_536,
    ),
    timeoutMs: positiveInteger(process.env.EMBEDDING_TIMEOUT_MS, 5_000),
  });
}

@Global()
@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: EMBEDDING_PROVIDER,
      useFactory: createEmbeddingProvider,
    },
    {
      provide: MEMORY_RETRIEVER,
      inject: [
        MEMORY_REPOSITORY,
        EMBEDDING_PROVIDER,
        SEMANTIC_MEMORY_STORE,
      ],
      useFactory: (
        repository: MemoryRepository,
        provider: EmbeddingProvider | null,
        semanticStore: SemanticMemoryStore,
      ): MemoryRetriever => {
        const lexical = new ScopedKeywordMemoryRetriever(repository);
        return provider === null
          ? lexical
          : new HybridMemoryRetriever(lexical, provider, semanticStore, {
              semanticMinimumSimilarity: unitInterval(
                process.env.SEMANTIC_MIN_SIMILARITY,
                0.65,
              ),
            });
      },
    },
    EmbeddingIndexerService,
    {
      provide: MEMORY_EMBEDDING_INDEXER,
      useExisting: EmbeddingIndexerService,
    },
  ],
  exports: [MEMORY_RETRIEVER, MEMORY_EMBEDDING_INDEXER],
})
export class RetrievalModule {}
