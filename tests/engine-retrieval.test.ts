import { describe, expect, it } from "vitest";
import {
  InMemoryMemoryRepository,
  SharedMemoryEngine,
  type MemoryExtractor,
} from "@lore-co/core";
import { ScopedKeywordMemoryRetriever } from "@lore-co/retrieval";
import { createEngineHarness } from "./helpers.js";

const source = {
  agent: "human",
  sessionId: "manual-session",
};

describe("SharedMemoryEngine persistence semantics", () => {
  it("stores observation provenance and makes duplicate observations idempotent", async () => {
    const { engine } = createEngineHarness();
    const interaction = {
      agent: "claude",
      repo: "payments",
      sessionId: "claude-session-1",
      messages: [
        {
          id: "message-42",
          role: "user" as const,
          content:
            "Never call Stripe directly from API handlers. Use BillingService.",
        },
      ],
    };

    const first = await engine.observe(interaction);
    const duplicate = await engine.observe(interaction);

    expect(first).toMatchObject({ created: 1, duplicates: 0 });
    expect(first.memories[0]?.source).toEqual({
      agent: "claude",
      sessionId: "claude-session-1",
      messageId: "message-42",
      rawText:
        "Never call Stripe directly from API handlers. Use BillingService.",
    });
    expect(duplicate).toMatchObject({ created: 0, duplicates: 1 });
    expect(duplicate.memories[0]?.id).toBe(first.memories[0]?.id);
  });

  it("supports manual remember, list, get, and soft-delete", async () => {
    const { engine } = createEngineHarness();
    const remembered = await engine.remember({
      content: "Account writes must use AccountStore.",
      scope: { organization: "acme", repo: "accounts" },
      category: "convention",
      source,
    });

    expect(remembered.inserted).toBe(true);
    await expect(engine.getMemory(remembered.memory.id)).resolves.toEqual({
      memory: remembered.memory,
    });

    const listed = await engine.listMemories({
      scope: { organization: "acme", repo: "accounts" },
      status: "active",
    });
    expect(listed.total).toBe(1);
    expect(listed.memories[0]?.id).toBe(remembered.memory.id);

    const forgotten = await engine.forget(remembered.memory.id);
    expect(forgotten.memory.status).toBe("deleted");
    expect(forgotten.memory.deletedAt).not.toBeNull();
    await expect(
      engine.listMemories({ status: "active" }),
    ).resolves.toMatchObject({ total: 0, memories: [] });
    expect((await engine.getMemory(remembered.memory.id)).memory?.status).toBe(
      "deleted",
    );
  });

  it("allows deliberately forgotten knowledge to be learned again", async () => {
    const { engine } = createEngineHarness();
    const input = {
      content: "Account writes must use AccountStore.",
      scope: { repo: "accounts" },
      category: "convention" as const,
      source,
    };
    const first = await engine.remember(input);
    await engine.forget(first.memory.id);
    const relearned = await engine.remember(input);

    expect(relearned.inserted).toBe(true);
    expect(relearned.memory.id).not.toBe(first.memory.id);
    expect(relearned.memory.status).toBe("active");
  });

  it("reserves suppressed fingerprints until the learning is forgotten", async () => {
    const { engine, repository } = createEngineHarness();
    const input = {
      content: "Account writes must use AccountStore.",
      scope: { repo: "accounts" },
      category: "convention" as const,
      source,
    };
    const first = await engine.remember(input);
    const suppressedAt = "2026-08-14T20:00:00.000Z";
    await repository.update(first.memory.id, {
      status: "suppressed",
      suppressedAt,
      updatedAt: suppressedAt,
    });

    const duplicate = await engine.remember(input);
    expect(duplicate).toMatchObject({
      inserted: false,
      memory: { id: first.memory.id, status: "suppressed", suppressedAt },
    });

    await engine.forget(first.memory.id);
    const relearned = await engine.remember(input);
    expect(relearned.inserted).toBe(true);
    expect(relearned.memory.id).not.toBe(first.memory.id);
  });

  it("rejects unscoped observations and ignores low-confidence candidates", async () => {
    const lowConfidenceExtractor: MemoryExtractor = {
      async extract() {
        return [
          {
            content: "Transient speculation should not become knowledge.",
            category: "other",
            confidence: 0.4,
          },
        ];
      },
    };
    const repository = new InMemoryMemoryRepository();
    const engine = new SharedMemoryEngine({
      repository,
      extractor: lowConfidenceExtractor,
      retriever: new ScopedKeywordMemoryRetriever(repository),
    });
    const messages = [
      {
        role: "user" as const,
        content: "Always use AccountStore.",
      },
    ];

    await expect(
      engine.observe({ agent: "custom", messages }),
    ).rejects.toThrow(/require.+scope/iu);
    await expect(
      engine.observe({ agent: "custom", repo: "accounts", messages }),
    ).resolves.toMatchObject({ memories: [], created: 0, duplicates: 0 });
  });
});

describe("ScopedKeywordMemoryRetriever", () => {
  it("shares strongly relevant organization-only learning across repositories", async () => {
    const { engine } = createEngineHarness();
    const remembered = await engine.remember({
      content: "All account writes must use AccountStore.",
      scope: { organization: "acme" },
      category: "convention",
      source,
    });

    const context = await engine.getContext({
      agent: "codex",
      organization: "acme",
      repo: "a-different-repository",
      task: "Update an account write using AccountStore",
    });

    expect(context.memories.map(({ id }) => id)).toContain(
      remembered.memory.id,
    );
  });

  it.each(["claude", "codex", "opencode"])(
    "requires strong relevance for organization-only %s retrieval",
    async (agent) => {
      const { engine } = createEngineHarness();
      await engine.remember({
        content: "AccountStore is preferred.",
        scope: { organization: "acme" },
        source,
      });

      await expect(
        engine.getContext({
          agent,
          organization: "acme",
          repo: "billing",
          task: "Update an account endpoint",
        }),
      ).resolves.toMatchObject({ memories: [] });
    },
  );

  it("does not treat generic source paths and extensions as file relevance", async () => {
    const { engine } = createEngineHarness();
    const remembered = await engine.remember({
      content:
        'For src/greeting.ts specifically, set the greeting constant to exactly "Hello from Lore", never "legacy-greeting". Remember that rule for this file.',
      scope: { organization: "acme", repo: "demo" },
      category: "correction",
      source,
    });

    const unrelated = await engine.getContext({
      agent: "codex",
      organization: "acme",
      repo: "demo",
      task: "Inspect only src/unrelated.ts and tell me the exported boolean.",
      files: ["src/unrelated.ts"],
    });
    expect(unrelated.memories).toEqual([]);

    const relevant = await engine.getContext({
      agent: "codex",
      organization: "acme",
      repo: "demo",
      task: "Update src/greeting.ts using the remembered greeting rule.",
      files: ["src/greeting.ts"],
    });
    expect(relevant.memories.map((memory) => memory.id)).toEqual([
      remembered.memory.id,
    ]);
    expect(relevant.hits?.[0]?.matchedTerms).toContain("greeting");
  });

  it("enforces scope and active status while ranking task, diff, and symbol evidence", async () => {
    const { engine, repository } = createEngineHarness();
    const remember = async (
      content: string,
      category: "convention" | "correction" | "behavior",
      repo = "accounts",
    ) =>
      (
        await engine.remember({
          content,
          scope: { organization: "acme", project: "platform", repo },
          category,
          source,
        })
      ).memory;

    const keyword = await remember(
      "Invoice reconciliation runs asynchronously.",
      "behavior",
    );
    const diff = await remember(
      "Stripe customer updates must use BillingService.",
      "correction",
    );
    const symbol = await remember(
      "AccountStore writes require repository transactions.",
      "convention",
    );
    const wrongRepo = await remember(
      "Stripe customer updates may bypass BillingService.",
      "correction",
      "other-repo",
    );
    const deleted = await remember(
      "Stripe customer updates use LegacyStripeGateway.",
      "convention",
    );
    await engine.forget(deleted.id);
    await remember("Documentation is published on Fridays.", "behavior");

    const retriever = new ScopedKeywordMemoryRetriever(repository);
    const scope = {
      organization: "acme",
      project: "platform",
      repo: "accounts",
    };

    const keywordHits = await retriever.retrieve({
      agent: "codex",
      ...scope,
      task: "Investigate invoice reconciliation",
    });
    expect(keywordHits.map((hit) => hit.memory)).toEqual([keyword]);
    const diffHits = await retriever.retrieve({
      agent: "codex",
      ...scope,
      task: "Review this patch",
      diff: "+ await stripe.customers.update(customerId)",
    });
    expect(diffHits.map((hit) => hit.memory)).toEqual([diff]);
    const symbolHits = await retriever.retrieve({
      agent: "claude",
      ...scope,
      task: "Update account persistence",
      symbols: ["AccountStore"],
    });
    expect(symbolHits.map((hit) => hit.memory)).toEqual([symbol]);

    const combined = await retriever.retrieve({
      agent: "codex",
      ...scope,
      task: "Review invoice persistence",
      diff: "+ await stripe.customers.update(customerId)",
      symbols: ["AccountStore"],
      limit: 2,
    });
    expect(new Set(combined.map((hit) => hit.memory.id))).toEqual(
      new Set([diff.id, symbol.id]),
    );
    expect(
      combined.find((hit) => hit.memory.id === diff.id)?.reasons,
    ).toContain("lexical");
    expect(
      combined.find((hit) => hit.memory.id === symbol.id)?.reasons,
    ).toContain("symbol");
    expect(combined.map((hit) => hit.memory)).not.toContainEqual(wrongRepo);
    expect(combined.map((hit) => hit.memory)).not.toContainEqual(deleted);
    expect(combined).toHaveLength(2);
  });

  it("applies path-scoped knowledge to files beneath that path", async () => {
    const { engine } = createEngineHarness();
    const remembered = await engine.remember({
      content: "Stripe API handlers must use BillingService.",
      scope: { repo: "payments", path: "src/api" },
      category: "convention",
      source,
    });

    await expect(
      engine.getContext({
        agent: "codex",
        repo: "payments",
        task: "Review the customer update",
        files: ["src/api/customers.ts"],
        diff: "+ stripe.customers.update(customerId)",
      }),
    ).resolves.toMatchObject({
      memories: [{ id: remembered.memory.id }],
    });
    await expect(
      engine.getContext({
        agent: "codex",
        repo: "payments",
        task: "Review the customer update",
        files: ["src/workers/customers.ts"],
        diff: "+ stripe.customers.update(customerId)",
      }),
    ).resolves.toMatchObject({ memories: [] });
  });

  it("keeps path and symbol signals independent from a large diff", async () => {
    const { engine } = createEngineHarness();
    const pathRule = await engine.remember({
      content: "Generated clients are regenerated instead of edited by hand.",
      scope: { repo: "payments", path: "src/generated" },
      category: "convention",
      source,
    });
    const symbolRule = await engine.remember({
      content: "SettlementCoordinator must preserve idempotent retries.",
      scope: { repo: "payments" },
      category: "convention",
      source,
    });
    const noise = Array.from(
      { length: 500 },
      (_, index) => `+ const unrelatedIdentifier${index} = ${index};`,
    ).join("\n");

    const context = await engine.getContext({
      agent: "codex",
      repo: "payments",
      task: "Review this change",
      files: ["src/generated/client.ts"],
      symbols: ["SettlementCoordinator"],
      diff: noise,
    });

    expect(new Set(context.memories.map((memory) => memory.id))).toEqual(
      new Set([pathRule.memory.id, symbolRule.memory.id]),
    );
    expect(
      context.hits?.find((hit) => hit.memory.id === pathRule.memory.id)
        ?.reasons,
    ).toContain("path");
    expect(
      context.hits?.find((hit) => hit.memory.id === symbolRule.memory.id)
        ?.reasons,
    ).toContain("symbol");
  });
});

describe("memory superseding", () => {
  it("links an active correction, supersedes the old memory, and retrieves only the replacement", async () => {
    const { engine } = createEngineHarness();
    const original = await engine.remember({
      content: "RepositoryFactory creates account repositories.",
      scope: { repo: "accounts" },
      category: "architecture",
      source: { agent: "devin", sessionId: "review-old" },
    });

    const corrected = await engine.correct({
      memoryId: original.memory.id,
      content:
        "RepositoryFactory is deprecated. Use AccountStore for account persistence.",
      source: { agent: "human", sessionId: "correction-1" },
    });

    expect(corrected.memory).toMatchObject({
      status: "active",
      category: "correction",
      supersedesMemoryId: original.memory.id,
    });
    expect(corrected.supersededMemory.status).toBe("superseded");
    expect(
      (await engine.getMemory(original.memory.id)).memory?.status,
    ).toBe("superseded");

    const context = await engine.getContext({
      agent: "claude",
      repo: "accounts",
      task: "Change RepositoryFactory account persistence",
      symbols: ["RepositoryFactory", "AccountStore"],
    });
    expect(context.memories.map((memory) => memory.id)).toEqual([
      corrected.memory.id,
    ]);
    expect(context.memories).not.toContainEqual(corrected.supersededMemory);
  });

  it("redacts correction content and manual source text before storage", async () => {
    const { engine } = createEngineHarness();
    const original = await engine.remember({
      content: "Use the legacy account token.",
      scope: { repo: "accounts" },
      source: { agent: "human", sessionId: "manual-original" },
    });

    const corrected = await engine.correct({
      memoryId: original.memory.id,
      content:
        "Use AccountStore with api_key=super-secret-correction-value.",
      source: {
        agent: "human",
        sessionId: "manual-correction",
        rawText: "password=manual-secret-value",
      },
    });

    expect(corrected.memory.content).toContain("[REDACTED:CREDENTIAL]");
    expect(corrected.memory.source.rawText).toContain(
      "[REDACTED:CREDENTIAL]",
    );
    expect(corrected.memory.source.redacted).toBe(true);
    expect(JSON.stringify(corrected.memory)).not.toContain(
      "super-secret-correction-value",
    );
    expect(JSON.stringify(corrected.memory)).not.toContain(
      "manual-secret-value",
    );
  });
});

describe("memory tenant lifecycle", () => {
  it("keeps fingerprints and lifecycle operations workspace-local", async () => {
    const { engine } = createEngineHarness();
    const firstWorkspace = "11111111-1111-4111-8111-111111111111";
    const secondWorkspace = "22222222-2222-4222-8222-222222222222";
    const input = {
      content: "Use AccountStore for account writes.",
      scope: { organization: "acme", repo: "accounts" },
      source: { agent: "human" },
    };
    const first = await engine.remember({
      ...input,
      source: { ...input.source, workspaceId: firstWorkspace },
    });
    const second = await engine.remember({
      ...input,
      source: { ...input.source, workspaceId: secondWorkspace },
    });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(true);
    expect(first.memory.id).not.toBe(second.memory.id);
    await expect(
      engine.getMemory(first.memory.id, { workspaceId: secondWorkspace }),
    ).resolves.toEqual({ memory: null });
    await expect(
      engine.forget(first.memory.id, { workspaceId: secondWorkspace }),
    ).rejects.toThrow(/memory not found/iu);
    await expect(
      engine.getMemory(first.memory.id, { workspaceId: firstWorkspace }),
    ).resolves.toMatchObject({ memory: { status: "active" } });
  });
});
