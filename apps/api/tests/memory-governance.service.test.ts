import { describe, expect, it, vi } from "vitest";
import type {
  AuthenticatedWorkspace,
  SharedMemoryEngine,
} from "@lore-co/core";
import type { PostgresPilotRepository } from "@lore-co/database";
import type { ExecutionContext } from "@nestjs/common";
import { SessionAuthGuard } from "../src/common/session-auth.guard.js";
import { MemoryService } from "../src/memory/memory.service.js";
import { EmbeddingIndexerService } from "../src/retrieval/embedding-indexer.service.js";
import { WorkspacePolicyService } from "../src/workspace-policy/workspace-policy.service.js";

const workspace = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  organization: "acme",
  tokenId: "22222222-2222-4222-8222-222222222222",
  credentialType: "session" as const,
  userId: "33333333-3333-4333-8333-333333333333",
  email: "reviewer@example.com",
  workspaceName: "Acme",
} satisfies AuthenticatedWorkspace;

const target = {
  id: "44444444-4444-4444-8444-444444444444",
  workspaceId: workspace.workspaceId,
  content: "Use AccountStore.",
  scope: { organization: "acme", repo: "accounts" },
  category: "convention" as const,
  status: "active" as const,
  source: { agent: "human", workspaceId: workspace.workspaceId },
  fingerprint: "4".repeat(64),
  supersedesMemoryId: null,
  createdAt: "2026-08-18T12:00:00.000Z",
  updatedAt: "2026-08-18T12:00:00.000Z",
  suppressedAt: null,
  deletedAt: null,
};

const proposal = {
  ...target,
  id: "55555555-5555-4555-8555-555555555555",
  content: "Use BillingAccountStore.",
  status: "proposed" as const,
  fingerprint: "5".repeat(64),
  supersedesMemoryId: target.id,
};

function memoryService(engine: Partial<SharedMemoryEngine>) {
  const indexMemories = vi.fn(async () => 1);
  return {
    indexMemories,
    service: new MemoryService(
      engine as SharedMemoryEngine,
      {
        get: vi.fn(async (id, context) =>
          id === target.id && context?.workspaceId === workspace.workspaceId
            ? target
            : null,
        ),
      } as never,
      {} as PostgresPilotRepository,
      { indexMemories } as unknown as EmbeddingIndexerService,
    ),
  };
}

describe("memory governance services", () => {
  it("returns tenant-scoped proposal targets and server-owned review identity", async () => {
    const getProposal = vi.fn(async (_id, context) =>
      context.workspaceId === workspace.workspaceId
        ? {
            memory: proposal,
            metadata: {
              memoryId: proposal.id,
              workspaceId: workspace.workspaceId,
              policyMode: "proposal_only" as const,
              reason: "Review required.",
              provenance: proposal.source,
              proposedAt: proposal.createdAt,
              decision: null,
              reviewerId: null,
              decisionReason: null,
              decidedAt: null,
              decisionTargetMemoryId: null,
            },
            conflicts: [
              {
                id: "66666666-6666-4666-8666-666666666666",
                workspaceId: workspace.workspaceId,
                proposalMemoryId: proposal.id,
                targetMemoryId: target.id,
                detector: "deterministic" as const,
                severity: "blocking" as const,
                evidence: { summary: "Deterministic replacement target." },
                createdAt: proposal.createdAt,
                resolution: null,
                resolvedAt: null,
              },
            ],
          }
        : null,
    );
    const reviewProposal = vi.fn(async (input) => ({
      proposal: {
        ...proposal,
        status: "active" as const,
        scope: input.scope ?? proposal.scope,
      },
      metadata: {
        memoryId: proposal.id,
        workspaceId: workspace.workspaceId,
        policyMode: "proposal_only" as const,
        reason: "Review required.",
        provenance: proposal.source,
        proposedAt: proposal.createdAt,
        decision: input.decision,
        reviewerId: input.reviewerId,
        decisionReason: input.reason,
        decidedAt: "2026-08-18T12:05:00.000Z",
        decisionTargetMemoryId: input.targetMemoryId ?? null,
      },
      conflicts: [],
      supersededMemory: null,
    }));
    const { service, indexMemories } = memoryService({
      getProposal,
      reviewProposal,
    });

    await expect(service.getProposal(proposal.id, workspace)).resolves.toMatchObject({
      memory: { id: proposal.id },
      conflictTargets: [{ id: target.id }],
    });
    await service.reviewProposal(
      proposal.id,
      {
        decision: "use_proposal",
        targetMemoryId: target.id,
        reason: "Authoritative correction.",
        scope: { organization: "other", repo: "accounts" },
      },
      workspace,
    );

    expect(reviewProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalMemoryId: proposal.id,
        reviewerId: workspace.userId,
        scope: { organization: workspace.organization, repo: "accounts" },
      }),
      { workspaceId: workspace.workspaceId },
    );
    expect(indexMemories).toHaveBeenCalledWith([
      expect.objectContaining({ id: proposal.id, status: "active" }),
    ]);
  });

  it("maps repository review details to a safe conflict response", async () => {
    const { service } = memoryService({
      reviewProposal: vi.fn(async () => {
        throw new Error(
          "Conflict target changed during review: internal-database-id",
        );
      }),
    });

    await expect(
      service.reviewProposal(
        proposal.id,
        {
          decision: "use_proposal",
          targetMemoryId: target.id,
          reason: "Use the correction.",
        },
        workspace,
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: "Proposal cannot be resolved with this decision",
    });
  });

  it("rejects connector credentials from session-only governance routes", () => {
    const guard = new SessionAuthGuard();
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          workspace: {
            ...workspace,
            credentialType: "workspace_token",
            userId: undefined,
          },
        }),
      }),
    } as unknown as ExecutionContext;

    expect(() => guard.canActivate(context)).toThrow(
      "An authenticated user session is required",
    );
  });

  it("updates policy only for the authenticated workspace", async () => {
    const updateWorkspaceLearningPolicy = vi.fn(async (workspaceId, update) => ({
      workspaceId,
      ...update,
      learningMode: update.learningMode ?? "trust_tiered",
      llmConflictAnalysisEnabled:
        update.llmConflictAnalysisEnabled ?? false,
      updatedAt: "2026-08-18T12:00:00.000Z",
    }));
    const service = new WorkspacePolicyService({
      updateWorkspaceLearningPolicy,
    } as unknown as SharedMemoryEngine);

    await service.update({ learningMode: "proposal_only" }, workspace);

    expect(updateWorkspaceLearningPolicy).toHaveBeenCalledWith(
      workspace.workspaceId,
      { learningMode: "proposal_only" },
    );
  });

  it("never embeds proposed memories", async () => {
    const embed = vi.fn(async () => Array.from({ length: 1_536 }, () => 0));
    const upsertEmbedding = vi.fn();
    const indexer = new EmbeddingIndexerService(
      {
        model: "test-embedding",
        dimensions: 1_536,
        embed,
      },
      {
        search: vi.fn(),
        upsertEmbedding,
        listNeedingEmbedding: vi.fn(),
      },
    );

    await expect(indexer.indexMemories([proposal])).resolves.toBe(0);
    expect(embed).not.toHaveBeenCalled();
    expect(upsertEmbedding).not.toHaveBeenCalled();
  });
});
