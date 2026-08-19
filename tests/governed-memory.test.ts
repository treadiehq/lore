import { describe, expect, it, vi } from "vitest";
import {
  InMemoryMemoryRepository,
  ScopedMemoryConflictDetector,
  SharedMemoryEngine,
} from "@lore-co/core";
import { HeuristicMemoryExtractor } from "@lore-co/extractor";
import { ScopedKeywordMemoryRetriever } from "@lore-co/retrieval";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "22222222-2222-4222-8222-222222222222";

function createGovernedHarness(): {
  engine: SharedMemoryEngine;
  repository: InMemoryMemoryRepository;
} {
  const repository = new InMemoryMemoryRepository();
  return {
    repository,
    engine: new SharedMemoryEngine({
      repository,
      extractor: new HeuristicMemoryExtractor(),
      retriever: new ScopedKeywordMemoryRetriever(repository),
    }),
  };
}

describe("governed memory lifecycle", () => {
  it("persists workspace policy and keeps inferred proposals inactive", async () => {
    const { engine } = createGovernedHarness();

    await expect(
      engine.getWorkspaceLearningPolicy(workspaceId),
    ).resolves.toMatchObject({
      workspaceId,
      learningMode: "trust_tiered",
      llmConflictAnalysisEnabled: false,
    });
    await expect(
      engine.updateWorkspaceLearningPolicy(workspaceId, {
        llmConflictAnalysisEnabled: true,
      }),
    ).resolves.toMatchObject({
      workspaceId,
      learningMode: "trust_tiered",
      llmConflictAnalysisEnabled: true,
    });

    const interaction = {
      agent: "codex",
      workspaceId,
      repo: "accounts",
      sessionId: "proposal-session",
      messages: [
        {
          id: "proposal-message",
          role: "user" as const,
          content: "Always route LedgerBatch writes through LedgerStore.",
        },
      ],
    };
    const first = await engine.observe(interaction);
    const duplicate = await engine.observe(interaction);

    expect(first).toMatchObject({
      created: 1,
      memories: [{ status: "proposed" }],
    });
    expect(duplicate).toMatchObject({
      created: 0,
      duplicates: 1,
      memories: [{ id: first.memories[0]?.id, status: "proposed" }],
    });
    await expect(
      engine.getContext(
        {
          agent: "codex",
          repo: "accounts",
          task: "Update LedgerBatch persistence through LedgerStore",
          symbols: ["LedgerBatch", "LedgerStore"],
        },
        { workspaceId },
      ),
    ).resolves.toMatchObject({ memories: [] });
    await expect(
      engine.getProposal(first.memories[0]!.id, { workspaceId }),
    ).resolves.toMatchObject({
      memory: { status: "proposed" },
      metadata: {
        policyMode: "trust_tiered",
        decision: null,
        provenance: {
          agent: "codex",
          sessionId: "proposal-session",
          messageId: "proposal-message",
        },
      },
      conflicts: [],
    });
    await expect(
      engine.getProposal(first.memories[0]!.id, {
        workspaceId: otherWorkspaceId,
      }),
    ).resolves.toBeNull();
    await expect(
      engine.reviewProposal(
        {
          proposalMemoryId: first.memories[0]!.id,
          decision: "approve",
          reviewerId: "reviewer",
          reason: "The convention is durable and correctly scoped.",
        },
        { workspaceId },
      ),
    ).resolves.toMatchObject({
      proposal: { status: "active" },
      metadata: { decision: "approve" },
      supersededMemory: null,
    });
    await expect(
      engine.getContext(
        {
          agent: "codex",
          repo: "accounts",
          task: "Update LedgerBatch persistence through LedgerStore",
          symbols: ["LedgerBatch", "LedgerStore"],
        },
        { workspaceId },
      ),
    ).resolves.toMatchObject({
      memories: [{ id: first.memories[0]?.id, status: "active" }],
    });
  });

  it("atomically uses a proposal to replace its deterministic target", async () => {
    const { engine } = createGovernedHarness();
    const original = await engine.remember({
      content: "RepositoryFactory handles account persistence.",
      scope: { repo: "accounts" },
      category: "architecture",
      source: { agent: "human", workspaceId },
    });
    await engine.updateWorkspaceLearningPolicy(workspaceId, {
      learningMode: "proposal_only",
    });

    const observed = await engine.observe({
      agent: "devin",
      workspaceId,
      repo: "accounts",
      messages: [
        {
          role: "assistant",
          content: "RepositoryFactory handles account persistence.",
        },
        {
          role: "user",
          content:
            "No, RepositoryFactory is deprecated. Use AccountStore instead.",
        },
      ],
    });
    const proposal = observed.memories[0]!;
    expect(proposal).toMatchObject({
      status: "proposed",
      supersedesMemoryId: original.memory.id,
    });
    await expect(
      engine.getProposal(proposal.id, { workspaceId }),
    ).resolves.toMatchObject({
      metadata: { policyMode: "proposal_only", decision: null },
      conflicts: expect.arrayContaining([
        expect.objectContaining({
          targetMemoryId: original.memory.id,
          detector: "deterministic",
          severity: "blocking",
          resolution: null,
        }),
      ]),
    });
    await expect(
      engine.reviewProposal(
        {
          proposalMemoryId: proposal.id,
          decision: "approve",
          reviewerId: "reviewer",
          reason: "Approve directly",
        },
        { workspaceId },
      ),
    ).rejects.toThrow(/blocked proposals/iu);
    await expect(
      engine.reviewProposal(
        {
          proposalMemoryId: proposal.id,
          decision: "reject",
          reviewerId: "other-tenant-reviewer",
          reason: "Wrong tenant",
        },
        { workspaceId: otherWorkspaceId },
      ),
    ).rejects.toThrow(/proposal not found/iu);

    const decisions = await Promise.allSettled([
      engine.reviewProposal(
        {
          proposalMemoryId: proposal.id,
          decision: "use_proposal",
          targetMemoryId: original.memory.id,
          reviewerId: "reviewer",
          reason: "The correction is authoritative.",
        },
        { workspaceId },
      ),
      engine.reviewProposal(
        {
          proposalMemoryId: proposal.id,
          decision: "reject",
          reviewerId: "second-reviewer",
          reason: "A concurrent second decision.",
        },
        { workspaceId },
      ),
    ]);

    expect(decisions.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(decisions.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    await expect(
      engine.getProposal(proposal.id, { workspaceId }),
    ).resolves.toMatchObject({
      memory: {
        status: "active",
        supersedesMemoryId: original.memory.id,
      },
      metadata: {
        decision: "use_proposal",
        reviewerId: "reviewer",
        decisionTargetMemoryId: original.memory.id,
      },
      conflicts: expect.arrayContaining([
        expect.objectContaining({ resolution: "use_proposal" }),
      ]),
    });
    await expect(
      engine.getMemory(original.memory.id, { workspaceId }),
    ).resolves.toMatchObject({ memory: { status: "superseded" } });
  });

  it("supports keep-both and reject while releasing rejected fingerprints", async () => {
    const { engine } = createGovernedHarness();
    const target = await engine.remember({
      content: "BillingStore owns invoice writes.",
      scope: { repo: "billing" },
      source: { agent: "human", workspaceId },
    });
    const keepCandidate = await engine.observe({
      agent: "codex",
      workspaceId,
      repo: "billing",
      messages: [
        {
          role: "user",
          content: "Always use LedgerStore for ledger writes.",
        },
      ],
    });
    const keepProposal = keepCandidate.memories[0]!;
    await engine.recordProposalConflict(
      {
        proposalMemoryId: keepProposal.id,
        targetMemoryId: target.memory.id,
        detector: "lexical",
        severity: "warning",
        evidence: { summary: "Both memories describe persistence ownership." },
      },
      { workspaceId },
    );
    await expect(
      engine.reviewProposal(
        {
          proposalMemoryId: keepProposal.id,
          decision: "keep_both",
          reviewerId: "reviewer",
          reason: "The memories apply to different domains.",
        },
        { workspaceId },
      ),
    ).resolves.toMatchObject({
      proposal: { status: "active", supersedesMemoryId: null },
      metadata: { decision: "keep_both" },
      conflicts: expect.arrayContaining([
        expect.objectContaining({ resolution: "keep_both" }),
      ]),
      supersededMemory: null,
    });

    const rejectInteraction = {
      agent: "codex",
      workspaceId,
      repo: "billing",
      messages: [
        {
          role: "user" as const,
          content: "Always store transient invoice drafts in LegacyCache.",
        },
      ],
    };
    const rejected = await engine.observe(rejectInteraction);
    await expect(
      engine.reviewProposal(
        {
          proposalMemoryId: rejected.memories[0]!.id,
          decision: "reject",
          reviewerId: "reviewer",
          reason: "This is transient task state.",
        },
        { workspaceId },
      ),
    ).resolves.toMatchObject({
      proposal: { status: "deleted" },
      metadata: { decision: "reject" },
    });
    const reproposed = await engine.observe(rejectInteraction);
    expect(reproposed).toMatchObject({
      created: 1,
      memories: [{ status: "proposed" }],
    });
    expect(reproposed.memories[0]?.id).not.toBe(rejected.memories[0]?.id);
  });
});

describe("deterministic-first conflict detection", () => {
  it("records lexical and optional LLM warnings without making them blockers", async () => {
    const repository = new InMemoryMemoryRepository();
    const retriever = new ScopedKeywordMemoryRetriever(repository);
    const analyze = vi.fn(async () => ({
      classification: "conflict" as const,
      explanation:
        "Both statements assign account persistence ownership. api_key=super-secret-value",
    }));
    const engine = new SharedMemoryEngine({
      repository,
      extractor: new HeuristicMemoryExtractor(),
      retriever,
      conflictDetector: new ScopedMemoryConflictDetector(retriever, {
        analyze,
      }),
    });
    await engine.remember({
      content: "AccountStore handles account persistence.",
      scope: { repo: "accounts" },
      source: { agent: "human", workspaceId },
    });
    await engine.updateWorkspaceLearningPolicy(workspaceId, {
      llmConflictAnalysisEnabled: true,
    });

    const observed = await engine.observe({
      agent: "codex",
      workspaceId,
      repo: "accounts",
      messages: [
        {
          role: "user",
          content: "Always route account persistence through AccountStore.",
        },
      ],
    });
    const proposal = await engine.getProposal(observed.memories[0]!.id, {
      workspaceId,
    });

    expect(analyze).toHaveBeenCalledOnce();
    expect(proposal?.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detector: "lexical",
          severity: "warning",
        }),
        expect.objectContaining({
          detector: "llm",
          severity: "warning",
          evidence: expect.objectContaining({
            summary: expect.stringContaining("[REDACTED:CREDENTIAL]"),
          }),
        }),
      ]),
    );
    await expect(
      engine.reviewProposal(
        {
          proposalMemoryId: observed.memories[0]!.id,
          decision: "approve",
          reviewerId: "reviewer",
          reason: "The warning is related but not contradictory.",
        },
        { workspaceId },
      ),
    ).resolves.toMatchObject({ proposal: { status: "active" } });
  });

  it("fails open when optional LLM analysis is unavailable", async () => {
    const repository = new InMemoryMemoryRepository();
    const retriever = new ScopedKeywordMemoryRetriever(repository);
    const analyze = vi.fn(async () => {
      throw new Error("model unavailable");
    });
    const engine = new SharedMemoryEngine({
      repository,
      extractor: new HeuristicMemoryExtractor(),
      retriever,
      conflictDetector: new ScopedMemoryConflictDetector(retriever, {
        analyze,
      }),
    });
    await engine.remember({
      content: "LedgerStore handles ledger persistence.",
      scope: { repo: "ledger" },
      source: { agent: "human", workspaceId },
    });
    await engine.updateWorkspaceLearningPolicy(workspaceId, {
      llmConflictAnalysisEnabled: true,
    });

    const observed = await engine.observe({
      agent: "codex",
      workspaceId,
      repo: "ledger",
      messages: [
        {
          role: "user",
          content: "Always route ledger persistence through LedgerStore.",
        },
      ],
    });
    const proposal = await engine.getProposal(observed.memories[0]!.id, {
      workspaceId,
    });

    expect(analyze).toHaveBeenCalledOnce();
    expect(proposal?.conflicts).toEqual([
      expect.objectContaining({
        detector: "lexical",
        severity: "warning",
      }),
    ]);
  });

  it("does not record model analysis that finds no conflict", async () => {
    const repository = new InMemoryMemoryRepository();
    const retriever = new ScopedKeywordMemoryRetriever(repository);
    const engine = new SharedMemoryEngine({
      repository,
      extractor: new HeuristicMemoryExtractor(),
      retriever,
      conflictDetector: new ScopedMemoryConflictDetector(retriever, {
        async analyze() {
          return {
            classification: "not_conflict",
            explanation: "The statements are compatible.",
          };
        },
      }),
    });
    await engine.remember({
      content: "AccountStore handles account persistence.",
      scope: { repo: "accounts" },
      source: { agent: "human", workspaceId },
    });
    await engine.updateWorkspaceLearningPolicy(workspaceId, {
      llmConflictAnalysisEnabled: true,
    });

    const observed = await engine.observe({
      agent: "codex",
      workspaceId,
      repo: "accounts",
      messages: [
        {
          role: "user",
          content: "Always route account persistence through AccountStore.",
        },
      ],
    });
    const proposal = await engine.getProposal(observed.memories[0]!.id, {
      workspaceId,
    });

    expect(proposal?.conflicts).toEqual([
      expect.objectContaining({ detector: "lexical" }),
    ]);
  });

  it("records scoped semantic neighbors as warnings", async () => {
    const { engine } = createGovernedHarness();
    const target = (
      await engine.remember({
        content: "Account writes pass through AccountStore.",
        scope: { repo: "accounts" },
        source: { agent: "human", workspaceId },
      })
    ).memory;
    const proposal = {
      ...target,
      id: "33333333-3333-4333-8333-333333333333",
      content: "The account persistence boundary is AccountStore.",
      status: "proposed" as const,
      fingerprint: "3".repeat(64),
    };
    const detector = new ScopedMemoryConflictDetector({
      async retrieve() {
        return [
          {
            memory: target,
            score: 0.9,
            reasons: ["semantic" as const],
            matchedTerms: [],
            lexicalRank: null,
            semanticRank: 1,
          },
        ];
      },
    });

    await expect(
      detector.detect(
        {
          proposal,
          policy: {
            workspaceId,
            learningMode: "proposal_only",
            llmConflictAnalysisEnabled: false,
            updatedAt: "2026-08-18T12:00:00.000Z",
          },
        },
        { workspaceId },
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        targetMemoryId: target.id,
        detector: "semantic",
        severity: "warning",
      }),
    ]);
  });
});

describe("candidate scope policy", () => {
  it("does not widen uncertain candidates when repository evidence is absent", async () => {
    const { engine } = createGovernedHarness();

    await expect(
      engine.observe({
        agent: "codex",
        workspaceId,
        organization: "acme",
        messages: [
          {
            role: "user",
            content: "Always route LedgerBatch writes through LedgerStore.",
          },
        ],
      }),
    ).resolves.toMatchObject({
      memories: [],
      created: 0,
      duplicates: 0,
    });
  });

  it("defaults inferred candidates to repository scope and supports review promotion", async () => {
    const { engine } = createGovernedHarness();
    const observed = await engine.observe({
      agent: "codex",
      workspaceId,
      organization: "acme",
      repo: "accounts",
      path: "src/accounts/store.ts",
      messages: [
        {
          role: "user",
          content: "Always route LedgerBatch writes through LedgerStore.",
        },
      ],
    });
    const proposal = observed.memories[0]!;

    expect(proposal).toMatchObject({
      status: "proposed",
      scope: { organization: "acme", repo: "accounts" },
    });
    expect(proposal.scope).not.toHaveProperty("path");

    await expect(
      engine.reviewProposal(
        {
          proposalMemoryId: proposal.id,
          decision: "approve",
          reviewerId: "reviewer",
          reason: "This convention applies across the organization.",
          scope: { organization: "acme" },
        },
        { workspaceId },
      ),
    ).resolves.toMatchObject({
      proposal: {
        status: "active",
        scope: { organization: "acme" },
      },
    });
    await expect(
      engine.getContext(
        {
          agent: "claude",
          organization: "acme",
          repo: "billing",
          task: "Update LedgerBatch writes through LedgerStore",
        },
        { workspaceId },
      ),
    ).resolves.toMatchObject({ memories: [{ id: proposal.id }] });
  });

  it("allows clear explicit organization-wide corrections across repositories", async () => {
    const { engine } = createGovernedHarness();
    const observed = await engine.observe({
      agent: "claude",
      workspaceId,
      organization: "acme",
      repo: "accounts",
      messages: [
        {
          role: "assistant",
          content: "AccountStore is only used by the accounts repository.",
        },
        {
          role: "user",
          content:
            "No, this is organization-wide across all repositories: always use AccountStore for account writes.",
        },
      ],
    });

    expect(observed).toMatchObject({
      created: 1,
      memories: [
        {
          status: "active",
          category: "correction",
          scope: { organization: "acme" },
        },
      ],
    });
    expect(observed.memories[0]?.scope).not.toHaveProperty("repo");
    await expect(
      engine.getContext(
        {
          agent: "codex",
          organization: "acme",
          repo: "billing",
          task: "Change AccountStore account writes",
        },
        { workspaceId },
      ),
    ).resolves.toMatchObject({
      memories: [{ id: observed.memories[0]?.id }],
    });
  });

  it("inherits the reconciled target scope instead of candidate task scope", async () => {
    const { engine } = createGovernedHarness();
    const target = await engine.remember({
      content: "RepositoryFactory handles account persistence.",
      scope: {
        organization: "acme",
        repo: "accounts",
        path: "src/accounts",
      },
      source: { agent: "human", workspaceId },
    });
    const observed = await engine.observe({
      agent: "codex",
      workspaceId,
      organization: "acme",
      repo: "accounts",
      path: "src/accounts/store.ts",
      messages: [
        {
          role: "assistant",
          content: "RepositoryFactory handles account persistence.",
        },
        {
          role: "user",
          content:
            "No, RepositoryFactory is deprecated. Use AccountStore instead.",
        },
      ],
    });

    expect(observed.memories[0]).toMatchObject({
      status: "proposed",
      supersedesMemoryId: target.memory.id,
      scope: target.memory.scope,
    });
  });

  it("ignores unsupported organization intent evidence and keeps repository scope", async () => {
    const repository = new InMemoryMemoryRepository();
    const engine = new SharedMemoryEngine({
      repository,
      extractor: {
        async extract() {
          return [
            {
              content: "Account writes use AccountStore.",
              category: "correction" as const,
              confidence: 1,
              confirmation: "explicit" as const,
              rawText: "No, account writes use AccountStore.",
              scopeIntent: "organization" as const,
              scopeEvidence: {
                basis: "explicit_user_statement" as const,
                excerpt: "This is organization-wide.",
              },
            },
          ];
        },
      },
      retriever: new ScopedKeywordMemoryRetriever(repository),
    });

    const observed = await engine.observe({
      agent: "codex",
      organization: "acme",
      repo: "accounts",
      path: "src/accounts",
      messages: [
        {
          role: "user",
          content: "No, account writes use AccountStore.",
        },
      ],
    });

    expect(observed.memories[0]?.scope).toEqual({
      organization: "acme",
      repo: "accounts",
    });
  });
});
