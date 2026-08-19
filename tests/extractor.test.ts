import {
  InMemoryMemoryRepository,
  SharedMemoryEngine,
  type AgentInteraction,
} from "@lore-co/core";
import {
  HeuristicMemoryExtractor,
  HybridMemoryExtractor,
  LlmMemoryExtractor,
  createMemoryExtractor,
  parseExtractorMinConfidence,
  type LlmProvider,
  type LlmStructuredRequest,
} from "@lore-co/extractor";
import { ScopedKeywordMemoryRetriever } from "@lore-co/retrieval";
import { describe, expect, it } from "vitest";

class StubLlmProvider implements LlmProvider {
  readonly requests: LlmStructuredRequest[] = [];

  constructor(
    private readonly output: unknown,
    private readonly failure: Error | undefined = undefined,
  ) {}

  async generateStructured<T>(
    request: LlmStructuredRequest,
    schema: { parse(value: unknown): T },
  ): Promise<T> {
    this.requests.push(request);
    if (this.failure !== undefined) {
      throw this.failure;
    }
    return schema.parse(this.output);
  }
}

describe("HeuristicMemoryExtractor", () => {
  const extractor = new HeuristicMemoryExtractor();

  it("normalizes the Stripe teaching exactly", async () => {
    const memories = await extractor.extract({
      agent: "claude",
      repo: "payments",
      messages: [
        {
          id: "stripe-teaching",
          role: "user",
          content:
            "Never call Stripe directly from API handlers. Use BillingService.",
        },
      ],
    });

    expect(memories).toEqual([
      {
        content:
          "API handlers must use BillingService instead of accessing Stripe directly.",
        category: "convention",
        confidence: 0.92,
        triggeringMessageId: "stripe-teaching",
        rawText:
          "Never call Stripe directly from API handlers. Use BillingService.",
        scopeIntent: "repository",
        scopeEvidence: {
          basis: "interaction_repository",
          excerpt: "payments",
        },
      },
    ]);
  });

  it("recognizes and normalizes a RepositoryFactory correction", async () => {
    const memories = await extractor.extract({
      agent: "devin",
      messages: [
        {
          id: "repository-correction",
          role: "user",
          content:
            "No, RepositoryFactory is deprecated. Use AccountStore instead.",
        },
      ],
    });

    expect(memories).toEqual([
      {
        content:
          "RepositoryFactory is deprecated. Use AccountStore instead.",
        category: "correction",
        confidence: 0.92,
        triggeringMessageId: "repository-correction",
        rawText:
          "No, RepositoryFactory is deprecated. Use AccountStore instead.",
      },
    ]);
  });

  it("extracts a durable behavior statement", async () => {
    const memories = await extractor.extract({
      agent: "generic",
      messages: [
        {
          id: "behavior",
          role: "user",
          content: "A missing account maps to HTTP 404.",
        },
      ],
    });

    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      content: "A missing account maps to HTTP 404.",
      category: "behavior",
      triggeringMessageId: "behavior",
    });
  });

  it("emits bounded organization intent only for an explicit wide correction", async () => {
    const rawText =
      "No, this is organization-wide across all repositories: always use AccountStore.";
    const memories = await extractor.extract({
      agent: "claude",
      organization: "acme",
      repo: "accounts",
      messages: [
        {
          role: "assistant",
          content: "Only the accounts repository uses AccountStore.",
        },
        { role: "user", content: rawText },
      ],
    });

    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      category: "correction",
      confirmation: "explicit",
      scopeIntent: "organization",
      scopeEvidence: {
        basis: "explicit_user_statement",
        excerpt: expect.stringMatching(/organization-wide/iu),
      },
    });
    expect(memories[0]?.scopeEvidence?.excerpt.length).toBeLessThanOrEqual(500);
  });

  it("ignores ordinary conversation, task-only requests, and agent claims", async () => {
    const memories = await extractor.extract({
      agent: "codex",
      messages: [
        { role: "user", content: "Thanks, that looks good." },
        {
          role: "user",
          content: "Please update the account endpoint for this task.",
        },
        {
          role: "assistant",
          content: "Always use the internal account cache.",
        },
        {
          role: "user",
          content: "Can you use AccountStore here?",
        },
      ],
    });

    expect(memories).toEqual([]);
  });
});

describe("paired correction heuristics", () => {
  const extractor = new HeuristicMemoryExtractor();

  it.each([
    "Actually, RetryPolicy belongs in the worker.",
    "Nope, RetryPolicy belongs in the worker.",
    "Not exactly, RetryPolicy belongs in the worker.",
    "We stopped keeping RetryPolicy in the API layer.",
    "That is the wrong layer; RetryPolicy belongs in the worker.",
    "Close, but RetryPolicy belongs in the worker.",
  ])("recalls a natural adjacent correction: %s", async (content) => {
    const memories = await extractor.extract({
      agent: "codex",
      messages: [
        {
          role: "assistant",
          content: "RetryPolicy belongs in the API layer.",
        },
        { role: "user", content },
      ],
    });

    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      category: "correction",
      confidence: 0.81,
      confirmation: "explicit",
      supersedesContent: "RetryPolicy belongs in the API layer.",
      reconciliationKey: "RetryPolicy",
    });
  });

  it.each([
    "Actually, can you move RetryPolicy to the worker?",
    "Actually, please run the tests for this task.",
    "Please move RetryPolicy to the worker for this task.",
    "Thanks, the RetryPolicy update looks good.",
  ])("ignores adjacent questions and ordinary task chatter: %s", async (content) => {
    await expect(
      extractor.extract({
        agent: "codex",
        messages: [
          {
            role: "assistant",
            content: "RetryPolicy belongs in the API layer.",
          },
          { role: "user", content },
        ],
      }),
    ).resolves.toEqual([]);
  });

  it("stores natural paired corrections at the engine default threshold", async () => {
    const repository = new InMemoryMemoryRepository();
    const engine = new SharedMemoryEngine({
      repository,
      extractor,
      retriever: new ScopedKeywordMemoryRetriever(repository),
    });

    const observed = await engine.observe({
      agent: "devin",
      repo: "acme/api",
      messages: [
        {
          role: "assistant",
          content: "RetryPolicy belongs in the API layer.",
        },
        {
          role: "user",
          content: "Actually, RetryPolicy belongs in the worker.",
        },
      ],
    });

    expect(observed).toMatchObject({
      created: 1,
      memories: [{ category: "correction", confidence: 0.81 }],
    });
  });

  it.each([
    "RepositoryFactory is deprecated.",
    "No, a missing account maps to HTTP 404.",
  ])("forces explicit adjacent %s wording into correction", async (content) => {
    const memories = await extractor.extract({
      agent: "claude",
      messages: [
        {
          role: "assistant",
          content: "RepositoryFactory remains the account persistence API.",
        },
        { role: "user", content },
      ],
    });

    expect(memories[0]).toMatchObject({
      category: "correction",
      confidence: 0.98,
      confirmation: "explicit",
    });
  });
});

describe("LlmMemoryExtractor", () => {
  it("resolves correction provenance and reconciliation metadata locally", async () => {
    const correction =
      "Nope, wrong layer—RetryPolicy belongs in the worker.";
    const provider = new StubLlmProvider({
      memories: [
        {
          content: "RetryPolicy belongs in the worker.",
          category: "behavior",
          confidence: 0.96,
          triggeringMessageId: "assistant-claim",
          rawText: correction,
        },
      ],
    });
    const extractor = new LlmMemoryExtractor(provider);

    const memories = await extractor.extract({
      agent: "codex",
      messages: [
        { id: "earlier-user", role: "user", content: "Please investigate." },
        {
          id: "assistant-claim",
          role: "assistant",
          content: "RetryPolicy belongs in the API layer.",
        },
        { id: "correcting-user", role: "user", content: correction },
      ],
    });

    expect(memories).toEqual([
      {
        content: "RetryPolicy belongs in the worker.",
        category: "correction",
        confidence: 0.96,
        triggeringMessageId: "correcting-user",
        rawText: correction,
        confirmation: "explicit",
        confirmationReason:
          "The user explicitly corrected the immediately preceding assistant turn.",
        supersedesContent: "RetryPolicy belongs in the API layer.",
        reconciliationKey: "RetryPolicy",
      },
    ]);
  });

  it("rejects model-supplied supersedesMemoryId", async () => {
    const provider = new StubLlmProvider({
      memories: [
        {
          content: "Use AccountStore.",
          category: "correction",
          confidence: 0.95,
          triggeringMessageId: "correction",
          rawText: "No, use AccountStore.",
          supersedesMemoryId: "33170f22-8c2c-45ea-9c97-569504b53f6a",
        },
      ],
    });
    const extractor = new LlmMemoryExtractor(provider);

    await expect(
      extractor.extract({
        agent: "codex",
        messages: [
          {
            id: "correction",
            role: "user",
            content: "No, use AccountStore.",
          },
        ],
      }),
    ).rejects.toThrow();
  });
});

describe("HybridMemoryExtractor", () => {
  const highConfidenceInteraction: AgentInteraction = {
    agent: "claude",
    messages: [
      {
        id: "teaching",
        role: "user",
        content: "Always use AccountStore for account persistence.",
      },
    ],
  };
  const naturalCorrectionInteraction: AgentInteraction = {
    agent: "claude",
    messages: [
      {
        role: "assistant",
        content: "RetryPolicy belongs in the API layer.",
      },
      {
        id: "correction",
        role: "user",
        content: "Actually, RetryPolicy belongs in the worker.",
      },
    ],
  };

  it("bypasses the LLM for high-confidence heuristic candidates", async () => {
    const provider = new StubLlmProvider({ memories: [] });
    const extractor = new HybridMemoryExtractor(
      new HeuristicMemoryExtractor(),
      new LlmMemoryExtractor(provider),
      0.8,
    );

    const memories = await extractor.extract(highConfidenceInteraction);

    expect(memories).toHaveLength(1);
    expect(provider.requests).toHaveLength(0);
  });

  it("bypasses the LLM for natural corrections above the default threshold", async () => {
    const provider = new StubLlmProvider({ memories: [] });
    const extractor = new HybridMemoryExtractor(
      new HeuristicMemoryExtractor(),
      new LlmMemoryExtractor(provider),
      0.8,
    );

    const memories = await extractor.extract(naturalCorrectionInteraction);

    expect(provider.requests).toHaveLength(0);
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      content: "RetryPolicy belongs in the worker.",
      confidence: 0.81,
      category: "correction",
    });
  });

  it("preserves high candidates without routing a high-confidence interaction", async () => {
    const interaction: AgentInteraction = {
      agent: "claude",
      messages: [
        {
          id: "teaching",
          role: "user",
          content: "Always use AccountStore for account persistence.",
        },
        {
          role: "assistant",
          content: "RetryPolicy belongs in the API layer.",
        },
        {
          id: "correction",
          role: "user",
          content: "Actually, RetryPolicy belongs in the worker.",
        },
      ],
    };
    const provider = new StubLlmProvider({
      memories: [
        {
          content: "AccountStore is the persistence abstraction.",
          category: "convention",
          confidence: 0.97,
          triggeringMessageId: "teaching",
          rawText: "Always use AccountStore for account persistence.",
        },
        {
          content: "RetryPolicy belongs in the worker.",
          category: "correction",
          confidence: 0.97,
          triggeringMessageId: "correction",
          rawText: "Actually, RetryPolicy belongs in the worker.",
        },
      ],
    });
    const extractor = new HybridMemoryExtractor(
      new HeuristicMemoryExtractor(),
      new LlmMemoryExtractor(provider),
    );

    const memories = await extractor.extract(interaction);

    expect(provider.requests).toHaveLength(0);
    expect(memories).toHaveLength(2);
    expect(memories.map(({ content }) => content)).toEqual([
      "Always use AccountStore for account persistence.",
      "RetryPolicy belongs in the worker.",
    ]);
  });

  it("invokes one LLM extraction when heuristics are empty", async () => {
    const provider = new StubLlmProvider({ memories: [] });
    const extractor = new HybridMemoryExtractor(
      new HeuristicMemoryExtractor(),
      new LlmMemoryExtractor(provider),
    );

    await expect(
      extractor.extract({
        agent: "codex",
        messages: [{ role: "user", content: "Thanks for the update." }],
      }),
    ).resolves.toEqual([]);
    expect(provider.requests).toHaveLength(1);
  });

  it("returns heuristic candidates when the LLM fails", async () => {
    const provider = new StubLlmProvider(
      undefined,
      new Error("provider unavailable"),
    );
    const heuristic = {
      async extract(_interaction: AgentInteraction) {
        return [
          {
            content: "A tentative routed candidate.",
            category: "other" as const,
            confidence: 0.65,
          },
        ];
      },
    };
    const extractor = new HybridMemoryExtractor(
      heuristic,
      new LlmMemoryExtractor(provider),
    );
    const expected = await heuristic.extract(naturalCorrectionInteraction);

    await expect(
      extractor.extract(naturalCorrectionInteraction),
    ).resolves.toEqual(expected);
    expect(provider.requests).toHaveLength(1);
  });
});

describe("extractor environment", () => {
  it("parses the shared confidence threshold", () => {
    expect(parseExtractorMinConfidence({})).toBe(0.8);
    expect(
      parseExtractorMinConfidence({ EXTRACTOR_MIN_CONFIDENCE: " 0.73 " }),
    ).toBe(0.73);
    expect(() =>
      parseExtractorMinConfidence({ EXTRACTOR_MIN_CONFIDENCE: "1.1" }),
    ).toThrow("EXTRACTOR_MIN_CONFIDENCE must be a number from 0 to 1");
    expect(() =>
      parseExtractorMinConfidence({ EXTRACTOR_MIN_CONFIDENCE: "not-a-number" }),
    ).toThrow("EXTRACTOR_MIN_CONFIDENCE must be a number from 0 to 1");
  });

  it("creates hybrid while preserving existing provider modes", () => {
    expect(createMemoryExtractor({})).toBeInstanceOf(HeuristicMemoryExtractor);
    expect(
      createMemoryExtractor({
        EXTRACTOR_PROVIDER: "openai-compatible",
        EXTRACTOR_BASE_URL: "https://example.test",
        EXTRACTOR_API_KEY: "test-key",
        EXTRACTOR_MODEL: "test-model",
      }),
    ).toBeInstanceOf(LlmMemoryExtractor);
    expect(
      createMemoryExtractor({
        EXTRACTOR_PROVIDER: "hybrid",
        EXTRACTOR_BASE_URL: "https://example.test",
        EXTRACTOR_API_KEY: "test-key",
        EXTRACTOR_MODEL: "test-model",
        EXTRACTOR_MIN_CONFIDENCE: "0.9",
      }),
    ).toBeInstanceOf(HybridMemoryExtractor);
  });
});
