import {
  AgentInteractionSchema,
  CandidateMemorySchema,
  normalizeInteractionScope,
  redactSensitiveText,
  redactUnknown,
  type AgentInteraction,
  type CandidateMemory,
  type MemoryCategory,
  type MemoryExtractor,
} from "@lore-co/core";
import { z, type ZodType } from "zod";

function cleanWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function ensurePeriod(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

function normalizeTeaching(rawText: string): string {
  const text = cleanWhitespace(rawText)
    .replace(
      /^(?:No|Actually|Nope|Not exactly|Not quite)(?:[,.!:;-]\s*|\s+)/iu,
      "",
    )
    .replace(/^Close[,.!:;-]?\s*(?:but\s+)?/iu, "");
  const directCall = /^Never call\s+(.+?)\s+directly from\s+(.+?)\.\s*Use\s+(.+?)\.?$/iu.exec(
    text,
  );
  if (directCall !== null) {
    const subject = directCall[1];
    const location = directCall[2];
    const alternative = directCall[3];
    if (
      subject !== undefined &&
      location !== undefined &&
      alternative !== undefined
    ) {
      const normalizedAlternative = alternative
        .trim()
        .replace(/[.!?]+$/u, "");
      const normalizedLocation =
        location.charAt(0).toLocaleUpperCase() + location.slice(1);
      return `${normalizedLocation} must use ${normalizedAlternative} instead of accessing ${subject} directly.`;
    }
  }
  return ensurePeriod(text);
}

function isLikelyDurableTeaching(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 8 || trimmed.endsWith("?")) {
    return false;
  }

  return (
    /^(?:Never|Always)\b/iu.test(trimmed) ||
    /\bdeprecated\b/iu.test(trimmed) ||
    /\buse\b.+\binstead\b|\binstead\b.+\buse\b/iu.test(trimmed) ||
    /^Instead(?:[,:])?\s+/iu.test(trimmed) ||
    /^No(?:[,.!:])?\s+.+\bUse\b/iu.test(trimmed) ||
    /\b(?:returns?|means?|responds?\s+with|results?\s+in|is\s+treated\s+as|maps?\s+to)\b/iu.test(
      trimmed,
    )
  );
}

function classifyTeaching(text: string): MemoryCategory {
  if (
    /^No(?:[,.!:])?\s+/iu.test(text) ||
    /\binstead\b/iu.test(text)
  ) {
    return "correction";
  }
  if (/\bdeprecated\b/iu.test(text)) {
    return "deprecated";
  }
  if (
    /\b(?:returns?|means?|responds?\s+with|results?\s+in|is\s+treated\s+as|maps?\s+to)\b/iu.test(
      text,
    )
  ) {
    return "behavior";
  }
  if (/^(?:Never|Always)\b/iu.test(text)) {
    return "convention";
  }
  return "other";
}

type PairCorrectionKind = "explicit" | "natural";

function pairCorrectionKind(text: string): PairCorrectionKind | undefined {
  const trimmed = text.trim();
  if (trimmed.length < 8 || trimmed.endsWith("?")) {
    return undefined;
  }
  const naturalLead =
    /^(?:Actually|Nope|Not exactly|Not quite|Close|Almost|More precisely|To clarify|Rather)\b[,.!:;-]?\s*/iu.exec(
      trimmed,
    );
  if (
    (naturalLead !== null &&
      /\b(?:belongs?|lives?|resides?|is|are|was|were|should|must|uses?|requires?|owns?|handles?|returns?|means?|responds?\s+with|results?\s+in|maps?\s+to)\b/iu.test(
        trimmed.slice(naturalLead[0].length),
      )) ||
    /\bwe\s+(?:stopped|no longer|do not|don't)\b/iu.test(trimmed) ||
    /\bwrong\s+(?:layer|service|module|component|place|level|abstraction|direction|owner)\b/iu.test(
      trimmed,
    )
  ) {
    return "natural";
  }
  if (
    /^(?:No|Correction|That's (?:not right|wrong)|That is (?:not right|wrong))\b[,.!:;-]?\s*/iu.test(
      trimmed,
    ) ||
    /\b(?:deprecated|incorrect)\b/iu.test(trimmed) ||
    /\buse\b.+\binstead\b|\binstead\b.+\buse\b/iu.test(trimmed)
  ) {
    return "explicit";
  }
  return undefined;
}

const RECONCILIATION_WORDS = new Set([
  "always",
  "assistant",
  "because",
  "correct",
  "deprecated",
  "instead",
  "never",
  "should",
  "that",
  "this",
  "user",
]);

function reconciliationKey(
  previousAssistant: string,
  currentUser: string,
): string {
  const previousIdentifiers =
    previousAssistant.match(
      /\b(?:[A-Z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]*)+|[A-Za-z][A-Za-z0-9]*(?:[._:/-][A-Za-z0-9]+)+|[A-Z][A-Za-z0-9]{2,})\b/gu,
    ) ?? [];
  const normalizedUser = currentUser.toLocaleLowerCase();
  const shared = previousIdentifiers.find(
    (identifier) =>
      !RECONCILIATION_WORDS.has(identifier.toLocaleLowerCase()) &&
      normalizedUser.includes(identifier.toLocaleLowerCase()),
  );
  if (shared !== undefined) {
    return shared;
  }

  const subject =
    /^(?:No|Actually|Correction|Not quite)?[,.!:;-]?\s*(?:the\s+)?(.{3,80}?)\s+(?:is|are|was|were|should|must|uses?|returns?)\b/iu.exec(
      currentUser.trim(),
    )?.[1];
  const cleaned = subject?.trim().replace(/[.!?,:;]+$/u, "");
  if (cleaned !== undefined && cleaned.length >= 3) {
    return cleaned;
  }

  const fallback =
    cleanWhitespace(previousAssistant).slice(0, 500) ||
    cleanWhitespace(currentUser).slice(0, 500);
  return fallback;
}

const ORGANIZATION_SCOPE_SIGNAL =
  /\b(?:(?:organization|org|team|company)[ -]wide|across\s+(?:the\s+)?(?:entire\s+|whole\s+)?(?:organization|org|team|company)|across\s+(?:all|every)\s+(?:repositories|repos)|(?:all|every)\s+(?:repositories|repos))\b/iu;

function boundedScopeExcerpt(value: string): string {
  return Array.from(value.trim()).slice(0, 500).join("");
}

function candidateScopeMetadata(
  interaction: AgentInteraction,
  rawText: string,
  explicitCorrection: boolean,
): Pick<CandidateMemory, "scopeIntent" | "scopeEvidence"> {
  const organizationEvidence = ORGANIZATION_SCOPE_SIGNAL.exec(rawText)?.[0];
  if (explicitCorrection && organizationEvidence !== undefined) {
    return {
      scopeIntent: "organization",
      scopeEvidence: {
        basis: "explicit_user_statement",
        excerpt: boundedScopeExcerpt(organizationEvidence),
      },
    };
  }

  const repository = normalizeInteractionScope(interaction).repo;
  return repository === undefined
    ? {}
    : {
        scopeIntent: "repository",
        scopeEvidence: {
          basis: "interaction_repository",
          excerpt: repository,
        },
      };
}

export class HeuristicMemoryExtractor implements MemoryExtractor {
  async extract(interactionInput: AgentInteraction): Promise<CandidateMemory[]> {
    const interaction = AgentInteractionSchema.parse(interactionInput);
    const candidates: CandidateMemory[] = [];

    for (const [index, message] of interaction.messages.entries()) {
      if (message.role !== "user") {
        continue;
      }
      const rawText = message.content;
      const previousMessage = interaction.messages[index - 1];
      const pairKind =
        previousMessage?.role === "assistant"
          ? pairCorrectionKind(rawText)
          : undefined;
      if (!isLikelyDurableTeaching(rawText) && pairKind === undefined) {
        continue;
      }
      const pairedCorrection = pairKind !== undefined;
      const key =
        pairedCorrection && previousMessage !== undefined
          ? reconciliationKey(previousMessage.content, rawText)
          : undefined;
      candidates.push(
        CandidateMemorySchema.parse({
          content: normalizeTeaching(rawText),
          category: pairedCorrection ? "correction" : classifyTeaching(rawText),
          confidence:
            pairKind === "explicit"
              ? 0.98
              : pairKind === "natural"
                ? 0.81
                : 0.92,
          ...(message.id === undefined
            ? {}
            : { triggeringMessageId: message.id }),
          rawText,
          ...(pairedCorrection && previousMessage !== undefined
            ? {
                confirmation: "explicit" as const,
                confirmationReason:
                  "The user explicitly corrected the immediately preceding assistant turn.",
                supersedesContent: previousMessage.content,
              }
            : {}),
          ...(key === undefined ? {} : { reconciliationKey: key }),
          ...candidateScopeMetadata(interaction, rawText, pairedCorrection),
        }),
      );
    }

    return candidates;
  }
}

export { HeuristicMemoryExtractor as HeuristicLearningExtractor };
export { redactSensitiveText, redactUnknown };

export interface LlmStructuredRequest {
  systemPrompt: string;
  prompt: string;
  schemaName?: string;
}

export interface LlmProvider {
  generateStructured<T>(
    request: LlmStructuredRequest,
    schema: ZodType<T>,
  ): Promise<T>;
}

export interface OpenAiCompatibleProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const completionResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string(),
        }),
      }),
    )
    .min(1),
});

function stripJsonFence(content: string): string {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

export class OpenAiCompatibleHttpProvider implements LlmProvider {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: OpenAiCompatibleProviderOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (this.#fetch === undefined) {
      throw new Error("A Fetch API implementation is required");
    }
  }

  async generateStructured<T>(
    request: LlmStructuredRequest,
    schema: ZodType<T>,
  ): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.#model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: request.systemPrompt },
          { role: "user", content: request.prompt },
        ],
      }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });

    if (!response.ok) {
      const details = cleanWhitespace(await response.text()).slice(0, 500);
      throw new Error(
        `Structured generation failed with HTTP ${response.status}${details.length === 0 ? "" : `: ${details}`}`,
      );
    }

    const completion = completionResponseSchema.parse(await response.json());
    const content = completion.choices[0]?.message.content;
    if (content === undefined) {
      throw new Error("Structured generation returned no message content");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonFence(content));
    } catch (error) {
      throw new Error("Structured generation returned invalid JSON", {
        cause: error,
      });
    }
    return schema.parse(parsed);
  }
}

const llmCandidateSchema = z
  .object({
    content: CandidateMemorySchema.shape.content,
    category: CandidateMemorySchema.shape.category,
    confidence: CandidateMemorySchema.shape.confidence,
    triggeringMessageId: CandidateMemorySchema.shape.triggeringMessageId,
    rawText: CandidateMemorySchema.shape.rawText,
    scopeIntent: CandidateMemorySchema.shape.scopeIntent,
    scopeEvidence: CandidateMemorySchema.shape.scopeEvidence,
  })
  .strict();

const extractionResultSchema = z
  .object({
    memories: z.array(llmCandidateSchema),
  })
  .strict();

type LlmCandidateMemory = z.infer<typeof llmCandidateSchema>;

function resolveTriggeringUserMessage(
  interaction: AgentInteraction,
  candidate: LlmCandidateMemory,
): { index: number; message: AgentInteraction["messages"][number] } | undefined {
  const userMessages = interaction.messages
    .map((message, index) => ({ index, message }))
    .filter(({ message }) => message.role === "user");
  const matchingId =
    candidate.triggeringMessageId === undefined
      ? undefined
      : userMessages.find(
          ({ message }) => message.id === candidate.triggeringMessageId,
        );
  if (
    matchingId !== undefined &&
    (candidate.rawText === undefined ||
      matchingId.message.content === candidate.rawText)
  ) {
    return matchingId;
  }

  const matchingRawText =
    candidate.rawText === undefined
      ? undefined
      : userMessages
          .filter(({ message }) => message.content === candidate.rawText)
          .at(-1);
  return matchingRawText ?? userMessages.at(-1);
}

function localizeLlmCandidate(
  interaction: AgentInteraction,
  candidate: LlmCandidateMemory,
): CandidateMemory | undefined {
  const triggering = resolveTriggeringUserMessage(interaction, candidate);
  if (triggering === undefined) {
    return undefined;
  }
  const previousMessage = interaction.messages[triggering.index - 1];
  const adjacentCorrection =
    previousMessage?.role === "assistant" &&
    (candidate.category === "correction" ||
      pairCorrectionKind(triggering.message.content) !== undefined);
  const key =
    adjacentCorrection && previousMessage !== undefined
      ? reconciliationKey(
          previousMessage.content,
          triggering.message.content,
        )
      : undefined;

  return CandidateMemorySchema.parse({
    content: candidate.content,
    category: adjacentCorrection ? "correction" : candidate.category,
    confidence: candidate.confidence,
    ...(triggering.message.id === undefined
      ? {}
      : { triggeringMessageId: triggering.message.id }),
    rawText: triggering.message.content,
    ...(adjacentCorrection && previousMessage !== undefined
      ? {
          confirmation: "explicit" as const,
          confirmationReason:
            "The user explicitly corrected the immediately preceding assistant turn.",
          supersedesContent: previousMessage.content,
        }
      : {}),
    ...(key === undefined ? {} : { reconciliationKey: key }),
    ...(candidate.scopeIntent === undefined
      ? {}
      : { scopeIntent: candidate.scopeIntent }),
    ...(candidate.scopeEvidence === undefined
      ? {}
      : { scopeEvidence: candidate.scopeEvidence }),
  });
}

function deduplicateCandidates(
  candidates: readonly CandidateMemory[],
): CandidateMemory[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = JSON.stringify([
      candidate.triggeringMessageId ?? candidate.rawText ?? null,
      candidate.category,
      cleanWhitespace(candidate.content).normalize("NFKC").toLocaleLowerCase(),
    ]);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function candidateSourceKey(candidate: CandidateMemory): string | undefined {
  if (candidate.triggeringMessageId !== undefined) {
    return `id:${candidate.triggeringMessageId}`;
  }
  return candidate.rawText === undefined
    ? undefined
    : `raw:${cleanWhitespace(candidate.rawText).normalize("NFKC")}`;
}

function mergeRoutedCandidates(
  heuristicCandidates: readonly CandidateMemory[],
  llmCandidates: readonly CandidateMemory[],
  minimumConfidence: number,
): CandidateMemory[] {
  const highConfidence = heuristicCandidates.filter(
    (candidate) => candidate.confidence >= minimumConfidence,
  );
  const heuristicSources = new Set(
    highConfidence
      .map((candidate) => candidateSourceKey(candidate))
      .filter((key): key is string => key !== undefined),
  );
  return deduplicateCandidates([
    ...highConfidence,
    ...llmCandidates.filter((candidate) => {
      const source = candidateSourceKey(candidate);
      return source === undefined || !heuristicSources.has(source);
    }),
  ]);
}

export class LlmMemoryExtractor implements MemoryExtractor {
  readonly #provider: LlmProvider;

  constructor(provider: LlmProvider) {
    this.#provider = provider;
  }

  async extract(interactionInput: AgentInteraction): Promise<CandidateMemory[]> {
    const interaction = AgentInteractionSchema.parse(interactionInput);
    const result = await this.#provider.generateStructured(
      {
        schemaName: "memory_candidates",
        systemPrompt:
          "Extract only durable, explicit human engineering teachings, corrections, deprecations, conventions, gotchas, architecture decisions, or stable behavior facts. Ignore questions, transient task details, assistant statements, speculation, and ordinary conversation. Return JSON only. Preserve the triggering user message id and exact raw text. Write each memory as a concise standalone statement. Scope intent is bounded to organization, repository, or uncertain. Use organization only for an explicit correction whose user text clearly says it applies team-, company-, or organization-wide or across all repositories, and include a verbatim scopeEvidence excerpt no longer than 500 characters with basis explicit_user_statement. Otherwise use repository when repository context is present or uncertain when it is not. Never return supersedesMemoryId or reconciliation metadata; those fields are resolved locally.",
        prompt: JSON.stringify({
          output: {
            memories: [
              {
                content: "concise durable statement",
                category:
                  "architecture|convention|correction|gotcha|deprecated|behavior|review_feedback|other",
                confidence: "number from 0 to 1",
                triggeringMessageId: "source message id when present",
                rawText: "exact triggering message text",
                scopeIntent: "organization|repository|uncertain",
                scopeEvidence: {
                  basis:
                    "explicit_user_statement|interaction_repository|extractor_inference",
                  excerpt: "bounded evidence, at most 500 characters",
                },
              },
            ],
          },
          interaction,
        }),
      },
      extractionResultSchema,
    );
    return deduplicateCandidates(
      result.memories
        .map((candidate) => localizeLlmCandidate(interaction, candidate))
        .filter((candidate): candidate is CandidateMemory => candidate !== undefined),
    );
  }
}

export const DEFAULT_EXTRACTOR_MIN_CONFIDENCE = 0.8;

export interface ExtractorConfidenceEnvironment {
  EXTRACTOR_MIN_CONFIDENCE?: string;
}

export function parseExtractorMinConfidence(
  environment: ExtractorConfidenceEnvironment =
    process.env.EXTRACTOR_MIN_CONFIDENCE === undefined
      ? {}
      : {
          EXTRACTOR_MIN_CONFIDENCE:
            process.env.EXTRACTOR_MIN_CONFIDENCE,
        },
): number {
  const raw = environment.EXTRACTOR_MIN_CONFIDENCE?.trim();
  if (raw === undefined || raw === "") {
    return DEFAULT_EXTRACTOR_MIN_CONFIDENCE;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("EXTRACTOR_MIN_CONFIDENCE must be a number from 0 to 1");
  }
  return value;
}

export class HybridMemoryExtractor implements MemoryExtractor {
  readonly #heuristic: MemoryExtractor;
  readonly #llm: MemoryExtractor;
  readonly #minimumConfidence: number;

  constructor(
    heuristic: MemoryExtractor,
    llm: MemoryExtractor,
    minimumConfidence = DEFAULT_EXTRACTOR_MIN_CONFIDENCE,
  ) {
    if (
      !Number.isFinite(minimumConfidence) ||
      minimumConfidence < 0 ||
      minimumConfidence > 1
    ) {
      throw new Error("minimumConfidence must be a number from 0 to 1");
    }
    this.#heuristic = heuristic;
    this.#llm = llm;
    this.#minimumConfidence = minimumConfidence;
  }

  async extract(interactionInput: AgentInteraction): Promise<CandidateMemory[]> {
    const interaction = AgentInteractionSchema.parse(interactionInput);
    const heuristicCandidates = await this.#heuristic.extract(interaction);
    if (
      heuristicCandidates.length > 0 &&
      heuristicCandidates.every(
        (candidate) => candidate.confidence >= this.#minimumConfidence,
      )
    ) {
      return heuristicCandidates;
    }

    try {
      const llmCandidates = await this.#llm.extract(interaction);
      return mergeRoutedCandidates(
        heuristicCandidates,
        llmCandidates,
        this.#minimumConfidence,
      );
    } catch {
      return heuristicCandidates;
    }
  }
}

export type ExtractorProviderName =
  | "heuristic"
  | "hybrid"
  | "openai-compatible";

export interface ExtractorEnvironment extends ExtractorConfidenceEnvironment {
  EXTRACTOR_PROVIDER?: string;
  EXTRACTOR_MODEL?: string;
  EXTRACTOR_BASE_URL?: string;
  EXTRACTOR_API_KEY?: string;
}

export function createMemoryExtractor(
  environment: ExtractorEnvironment = {
    ...(process.env.EXTRACTOR_MIN_CONFIDENCE === undefined
      ? {}
      : {
          EXTRACTOR_MIN_CONFIDENCE:
            process.env.EXTRACTOR_MIN_CONFIDENCE,
        }),
    ...(process.env.EXTRACTOR_PROVIDER === undefined
      ? {}
      : { EXTRACTOR_PROVIDER: process.env.EXTRACTOR_PROVIDER }),
    ...(process.env.EXTRACTOR_MODEL === undefined
      ? {}
      : { EXTRACTOR_MODEL: process.env.EXTRACTOR_MODEL }),
    ...(process.env.EXTRACTOR_BASE_URL === undefined
      ? {}
      : { EXTRACTOR_BASE_URL: process.env.EXTRACTOR_BASE_URL }),
    ...(process.env.EXTRACTOR_API_KEY === undefined
      ? {}
      : { EXTRACTOR_API_KEY: process.env.EXTRACTOR_API_KEY }),
  },
): MemoryExtractor {
  const provider = environment.EXTRACTOR_PROVIDER?.trim() || "heuristic";
  if (provider === "heuristic") {
    return new HeuristicMemoryExtractor();
  }
  if (provider !== "hybrid" && provider !== "openai-compatible") {
    throw new Error(
      `Unsupported EXTRACTOR_PROVIDER "${provider}". Expected "heuristic", "hybrid", or "openai-compatible".`,
    );
  }

  const required = [
    ["EXTRACTOR_BASE_URL", environment.EXTRACTOR_BASE_URL],
    ["EXTRACTOR_API_KEY", environment.EXTRACTOR_API_KEY],
    ["EXTRACTOR_MODEL", environment.EXTRACTOR_MODEL],
  ] as const;
  const missing = required
    .filter(([, value]) => value?.trim() === undefined || value.trim() === "")
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `EXTRACTOR_PROVIDER=${provider} requires ${missing.join(", ")}. Set the missing environment variable${missing.length === 1 ? "" : "s"} or use EXTRACTOR_PROVIDER=heuristic.`,
    );
  }

  const llm = new LlmMemoryExtractor(
    new OpenAiCompatibleHttpProvider({
      baseUrl: environment.EXTRACTOR_BASE_URL as string,
      apiKey: environment.EXTRACTOR_API_KEY as string,
      model: environment.EXTRACTOR_MODEL as string,
    }),
  );
  return provider === "hybrid"
    ? new HybridMemoryExtractor(
        new HeuristicMemoryExtractor(),
        llm,
        parseExtractorMinConfidence(environment),
      )
    : llm;
}

export const createExtractorFromEnv = createMemoryExtractor;
export const createExtractor = createMemoryExtractor;
export const createLearningExtractor = createMemoryExtractor;
export { LlmMemoryExtractor as LlmLearningExtractor };
export {
  OpenAiCompatibleHttpProvider as OpenAICompatibleHttpProvider,
  OpenAiCompatibleHttpProvider as OpenAICompatibleProvider,
};
