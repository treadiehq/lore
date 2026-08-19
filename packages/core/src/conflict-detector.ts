import {
  AgentTaskSchema,
  DetectedMemoryConflictSchema,
  MemoryConflictAnalysisSchema,
  type DetectedMemoryConflict,
  type Memory,
} from "./schemas.js";
import type {
  MemoryConflictAnalyzer,
  MemoryConflictDetectionInput,
  MemoryConflictDetector,
  MemoryRetriever,
  WorkspaceRepositoryContext,
} from "./ports.js";

function warningKey(conflict: DetectedMemoryConflict): string {
  return `${conflict.targetMemoryId}:${conflict.detector}`;
}

function warning(input: DetectedMemoryConflict): DetectedMemoryConflict {
  return DetectedMemoryConflictSchema.parse(input);
}

export class ScopedMemoryConflictDetector implements MemoryConflictDetector {
  readonly #retriever: MemoryRetriever;
  readonly #analyzer: MemoryConflictAnalyzer | undefined;

  constructor(
    retriever: MemoryRetriever,
    analyzer?: MemoryConflictAnalyzer,
  ) {
    this.#retriever = retriever;
    this.#analyzer = analyzer;
  }

  async detect(
    input: MemoryConflictDetectionInput,
    context: WorkspaceRepositoryContext,
  ): Promise<readonly DetectedMemoryConflict[]> {
    const detected = new Map<string, DetectedMemoryConflict>();
    if (input.deterministicTarget !== undefined) {
      const conflict = warning({
        targetMemoryId: input.deterministicTarget.id,
        detector: "deterministic",
        severity: "blocking",
        evidence: {
          summary:
            "The proposal identifies this memory as its deterministic replacement target.",
          details: {
            ...(input.proposal.reconciliationKey === undefined
              ? {}
              : { reconciliationKey: input.proposal.reconciliationKey }),
          },
        },
      });
      detected.set(warningKey(conflict), conflict);
    }

    const neighbors = await this.#scopedNeighbors(input.proposal, context);
    for (const hit of neighbors) {
      if (hit.memory.id === input.proposal.id) {
        continue;
      }
      if (hit.reasons.includes("lexical")) {
        const conflict = warning({
          targetMemoryId: hit.memory.id,
          detector: "lexical",
          severity: "warning",
          evidence: {
            summary:
              "An active memory in the same effective scope uses overlapping terms.",
            details: {
              matchedTerms: hit.matchedTerms.slice(0, 50),
              score: hit.score,
            },
          },
        });
        detected.set(warningKey(conflict), conflict);
      }
      if (hit.reasons.includes("semantic")) {
        const conflict = warning({
          targetMemoryId: hit.memory.id,
          detector: "semantic",
          severity: "warning",
          evidence: {
            summary:
              "An active memory in the same effective scope is a semantic neighbor.",
            details: {
              score: hit.score,
              semanticRank: hit.semanticRank,
            },
          },
        });
        detected.set(warningKey(conflict), conflict);
      }
    }

    if (
      input.policy.llmConflictAnalysisEnabled &&
      this.#analyzer !== undefined
    ) {
      const targets = new Map<string, Memory>();
      if (input.deterministicTarget !== undefined) {
        targets.set(input.deterministicTarget.id, input.deterministicTarget);
      }
      for (const hit of neighbors) {
        if (hit.memory.id !== input.proposal.id) {
          targets.set(hit.memory.id, hit.memory);
        }
      }
      const analyses = await Promise.allSettled(
        [...targets.values()].map(async (target) => ({
          target,
          analysis: MemoryConflictAnalysisSchema.parse(
            await this.#analyzer?.analyze({
              proposal: input.proposal,
              target,
            }),
          ),
        })),
      );
      for (const result of analyses) {
        if (result.status !== "fulfilled") {
          continue;
        }
        if (result.value.analysis.classification === "not_conflict") {
          continue;
        }
        const conflict = warning({
          targetMemoryId: result.value.target.id,
          detector: "llm",
          severity: "warning",
          evidence: {
            summary: result.value.analysis.explanation,
            details: {
              classification: result.value.analysis.classification,
            },
          },
        });
        detected.set(warningKey(conflict), conflict);
      }
    }

    return [...detected.values()];
  }

  async #scopedNeighbors(
    proposal: Memory,
    context: WorkspaceRepositoryContext,
  ) {
    try {
      return await this.#retriever.retrieve(
        AgentTaskSchema.parse({
          agent: "governance",
          scope: proposal.scope,
          task: proposal.content,
          limit: 10,
        }),
        context,
      );
    } catch {
      return [];
    }
  }
}
