import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import type { Memory } from "@lore-co/core";
import type {
  EmbeddingProvider,
  SemanticMemoryStore,
} from "@lore-co/retrieval";
import {
  EMBEDDING_PROVIDER,
  SEMANTIC_MEMORY_STORE,
} from "../common/tokens.js";

@Injectable()
export class EmbeddingIndexerService implements OnApplicationBootstrap {
  readonly #provider: EmbeddingProvider | null;
  readonly #store: SemanticMemoryStore;

  constructor(
    @Inject(EMBEDDING_PROVIDER) provider: EmbeddingProvider | null,
    @Inject(SEMANTIC_MEMORY_STORE) store: SemanticMemoryStore,
  ) {
    this.#provider = provider;
    this.#store = store;
  }

  onApplicationBootstrap(): void {
    void this.#backfill().catch(() => undefined);
  }

  async indexMemories(memories: readonly Memory[]): Promise<number> {
    if (this.#provider === null) {
      return 0;
    }
    const provider = this.#provider;
    const unique = [
      ...new Map(
        memories
          .filter((memory) => memory.status === "active")
          .map((memory) => [memory.id, memory]),
      ).values(),
    ];
    const results = await Promise.allSettled(
      unique.map(async (memory) => {
        const embedding = await provider.embed(memory.content);
        await this.#store.upsertEmbedding({
          memory,
          model: provider.model,
          embedding,
        });
      }),
    );
    return results.filter((result) => result.status === "fulfilled").length;
  }

  async #backfill(): Promise<void> {
    if (this.#provider === null) {
      return;
    }
    const limit = 100;
    for (let batch = 0; batch < 10; batch += 1) {
      const memories = await this.#store.listNeedingEmbedding({
        model: this.#provider.model,
        limit,
      });
      if (memories.length === 0) {
        return;
      }
      const indexed = await this.indexMemories(memories);
      if (indexed === 0) {
        return;
      }
      if (memories.length < limit) {
        return;
      }
    }
  }
}
