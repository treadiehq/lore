import {
  AgentTaskSchema,
  normalizeTaskScope,
  redactSensitiveText,
  type AgentTask,
  type Memory,
  type MemoryCategory,
  type MemoryRepository,
  type MemoryRetriever,
  type MemoryScope,
} from "@lore-co/core";
export * from "./context-packing.js";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "do",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "service",
  "services",
  "handler",
  "handlers",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "this",
  "to",
  "use",
  "we",
  "what",
  "when",
  "where",
  "which",
  "with",
]);

function words(value: string): string[] {
  return value.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function tokenizeForMemorySearch(value: string): string[] {
  const original = words(value).map((word) => word.toLocaleLowerCase());
  const identifierSplit = value
    .normalize("NFKC")
    .replace(/([\p{Ll}\d])([\p{Lu}])/gu, "$1 $2")
    .replace(/[._/\\:#@-]+/gu, " ");
  const split = words(identifierSplit).map((word) => word.toLocaleLowerCase());

  return [
    ...new Set(
      [...original, ...split].filter(
        (token) =>
          token.length >= 2 &&
          !STOP_WORDS.has(token) &&
          !/^\d$/u.test(token),
      ),
    ),
  ];
}

export function taskSearchText(task: AgentTask): string {
  return [
    task.task,
    task.diff,
    ...(task.files ?? []),
    ...(task.components ?? []),
    ...(task.symbols ?? []),
  ]
    .filter((value): value is string => value !== undefined)
    .join("\n");
}

const CATEGORY_BOOSTS: Readonly<Record<MemoryCategory, number>> = {
  architecture: 1.2,
  convention: 1.15,
  correction: 1.5,
  gotcha: 1.4,
  known_gotcha: 1.4,
  deprecated: 1.35,
  behavior: 1.25,
  review_feedback: 1.45,
  other: 1,
};

function relevanceScore(
  memory: Memory,
  queryTerms: ReadonlySet<string>,
  searchText: string,
): number {
  const memoryTerms = new Set(tokenizeForMemorySearch(memory.content));
  let overlap = 0;
  let score = 0;
  for (const term of queryTerms) {
    if (!memoryTerms.has(term)) {
      continue;
    }
    overlap += 1;
    score += 1 + Math.min(term.length, 20) / 20;
  }
  if (overlap === 0) {
    return 0;
  }

  const normalizedContent = memory.content.toLocaleLowerCase();
  const phrases = [
    ...words(searchText),
    ...(searchText.match(
      /[\p{L}\p{N}]+(?:[._:/-][\p{L}\p{N}]+)+/gu,
    ) ?? []),
  ];
  for (const phrase of phrases) {
    if (
      phrase.length >= 4 &&
      normalizedContent.includes(phrase.toLocaleLowerCase())
    ) {
      score += 0.75;
    }
  }

  const specificity =
    Number(memory.scope.organization !== undefined) +
    Number(memory.scope.project !== undefined) +
    Number(memory.scope.repo !== undefined) +
    Number(memory.scope.path !== undefined) +
    Number(memory.scope.component !== undefined);
  return score * CATEGORY_BOOSTS[memory.category] + specificity * 0.1;
}

export interface ScopedKeywordMemoryRetrieverOptions {
  defaultLimit?: number;
  candidateLimit?: number;
}

export class ScopedKeywordMemoryRetriever implements MemoryRetriever {
  readonly #repository: MemoryRepository;
  readonly #defaultLimit: number;
  readonly #candidateLimit: number;

  constructor(
    repository: MemoryRepository,
    options: ScopedKeywordMemoryRetrieverOptions = {},
  ) {
    this.#repository = repository;
    this.#defaultLimit = Math.min(Math.max(options.defaultLimit ?? 5, 1), 10);
    this.#candidateLimit = Math.max(options.candidateLimit ?? 200, 20);
  }

  async retrieve(
    taskInput: AgentTask,
    context?: { workspaceId?: string },
  ): Promise<Memory[]> {
    const task = AgentTaskSchema.parse(taskInput);
    const searchText = taskSearchText(task);
    const terms = tokenizeForMemorySearch(searchText);
    if (terms.length === 0) {
      return [];
    }

    const candidates = await this.#repository.findActiveScopeCandidates(
      normalizeTaskScope(task),
      {
        ...(context?.workspaceId === undefined
          ? {}
          : { workspaceId: context.workspaceId }),
        keywords: terms,
        ...(task.files === undefined ? {} : { paths: task.files }),
        components: [
          ...(task.components ?? []),
          ...(task.component === undefined ? [] : [task.component]),
        ],
        limit: this.#candidateLimit,
      },
    );
    const queryTerms = new Set(terms);
    const limit = Math.min(task.limit ?? this.#defaultLimit, 10);

    return candidates
      .map((memory) => ({
        memory,
        score: relevanceScore(memory, queryTerms, searchText),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.memory.updatedAt.localeCompare(left.memory.updatedAt) ||
          left.memory.id.localeCompare(right.memory.id),
      )
      .slice(0, limit)
      .map(({ memory }) => memory);
  }
}

export function formatRelevantMemories(
  memories: readonly Memory[],
): string {
  if (memories.length === 0) {
    return "";
  }
  return [
    "Relevant shared engineering knowledge:",
    ...memories.map((memory, index) => `${index + 1}. ${memory.content}`),
  ].join("\n");
}

export const formatMemoryContext = formatRelevantMemories;

export const EMBEDDING_DIMENSIONS = 1_536;

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(input: string): Promise<number[]>;
}

export interface SemanticMemorySearchInput {
  workspaceId: string;
  scope: MemoryScope;
  embedding: readonly number[];
  model: string;
  paths?: readonly string[];
  components?: readonly string[];
  limit: number;
  minimumSimilarity: number;
}

export interface SemanticMemoryStore {
  search(input: SemanticMemorySearchInput): Promise<Memory[]>;
  upsertEmbedding(input: {
    memory: Memory;
    model: string;
    embedding: readonly number[];
  }): Promise<void>;
  listNeedingEmbedding(input: {
    model: string;
    limit: number;
  }): Promise<Memory[]>;
}

export interface OpenAiCompatibleEmbeddingProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: OpenAiCompatibleEmbeddingProviderOptions) {
    this.#baseUrl = options.baseUrl.trim().replace(/\/+$/u, "");
    this.#apiKey = options.apiKey.trim();
    this.model = options.model.trim();
    this.dimensions = options.dimensions ?? EMBEDDING_DIMENSIONS;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (this.#baseUrl === "" || this.#apiKey === "" || this.model === "") {
      throw new Error(
        "Embedding base URL, API key, and model must all be configured",
      );
    }
    if (this.dimensions !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Lore currently requires ${EMBEDDING_DIMENSIONS}-dimension embeddings`,
      );
    }
  }

  async embed(input: string): Promise<number[]> {
    const response = await this.#fetch(`${this.#baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input,
        dimensions: this.dimensions,
        encoding_format: "float",
      }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) {
      const details = (await response.text()).trim().slice(0, 500);
      throw new Error(
        `Embedding request failed with HTTP ${response.status}${details === "" ? "" : `: ${details}`}`,
      );
    }
    const body = (await response.json()) as {
      data?: Array<{ embedding?: unknown }>;
    };
    const value = body.data?.[0]?.embedding;
    if (
      !Array.isArray(value) ||
      value.length !== this.dimensions ||
      !value.every(
        (item): item is number =>
          typeof item === "number" && Number.isFinite(item),
      )
    ) {
      throw new Error(
        `Embedding response must contain ${this.dimensions} finite numbers`,
      );
    }
    return value;
  }
}

export interface HybridMemoryRetrieverOptions {
  defaultLimit?: number;
  semanticCandidateLimit?: number;
  reciprocalRankConstant?: number;
  semanticWeight?: number;
  semanticMinimumSimilarity?: number;
  maximumQueryCharacters?: number;
}

export class HybridMemoryRetriever implements MemoryRetriever {
  readonly #lexical: MemoryRetriever;
  readonly #provider: EmbeddingProvider;
  readonly #store: SemanticMemoryStore;
  readonly #defaultLimit: number;
  readonly #semanticCandidateLimit: number;
  readonly #reciprocalRankConstant: number;
  readonly #semanticWeight: number;
  readonly #semanticMinimumSimilarity: number;
  readonly #maximumQueryCharacters: number;

  constructor(
    lexical: MemoryRetriever,
    provider: EmbeddingProvider,
    store: SemanticMemoryStore,
    options: HybridMemoryRetrieverOptions = {},
  ) {
    this.#lexical = lexical;
    this.#provider = provider;
    this.#store = store;
    this.#defaultLimit = Math.min(Math.max(options.defaultLimit ?? 5, 1), 10);
    this.#semanticCandidateLimit = Math.min(
      Math.max(options.semanticCandidateLimit ?? 50, 10),
      200,
    );
    this.#reciprocalRankConstant = Math.max(
      options.reciprocalRankConstant ?? 60,
      1,
    );
    this.#semanticWeight = Math.max(options.semanticWeight ?? 0.9, 0);
    this.#semanticMinimumSimilarity = Math.min(
      Math.max(options.semanticMinimumSimilarity ?? 0.65, 0),
      1,
    );
    this.#maximumQueryCharacters = Math.max(
      options.maximumQueryCharacters ?? 12_000,
      100,
    );
  }

  async retrieve(
    taskInput: AgentTask,
    context?: { workspaceId?: string },
  ): Promise<Memory[]> {
    const task = AgentTaskSchema.parse(taskInput);
    const lexicalPromise = this.#lexical.retrieve(task, context);
    if (context?.workspaceId === undefined) {
      return lexicalPromise;
    }
    const searchText = redactSensitiveText(taskSearchText(task)).text;
    const boundedSearchText = Array.from(searchText)
      .slice(0, this.#maximumQueryCharacters)
      .join("")
      .trim();
    if (boundedSearchText === "") {
      return lexicalPromise;
    }
    const semanticPromise = this.#provider
      .embed(boundedSearchText)
      .then((embedding) =>
        this.#store.search({
          workspaceId: context.workspaceId as string,
          scope: normalizeTaskScope(task),
          embedding,
          model: this.#provider.model,
          ...(task.files === undefined ? {} : { paths: task.files }),
          components: [
            ...(task.components ?? []),
            ...(task.component === undefined ? [] : [task.component]),
          ],
          limit: this.#semanticCandidateLimit,
          minimumSimilarity: this.#semanticMinimumSimilarity,
        }),
      )
      .catch(() => [] as Memory[]);
    const [lexical, semantic] = await Promise.all([
      lexicalPromise,
      semanticPromise,
    ]);
    const scores = new Map<
      string,
      { memory: Memory; score: number; bestRank: number }
    >();
    const add = (
      memories: readonly Memory[],
      weight: number,
    ): void => {
      memories.forEach((memory, index) => {
        const rank = index + 1;
        const current = scores.get(memory.id);
        scores.set(memory.id, {
          memory,
          score:
            (current?.score ?? 0) +
            weight / (this.#reciprocalRankConstant + rank),
          bestRank: Math.min(current?.bestRank ?? rank, rank),
        });
      });
    };
    add(lexical, 1);
    add(semantic, this.#semanticWeight);
    const limit = Math.min(task.limit ?? this.#defaultLimit, 10);
    return [...scores.values()]
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.bestRank - right.bestRank ||
          right.memory.updatedAt.localeCompare(left.memory.updatedAt) ||
          left.memory.id.localeCompare(right.memory.id),
      )
      .slice(0, limit)
      .map(({ memory }) => memory);
  }
}
