import {
  InMemoryMemoryRepository,
  SharedMemoryEngine,
  type Memory,
} from "@lore-co/core";
import { HeuristicMemoryExtractor } from "@lore-co/extractor";
import {
  EMBEDDING_DIMENSIONS,
  HybridMemoryRetriever,
  OpenAiCompatibleEmbeddingProvider,
  ScopedKeywordMemoryRetriever,
  type EmbeddingProvider,
  type SemanticMemorySearchInput,
  type SemanticMemoryStore,
} from "@lore-co/retrieval";
import { describe, expect, it, vi } from "vitest";

const workspaceId = "11111111-1111-4111-8111-111111111111";

class FakeSemanticStore implements SemanticMemoryStore {
  readonly searchCalls: SemanticMemorySearchInput[] = [];
  memories: Memory[] = [];

  async search(input: SemanticMemorySearchInput): Promise<Memory[]> {
    this.searchCalls.push(input);
    return this.memories;
  }

  async upsertEmbedding(): Promise<void> {}

  async listNeedingEmbedding(): Promise<Memory[]> {
    return [];
  }
}

async function memoryFixture(): Promise<{
  repository: InMemoryMemoryRepository;
  memory: Memory;
}> {
  const repository = new InMemoryMemoryRepository();
  const engine = new SharedMemoryEngine({
    repository,
    extractor: new HeuristicMemoryExtractor(),
    retriever: new ScopedKeywordMemoryRetriever(repository),
  });
  const remembered = await engine.remember({
    content:
      "Payment processing is asynchronous and runs in the settlement worker.",
    scope: { organization: "acme", repo: "billing" },
    source: { agent: "human", workspaceId },
  });
  return { repository, memory: remembered.memory };
}

describe("hybrid retrieval", () => {
  it("retrieves a semantic paraphrase with no lexical overlap", async () => {
    const { repository, memory } = await memoryFixture();
    const store = new FakeSemanticStore();
    store.memories = [memory];
    const provider: EmbeddingProvider = {
      model: "test-embedding",
      dimensions: EMBEDDING_DIMENSIONS,
      embed: vi.fn(async () => Array(EMBEDDING_DIMENSIONS).fill(0.25)),
    };
    const retriever = new HybridMemoryRetriever(
      new ScopedKeywordMemoryRetriever(repository),
      provider,
      store,
    );

    const result = await retriever.retrieve(
      {
        agent: "claude",
        organization: "acme",
        repo: "billing",
        task: "Explain why invoices finish later in a background job",
      },
      { workspaceId },
    );

    expect(result.map((item) => item.id)).toEqual([memory.id]);
    expect(provider.embed).toHaveBeenCalledOnce();
    expect(store.searchCalls[0]?.workspaceId).toBe(workspaceId);
  });

  it("falls back to lexical results when embeddings fail", async () => {
    const { repository, memory } = await memoryFixture();
    const provider: EmbeddingProvider = {
      model: "test-embedding",
      dimensions: EMBEDDING_DIMENSIONS,
      embed: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
    };
    const retriever = new HybridMemoryRetriever(
      new ScopedKeywordMemoryRetriever(repository),
      provider,
      new FakeSemanticStore(),
    );

    const result = await retriever.retrieve(
      {
        agent: "codex",
        organization: "acme",
        repo: "billing",
        task: "Change the settlement worker payment processing",
      },
      { workspaceId },
    );

    expect(result.map((item) => item.id)).toEqual([memory.id]);
  });

  it("keeps exact lexical identifiers ahead of semantic-only candidates", async () => {
    const { repository, memory: semanticMemory } = await memoryFixture();
    const engine = new SharedMemoryEngine({
      repository,
      extractor: new HeuristicMemoryExtractor(),
      retriever: new ScopedKeywordMemoryRetriever(repository),
    });
    const exact = await engine.remember({
      content: "RepositoryFactory must not be called from account handlers.",
      scope: { organization: "acme", repo: "billing" },
      source: { agent: "human", workspaceId },
    });
    const store = new FakeSemanticStore();
    store.memories = [semanticMemory];
    const retriever = new HybridMemoryRetriever(
      new ScopedKeywordMemoryRetriever(repository),
      {
        model: "test-embedding",
        dimensions: EMBEDDING_DIMENSIONS,
        embed: async () => Array(EMBEDDING_DIMENSIONS).fill(0),
      },
      store,
    );

    const result = await retriever.retrieve(
      {
        agent: "codex",
        organization: "acme",
        repo: "billing",
        task: "Update RepositoryFactory usage",
      },
      { workspaceId },
    );

    expect(result.map((item) => item.id)).toEqual([
      exact.memory.id,
      semanticMemory.id,
    ]);
  });

  it("does not call semantic search without trusted workspace identity", async () => {
    const { repository } = await memoryFixture();
    const store = new FakeSemanticStore();
    const provider: EmbeddingProvider = {
      model: "test-embedding",
      dimensions: EMBEDDING_DIMENSIONS,
      embed: vi.fn(async () => Array(EMBEDDING_DIMENSIONS).fill(0)),
    };
    const retriever = new HybridMemoryRetriever(
      new ScopedKeywordMemoryRetriever(repository),
      provider,
      store,
    );

    await retriever.retrieve({
      agent: "generic",
      organization: "acme",
      repo: "billing",
      task: "unrelated paraphrase",
    });

    expect(provider.embed).not.toHaveBeenCalled();
    expect(store.searchCalls).toHaveLength(0);
  });

  it("redacts secrets before creating a query embedding", async () => {
    const { repository, memory } = await memoryFixture();
    const store = new FakeSemanticStore();
    store.memories = [memory];
    const embed = vi.fn(async (_input: string) =>
      Array(EMBEDDING_DIMENSIONS).fill(0),
    );
    const retriever = new HybridMemoryRetriever(
      new ScopedKeywordMemoryRetriever(repository),
      {
        model: "test-embedding",
        dimensions: EMBEDDING_DIMENSIONS,
        embed,
      },
      store,
    );

    await retriever.retrieve(
      {
        agent: "codex",
        organization: "acme",
        repo: "billing",
        task: "Investigate settlement api_key=super-secret-value",
      },
      { workspaceId },
    );

    expect(embed).toHaveBeenCalledWith(
      expect.stringContaining("[REDACTED:CREDENTIAL]"),
    );
    expect(embed.mock.calls[0]?.[0]).not.toContain("super-secret-value");
  });
});

describe("OpenAI-compatible embedding provider", () => {
  it("rejects malformed embedding dimensions", async () => {
    const provider = new OpenAiCompatibleEmbeddingProvider({
      baseUrl: "https://embedding.test/v1",
      apiKey: "test-key",
      model: "test-model",
      fetch: vi.fn(async () =>
        new Response(
          JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }),
          { status: 200 },
        ),
      ),
    });

    await expect(provider.embed("hello")).rejects.toThrow(
      "1536 finite numbers",
    );
  });
});
