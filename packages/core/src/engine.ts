import { createHash, randomUUID } from "node:crypto";
import {
  AgentInteractionSchema,
  AgentTaskSchema,
  CandidateMemorySchema,
  CorrectMemoryDtoSchema,
  CreateMemoryDtoSchema,
  ForgetMemoryDtoSchema,
  GetMemoryDtoSchema,
  ListMemoriesDtoSchema,
  MemoryConflictSchema,
  MemorySchema,
  normalizeInteractionScope,
  ProposalMetadataSchema,
  RecordProposalConflictDtoSchema,
  ReviewProposalDtoSchema,
  UpdateWorkspaceLearningPolicySchema,
  WorkspaceLearningPolicySchema,
  type AgentInteraction,
  type AgentTask,
  type CandidateMemory,
  type CorrectMemoryDto,
  type CorrectMemoryResponse,
  type CreateMemoryDto,
  type ForgetMemoryDto,
  type ForgetMemoryResponse,
  type GetContextResponse,
  type GetMemoryDto,
  type GetMemoryResponse,
  type ListMemoriesDto,
  type ListMemoriesResponse,
  type Memory,
  type MemoryCategory,
  type MemoryConflict,
  type MemoryScope,
  type MemorySource,
  type ObserveResponse,
  type ProposalRecord,
  type RecordProposalConflictDto,
  type RememberResponse,
  type ReviewProposalDto,
  type ReviewProposalResponse,
  type UpdateWorkspaceLearningPolicy,
  type WorkspaceLearningPolicy,
} from "./schemas.js";
import type { ConfirmationLevel } from "./pilot-schemas.js";
import { redactSensitiveText, redactUnknown } from "./redaction.js";
import type {
  MemoryConflictDetector,
  MemoryExtractor,
  MemoryRepository,
  MemoryRetriever,
  RepositoryContext,
  WorkspaceRepositoryContext,
} from "./ports.js";
import { ScopedMemoryConflictDetector } from "./conflict-detector.js";

export interface SharedMemoryEngineDependencies {
  repository: MemoryRepository;
  extractor: MemoryExtractor;
  retriever: MemoryRetriever;
  conflictDetector?: MemoryConflictDetector;
  minimumConfidence?: number;
}

function normalizedContent(content: string): string {
  return content.trim().replace(/\s+/gu, " ");
}

function normalizedComparison(content: string): string {
  return normalizedContent(content).normalize("NFKC").toLocaleLowerCase();
}

const RECONCILIATION_STOP_WORDS = new Set([
  "about",
  "always",
  "from",
  "instead",
  "must",
  "never",
  "should",
  "that",
  "the",
  "this",
  "use",
  "with",
]);

function reconciliationTokens(content: string): string[] {
  return [
    ...new Set(
      (content.normalize("NFKC").match(/[\p{L}\p{N}_-]+/gu) ?? [])
        .map((token) => token.toLocaleLowerCase())
        .filter(
          (token) =>
            token.length >= 3 && !RECONCILIATION_STOP_WORDS.has(token),
        ),
    ),
  ];
}

function tokenOverlap(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const rightSet = new Set(right);
  return left.filter((token) => rightSet.has(token)).length / left.length;
}

const ORGANIZATION_SCOPE_SIGNAL =
  /\b(?:(?:organization|org|team|company)[ -]wide|across\s+(?:the\s+)?(?:entire\s+|whole\s+)?(?:organization|org|team|company)|across\s+(?:all|every)\s+(?:repositories|repos)|(?:all|every)\s+(?:repositories|repos))\b/iu;

function isExplicitOrganizationCandidate(
  candidate: CandidateMemory,
): boolean {
  if (
    candidate.category !== "correction" ||
    candidate.confirmation !== "explicit" ||
    candidate.scopeIntent !== "organization" ||
    candidate.scopeEvidence?.basis !== "explicit_user_statement"
  ) {
    return false;
  }
  const rawText = candidate.rawText;
  if (rawText === undefined) {
    return false;
  }
  const evidence = candidate.scopeEvidence.excerpt;
  return (
    normalizedComparison(rawText).includes(normalizedComparison(evidence)) &&
    ORGANIZATION_SCOPE_SIGNAL.test(evidence)
  );
}

function resolveCandidateScope(
  taskScope: MemoryScope,
  candidate: CandidateMemory,
  reconciliationTarget?: Memory,
): MemoryScope | undefined {
  if (reconciliationTarget !== undefined) {
    return reconciliationTarget.scope;
  }
  if (
    isExplicitOrganizationCandidate(candidate) &&
    taskScope.organization !== undefined
  ) {
    return { organization: taskScope.organization };
  }
  if (taskScope.repo === undefined) {
    return undefined;
  }
  return {
    ...(taskScope.organization === undefined
      ? {}
      : { organization: taskScope.organization }),
    repo: taskScope.repo,
  };
}

export function createMemoryFingerprint(input: {
  content: string;
  scope: MemoryScope;
  category: MemoryCategory;
  supersedesMemoryId?: string | null;
}): string {
  const canonical = JSON.stringify([
    normalizedContent(input.content).normalize("NFKC"),
    input.category,
    input.scope.organization ?? null,
    input.scope.project ?? null,
    input.scope.repo ?? null,
    input.scope.path ?? null,
    input.scope.component ?? null,
    input.supersedesMemoryId ?? null,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

function createMemory(input: {
  workspaceId?: string;
  content: string;
  scope: MemoryScope;
  category: MemoryCategory;
  source: MemorySource;
  confidence?: number;
  confirmation?: ConfirmationLevel;
  reconciliationKey?: string;
  supersedesMemoryId?: string | null;
  status?: "active" | "proposed";
  timestamp?: string;
}): Memory {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const supersedesMemoryId = input.supersedesMemoryId ?? null;
  return MemorySchema.parse({
    id: randomUUID(),
    ...(input.workspaceId === undefined
      ? {}
      : { workspaceId: input.workspaceId }),
    content: normalizedContent(input.content),
    scope: input.scope,
    category: input.category,
    status: input.status ?? "active",
    source: input.source,
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
    ...(input.confirmation === undefined
      ? {}
      : { confirmation: input.confirmation }),
    ...(input.reconciliationKey === undefined
      ? {}
      : { reconciliationKey: input.reconciliationKey }),
    fingerprint: createMemoryFingerprint({
      content: input.content,
      scope: input.scope,
      category: input.category,
      supersedesMemoryId,
    }),
    supersedesMemoryId,
    createdAt: timestamp,
    updatedAt: timestamp,
    suppressedAt: null,
    deletedAt: null,
  });
}

async function findEquivalentMemory(
  repository: MemoryRepository,
  scope: MemoryScope,
  candidate: CandidateMemory,
  workspaceId?: string,
): Promise<Memory | undefined> {
  const content = normalizedComparison(candidate.content);
  const matches = await repository.findActiveScopeCandidates(scope, {
    ...(workspaceId === undefined ? {} : { workspaceId }),
    keywords: reconciliationTokens(candidate.content),
    limit: 100,
  });
  return matches.find(
    (memory) => normalizedComparison(memory.content) === content,
  );
}

async function findReconciliationTarget(
  repository: MemoryRepository,
  scope: MemoryScope,
  candidate: CandidateMemory,
  workspaceId?: string,
): Promise<Memory | undefined> {
  if (
    candidate.category !== "correction" ||
    candidate.confirmation !== "explicit" ||
    candidate.reconciliationKey === undefined
  ) {
    return undefined;
  }

  const keyTokens = reconciliationTokens(candidate.reconciliationKey);
  if (keyTokens.length === 0) {
    return undefined;
  }
  const previousTokens =
    candidate.supersedesContent === undefined
      ? []
      : reconciliationTokens(candidate.supersedesContent);
  const matches = await repository.findActiveScopeCandidates(scope, {
    ...(workspaceId === undefined ? {} : { workspaceId }),
    keywords: [...new Set([...keyTokens, ...previousTokens])],
    limit: 100,
  });
  const replacement = normalizedComparison(candidate.content);

  return matches
    .filter((memory) => normalizedComparison(memory.content) !== replacement)
    .map((memory) => {
      const memoryTokens = reconciliationTokens(memory.content);
      const keyScore = tokenOverlap(keyTokens, memoryTokens);
      const previousScore = tokenOverlap(previousTokens, memoryTokens);
      return {
        memory,
        score: keyScore * 2 + previousScore,
      };
    })
    .filter(({ score }) => score >= 1)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.memory.updatedAt.localeCompare(left.memory.updatedAt),
    )[0]?.memory;
}

function redactInteraction(interaction: AgentInteraction): {
  interaction: AgentInteraction;
  redactedMessageIds: Set<string>;
} {
  const redactedMessageIds = new Set<string>();
  const messages = interaction.messages.map((message, index) => {
    const result = redactSensitiveText(message.content);
    if (result.redacted) {
      redactedMessageIds.add(message.id ?? `index:${index}`);
    }
    return { ...message, content: result.text };
  });
  return {
    interaction: AgentInteractionSchema.parse({ ...interaction, messages }),
    redactedMessageIds,
  };
}

export class SharedMemoryEngine {
  readonly #repository: MemoryRepository;
  readonly #extractor: MemoryExtractor;
  readonly #retriever: MemoryRetriever;
  readonly #conflictDetector: MemoryConflictDetector;
  readonly #minimumConfidence: number;

  constructor(dependencies: SharedMemoryEngineDependencies);
  constructor(
    repository: MemoryRepository,
    extractor: MemoryExtractor,
    retriever: MemoryRetriever,
  );
  constructor(
    dependenciesOrRepository:
      | SharedMemoryEngineDependencies
      | MemoryRepository,
    extractor?: MemoryExtractor,
    retriever?: MemoryRetriever,
  ) {
    if (
      "repository" in dependenciesOrRepository &&
      "extractor" in dependenciesOrRepository &&
      "retriever" in dependenciesOrRepository
    ) {
      this.#repository = dependenciesOrRepository.repository;
      this.#extractor = dependenciesOrRepository.extractor;
      this.#retriever = dependenciesOrRepository.retriever;
      this.#conflictDetector =
        dependenciesOrRepository.conflictDetector ??
        new ScopedMemoryConflictDetector(dependenciesOrRepository.retriever);
      this.#minimumConfidence = Math.min(
        Math.max(dependenciesOrRepository.minimumConfidence ?? 0.8, 0),
        1,
      );
      return;
    }

    if (extractor === undefined || retriever === undefined) {
      throw new Error(
        "SharedMemoryEngine requires a repository, extractor, and retriever",
      );
    }
    this.#repository = dependenciesOrRepository;
    this.#extractor = extractor;
    this.#retriever = retriever;
    this.#conflictDetector = new ScopedMemoryConflictDetector(retriever);
    this.#minimumConfidence = 0.8;
  }

  async observe(interactionInput: AgentInteraction): Promise<ObserveResponse> {
    const parsedInteraction = AgentInteractionSchema.parse(interactionInput);
    const {
      interaction,
      redactedMessageIds,
    } = redactInteraction(parsedInteraction);
    const scope = normalizeInteractionScope(interaction);
    if (Object.keys(scope).length === 0) {
      throw new Error(
        "Observed learnings require an organization, project, repository, path, or component scope",
      );
    }
    const workspacePolicy =
      interaction.workspaceId === undefined
        ? undefined
        : await this.#repository.getWorkspaceLearningPolicy(
            interaction.workspaceId,
          );
    const learningMode = workspacePolicy?.learningMode ?? "trust_tiered";
    const candidates = (await this.#extractor.extract(interaction))
      .map((candidate) => {
        const content = redactSensitiveText(candidate.content);
        const rawText =
          candidate.rawText === undefined
            ? undefined
            : redactSensitiveText(candidate.rawText);
        const supersedesContent =
          candidate.supersedesContent === undefined
            ? undefined
            : redactSensitiveText(candidate.supersedesContent);
        const scopeEvidence =
          candidate.scopeEvidence === undefined
            ? undefined
            : redactSensitiveText(candidate.scopeEvidence.excerpt);
        return CandidateMemorySchema.parse({
          ...candidate,
          content: content.text,
          ...(rawText === undefined ? {} : { rawText: rawText.text }),
          ...(supersedesContent === undefined
            ? {}
            : { supersedesContent: supersedesContent.text }),
          ...(scopeEvidence === undefined
            ? {}
            : {
                scopeEvidence: {
                  ...candidate.scopeEvidence,
                  excerpt: scopeEvidence.text,
                },
              }),
        });
      })
      .filter((candidate) => candidate.confidence >= this.#minimumConfidence);
    const stored: Memory[] = [];
    let created = 0;
    let reconciled = 0;
    let superseded = 0;

    for (const candidate of candidates) {
      const triggeringMessage =
        (candidate.triggeringMessageId === undefined
          ? undefined
          : interaction.messages.find(
              (message) => message.id === candidate.triggeringMessageId,
            )) ??
        [...interaction.messages]
          .reverse()
          .find((message) => message.role === "user");
      const rawText = candidate.rawText ?? triggeringMessage?.content;
      const triggeringMessageIndex =
        triggeringMessage === undefined
          ? -1
          : interaction.messages.indexOf(triggeringMessage);
      const sourceWasRedacted =
        triggeringMessage !== undefined &&
        redactedMessageIds.has(
          triggeringMessage.id ?? `index:${triggeringMessageIndex}`,
        );
      const source = {
        agent: interaction.agent,
        ...(interaction.sessionId === undefined
          ? {}
          : { sessionId: interaction.sessionId }),
        ...(triggeringMessage?.id === undefined
          ? {}
          : {
              messageId: triggeringMessage.id,
            }),
        ...(rawText === undefined ? {} : { rawText }),
        ...(interaction.workspaceId === undefined
          ? {}
          : { workspaceId: interaction.workspaceId }),
        ...(interaction.eventId === undefined
          ? {}
          : { eventId: interaction.eventId }),
        ...(sourceWasRedacted ? { redacted: true } : {}),
      } satisfies MemorySource;

      const explicitTarget =
        candidate.supersedesMemoryId === undefined
          ? undefined
          : await this.#repository.get(
              candidate.supersedesMemoryId,
              interaction.workspaceId === undefined
                ? undefined
                : { workspaceId: interaction.workspaceId },
            );
      if (
        candidate.supersedesMemoryId !== undefined &&
        explicitTarget === null
      ) {
        throw new Error(
          `Correction target not found: ${candidate.supersedesMemoryId}`,
        );
      }
      const inferredTarget =
        explicitTarget === undefined
          ? await findReconciliationTarget(
              this.#repository,
              scope,
              candidate,
              interaction.workspaceId,
            )
          : undefined;
      const reconciliationTarget = explicitTarget ?? inferredTarget;
      const candidateScope = resolveCandidateScope(
        scope,
        candidate,
        reconciliationTarget ?? undefined,
      );
      if (candidateScope === undefined) {
        continue;
      }
      const equivalent = await findEquivalentMemory(
        this.#repository,
        candidateScope,
        candidate,
        interaction.workspaceId,
      );
      if (equivalent !== undefined) {
        stored.push(equivalent);
        continue;
      }

      const supersedesMemoryId = reconciliationTarget?.id;
      const shouldPropose =
        interaction.workspaceId !== undefined &&
        (learningMode === "proposal_only" ||
          supersedesMemoryId !== undefined ||
          candidate.category !== "correction" ||
          candidate.confirmation !== "explicit");
      const memory = createMemory({
        ...(interaction.workspaceId === undefined
          ? {}
          : { workspaceId: interaction.workspaceId }),
        content: candidate.content,
        scope: candidateScope,
        category: candidate.category,
        source,
        confidence: candidate.confidence,
        confirmation: candidate.confirmation ?? "unconfirmed",
        ...(candidate.reconciliationKey === undefined
          ? {}
          : { reconciliationKey: candidate.reconciliationKey }),
        ...(supersedesMemoryId === undefined ? {} : { supersedesMemoryId }),
        ...(shouldPropose ? { status: "proposed" as const } : {}),
      });
      if (shouldPropose) {
        const proposalWorkspaceId = interaction.workspaceId;
        if (proposalWorkspaceId === undefined) {
          throw new Error("Governed proposals require a workspace ID");
        }
        const metadata = ProposalMetadataSchema.parse({
          memoryId: memory.id,
          workspaceId: proposalWorkspaceId,
          policyMode: learningMode,
          reason:
            learningMode === "proposal_only"
              ? "Workspace policy requires review for automatic captures."
              : supersedesMemoryId === undefined
                ? "Automatic capture was not an explicit human correction."
                : "A deterministic replacement target requires conflict review.",
          provenance: source,
          proposedAt: memory.createdAt,
          decision: null,
          reviewerId: null,
          decisionReason: null,
          decidedAt: null,
          decisionTargetMemoryId: null,
        });
        if (workspacePolicy === undefined) {
          throw new Error("Governed proposals require workspace policy");
        }
        const detected = await this.#conflictDetector.detect(
          {
            proposal: memory,
            ...(reconciliationTarget === undefined
              ? {}
              : { deterministicTarget: reconciliationTarget }),
            policy: workspacePolicy,
          },
          { workspaceId: proposalWorkspaceId },
        );
        const conflicts: MemoryConflict[] = detected.map((conflict) => {
          const evidence = redactUnknown(conflict.evidence);
          return MemoryConflictSchema.parse({
            id: randomUUID(),
            workspaceId: proposalWorkspaceId,
            proposalMemoryId: memory.id,
            targetMemoryId: conflict.targetMemoryId,
            detector: conflict.detector,
            severity:
              conflict.detector === "deterministic"
                ? "blocking"
                : "warning",
            evidence: evidence.value,
            createdAt: memory.createdAt,
            resolution: null,
            resolvedAt: null,
          });
        });
        const result = await this.#repository.propose(
          memory,
          metadata,
          conflicts,
        );
        stored.push(result.memory);
        if (result.inserted) {
          created += 1;
        }
      } else if (supersedesMemoryId === undefined) {
        const result = await this.#repository.insert(memory);
        stored.push(result.memory);
        if (result.inserted) {
          created += 1;
        }
      } else {
        const result = await this.#repository.supersede(
          supersedesMemoryId,
          memory,
          interaction.workspaceId === undefined
            ? undefined
            : { workspaceId: interaction.workspaceId },
        );
        stored.push(result.memory);
        if (result.memory.id === memory.id) {
          created += 1;
          superseded += 1;
          if (inferredTarget !== undefined) {
            reconciled += 1;
          }
        }
      }
    }

    return {
      memories: stored,
      created,
      duplicates: stored.length - created,
      reconciled,
      superseded,
    };
  }

  async getContext(
    taskInput: AgentTask,
    context?: { workspaceId?: string },
  ): Promise<GetContextResponse> {
    const task = AgentTaskSchema.parse(taskInput);
    const hits = (await this.#retriever.retrieve(task, context)).filter(
      (hit) => hit.memory.status === "active",
    );
    return {
      memories: hits.map((hit) => hit.memory),
      hits,
    };
  }

  async getWorkspaceLearningPolicy(
    workspaceIdInput: string,
  ): Promise<WorkspaceLearningPolicy> {
    const workspaceId =
      WorkspaceLearningPolicySchema.shape.workspaceId.parse(workspaceIdInput);
    return this.#repository.getWorkspaceLearningPolicy(workspaceId);
  }

  async updateWorkspaceLearningPolicy(
    workspaceIdInput: string,
    updateInput: UpdateWorkspaceLearningPolicy,
  ): Promise<WorkspaceLearningPolicy> {
    const workspaceId =
      WorkspaceLearningPolicySchema.shape.workspaceId.parse(workspaceIdInput);
    const update = UpdateWorkspaceLearningPolicySchema.parse(updateInput);
    return this.#repository.updateWorkspaceLearningPolicy(workspaceId, update);
  }

  async getProposal(
    proposalMemoryId: string,
    context: WorkspaceRepositoryContext,
  ): Promise<ProposalRecord | null> {
    const memoryId = ReviewProposalDtoSchema.shape.proposalMemoryId.parse(
      proposalMemoryId,
    );
    return this.#repository.getProposal(memoryId, context);
  }

  async recordProposalConflict(
    inputValue: RecordProposalConflictDto,
    context: WorkspaceRepositoryContext,
  ): Promise<MemoryConflict> {
    const input = RecordProposalConflictDtoSchema.parse(inputValue);
    const redactedEvidence = redactUnknown(input.evidence);
    const conflict = MemoryConflictSchema.parse({
      id: randomUUID(),
      workspaceId: context.workspaceId,
      proposalMemoryId: input.proposalMemoryId,
      targetMemoryId: input.targetMemoryId,
      detector: input.detector,
      severity: input.severity,
      evidence: redactedEvidence.value,
      createdAt: new Date().toISOString(),
      resolution: null,
      resolvedAt: null,
    });
    return (
      await this.#repository.addProposalConflict(conflict, context)
    ).conflict;
  }

  async reviewProposal(
    inputValue: ReviewProposalDto,
    context: WorkspaceRepositoryContext,
  ): Promise<ReviewProposalResponse> {
    const input = ReviewProposalDtoSchema.parse(inputValue);
    return this.#repository.reviewProposal(
      {
        ...input,
        reason: redactSensitiveText(input.reason).text,
      },
      context,
    );
  }

  async remember(input: CreateMemoryDto): Promise<RememberResponse> {
    const value = CreateMemoryDtoSchema.parse(input);
    const content = redactSensitiveText(value.content);
    const rawText =
      value.source.rawText === undefined || value.source.rawText === null
        ? undefined
        : redactSensitiveText(value.source.rawText);
    const source = {
      ...value.source,
      ...(rawText === undefined ? {} : { rawText: rawText.text }),
      ...((content.redacted || rawText?.redacted) === true
        ? { redacted: true }
        : {}),
    };
    return this.#repository.insert(
      createMemory({
        ...(source.workspaceId === undefined
          ? {}
          : { workspaceId: source.workspaceId }),
        content: content.text,
        scope: value.scope,
        category: value.category ?? "other",
        source,
        confidence: 1,
        confirmation: "explicit",
      }),
    );
  }

  async correct(
    input: CorrectMemoryDto,
    context: RepositoryContext = {},
  ): Promise<CorrectMemoryResponse> {
    const value = CorrectMemoryDtoSchema.parse(input);
    const current = await this.#repository.get(value.memoryId, context);
    if (current === null) {
      throw new Error(`Memory not found: ${value.memoryId}`);
    }
    if (current.status !== "active" && current.status !== "suppressed") {
      throw new Error(
        `Only active or suppressed memories can be corrected: ${value.memoryId} is ${current.status}`,
      );
    }

    const content = redactSensitiveText(value.content);
    const requestedSource = value.source ?? current.source;
    const rawText =
      requestedSource.rawText === undefined ||
      requestedSource.rawText === null
        ? undefined
        : redactSensitiveText(requestedSource.rawText);
    const source = {
      ...requestedSource,
      ...(rawText === undefined ? {} : { rawText: rawText.text }),
      ...((content.redacted || rawText?.redacted) === true
        ? { redacted: true }
        : {}),
    };
    const replacement = createMemory({
      ...(current.workspaceId === undefined
        ? {}
        : { workspaceId: current.workspaceId }),
      content: content.text,
      scope: value.scope ?? current.scope,
      category: value.category ?? "correction",
      source,
      confidence: 1,
      confirmation: "explicit",
      supersedesMemoryId: current.id,
    });
    return this.#repository.supersede(current.id, replacement, context);
  }

  async forget(
    input: ForgetMemoryDto | string,
    context: RepositoryContext = {},
  ): Promise<ForgetMemoryResponse> {
    const value = ForgetMemoryDtoSchema.parse(
      typeof input === "string" ? { id: input } : input,
    );
    const memory = await this.#repository.softDelete(
      value.id,
      undefined,
      context,
    );
    if (memory === null) {
      throw new Error(`Memory not found: ${value.id}`);
    }
    return { memory };
  }

  async listMemories(
    input: ListMemoriesDto = {},
    context: RepositoryContext = {},
  ): Promise<ListMemoriesResponse> {
    return this.#repository.list(ListMemoriesDtoSchema.parse(input), context);
  }

  async getMemory(
    input: GetMemoryDto | string,
    context: RepositoryContext = {},
  ): Promise<GetMemoryResponse> {
    const value = GetMemoryDtoSchema.parse(
      typeof input === "string" ? { id: input } : input,
    );
    return { memory: await this.#repository.get(value.id, context) };
  }
}

export { SharedMemoryEngine as LoreEngine };
