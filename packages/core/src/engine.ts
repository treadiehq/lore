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
  MemorySchema,
  normalizeInteractionScope,
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
  type MemoryScope,
  type MemorySource,
  type ObserveResponse,
  type RememberResponse,
} from "./schemas.js";
import type { ConfirmationLevel } from "./pilot-schemas.js";
import { redactSensitiveText } from "./redaction.js";
import type {
  MemoryExtractor,
  MemoryRepository,
  MemoryRetriever,
  RepositoryContext,
} from "./ports.js";

export interface SharedMemoryEngineDependencies {
  repository: MemoryRepository;
  extractor: MemoryExtractor;
  retriever: MemoryRetriever;
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
    status: "active",
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
        return CandidateMemorySchema.parse({
          ...candidate,
          content: content.text,
          ...(rawText === undefined ? {} : { rawText: rawText.text }),
          ...(supersedesContent === undefined
            ? {}
            : { supersedesContent: supersedesContent.text }),
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

      const equivalent = await findEquivalentMemory(
        this.#repository,
        scope,
        candidate,
        interaction.workspaceId,
      );
      if (equivalent !== undefined) {
        stored.push(equivalent);
        continue;
      }

      const inferredTarget =
        candidate.supersedesMemoryId === undefined
          ? await findReconciliationTarget(
              this.#repository,
              scope,
              candidate,
              interaction.workspaceId,
            )
          : undefined;
      const supersedesMemoryId =
        candidate.supersedesMemoryId ?? inferredTarget?.id;
      const memory = createMemory({
        ...(interaction.workspaceId === undefined
          ? {}
          : { workspaceId: interaction.workspaceId }),
        content: candidate.content,
        scope,
        category: candidate.category,
        source,
        confidence: candidate.confidence,
        confirmation: candidate.confirmation ?? "unconfirmed",
        ...(candidate.reconciliationKey === undefined
          ? {}
          : { reconciliationKey: candidate.reconciliationKey }),
        ...(supersedesMemoryId === undefined ? {} : { supersedesMemoryId }),
      });
      if (supersedesMemoryId === undefined) {
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
    const hits = await this.#retriever.retrieve(task, context);
    return {
      memories: hits.map((hit) => hit.memory),
      hits,
    };
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
