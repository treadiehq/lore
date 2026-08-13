import {
  CorrectMemoryResponseSchema,
  ContextPackingSchema,
  ForgetMemoryResponseSchema,
  GetContextResponseSchema,
  GetMemoryResponseSchema,
  ListMemoriesResponseSchema,
  ObserveResponseSchema,
  RememberResponseSchema,
  UpdateMemoryResponseSchema,
  type AgentInteraction,
  type AgentTask,
  type CorrectMemoryDto,
  type CorrectMemoryResponse,
  type ContextPacking,
  type CreateMemoryDto,
  type ForgetMemoryResponse,
  type GetMemoryResponse,
  type ListMemoriesDto,
  type ListMemoriesResponse,
  type MemoryCategory,
  type MemoryScope,
  type ObserveResponse,
  type RememberResponse,
  type UpdateMemoryResponse,
} from "@lore-co/core/schemas";
import {
  ActivityListResponseSchema,
  ActivityQuerySchema,
  ContextDeliveryResponseSchema,
  DevinSessionRegistrationResponseSchema,
  LearningInspectionResponseSchema,
  ObservationResponseSchema,
  PairedTurnResponseSchema,
  type ActivityListResponse,
  type ActivityQuery,
  type ConnectorEvent,
  type ContextDeliveryRequest,
  type ContextDeliveryResponse,
  type DeliveryReceipt,
  type DevinSessionRegistration,
  type DevinSessionRegistrationResponse,
  type LearningInspectionResponse,
  type ObservationRequestInput,
  type ObservationResponse,
  type PairedTurnRequest,
  type PairedTurnResponse,
  type TurnObservation,
} from "@lore-co/core/pilot-schemas";
import {
  CreateWorkspaceTokenResponseSchema,
  ListWorkspaceTokensResponseSchema,
  RevokeWorkspaceTokenResponseSchema,
  type CreateWorkspaceTokenRequest,
  type CreateWorkspaceTokenResponse,
  type ListWorkspaceTokensResponse,
  type RevokeWorkspaceTokenResponse,
  type WorkspaceToken,
  type WorkspaceTokenStatus,
} from "@lore-co/core/auth-schemas";
import { z, type ZodType } from "zod";

export type {
  AgentInteraction,
  AgentMessage,
  AgentTask,
  CorrectMemoryResponse,
  ContextPacking,
  ForgetMemoryResponse,
  GetMemoryResponse,
  ListMemoriesResponse,
  Memory,
  MemoryCategory,
  MemoryScope,
  MemorySource,
  MemoryStatus,
  Learning,
  LearningCategory,
  LearningScope,
  LearningSource,
  LearningStatus,
  ObserveResponse,
  RememberResponse,
  UpdateMemoryResponse,
} from "@lore-co/core/schemas";
export type {
  ActivityItem,
  ActivityListResponse,
  ActivityQuery,
  ConnectorEvent,
  ContextDeliveryRequest,
  ContextDeliveryResponse,
  DeliveryReceipt,
  DevinSessionRegistration,
  DevinSessionRegistrationResponse,
  LearningInspectionProvenance,
  LearningInspectionResponse,
  ObservationRequest,
  ObservationRequestInput,
  ObservationResponse,
  PairedTurnRequest,
  PairedTurnResponse,
  TurnObservation,
} from "@lore-co/core/pilot-schemas";
export type {
  CreateWorkspaceTokenRequest,
  CreateWorkspaceTokenResponse,
  ListWorkspaceTokensResponse,
  RevokeWorkspaceTokenResponse,
  WorkspaceToken,
  WorkspaceTokenStatus,
} from "@lore-co/core/auth-schemas";

export interface SharedMemoryClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  headers?: HeadersInit;
}
export type LoreClientOptions = SharedMemoryClientOptions;

export interface ScopeInput {
  scope?: MemoryScope;
  organization?: string;
  project?: string;
  repo?: string;
  path?: string;
  component?: string;
}

export type RememberInput = Omit<CreateMemoryDto, "scope"> & ScopeInput;
export type CorrectMemoryInput = Omit<CorrectMemoryDto, "memoryId">;
export type ListMemoriesInput = Omit<ListMemoriesDto, "scope"> & ScopeInput;
export type CreateLearningInput = RememberInput;
export type CorrectLearningInput = CorrectMemoryInput;
export type ListLearningsInput = ListMemoriesInput;

export interface UpdateMemoryInput {
  content?: string;
  scope?: MemoryScope;
  category?: MemoryCategory;
}
export type UpdateLearningInput = UpdateMemoryInput;

export interface ContextResponse {
  memories: GetContextResponse["memories"];
  context: string;
  packing: ContextPacking;
}

type GetContextResponse = z.infer<typeof GetContextResponseSchema>;

const FormattedContextResponseSchema = GetContextResponseSchema.extend({
  context: z.string(),
  packing: ContextPackingSchema,
});

function parseResponseBody(text: string): unknown {
  if (text.trim() === "") {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class SharedMemoryApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly url: string;
  readonly details: unknown;

  constructor(input: {
    status: number;
    method: string;
    url: string;
    details: unknown;
  }) {
    const detailMessage =
      typeof input.details === "object" &&
      input.details !== null &&
      "message" in input.details
        ? String(input.details.message)
        : typeof input.details === "string"
          ? input.details
          : "";
    super(
      `${input.method} ${input.url} failed with HTTP ${input.status}${detailMessage === "" ? "" : `: ${detailMessage}`}`,
    );
    this.name = "SharedMemoryApiError";
    this.status = input.status;
    this.method = input.method;
    this.url = input.url;
    this.details = input.details;
  }
}

export class SharedMemoryClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #headers: HeadersInit;

  constructor(options: SharedMemoryClientOptions) {
    const baseUrl = options.baseUrl.trim().replace(/\/+$/u, "");
    if (baseUrl === "") {
      throw new Error("SharedMemoryClient baseUrl is required");
    }
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    if (fetchImplementation === undefined) {
      throw new Error("A Fetch API implementation is required");
    }
    this.#baseUrl = baseUrl;
    this.#fetch = fetchImplementation.bind(globalThis);
    this.#headers = options.headers ?? {};
  }

  async #request<T>(
    method: string,
    path: string,
    schema: ZodType<T>,
    body?: unknown,
    requestHeaders?: HeadersInit,
  ): Promise<T> {
    const url = `${this.#baseUrl}${path}`;
    const headers = new Headers(this.#headers);
    for (const [name, value] of new Headers(requestHeaders)) {
      headers.set(name, value);
    }
    headers.set("accept", "application/json");
    if (body !== undefined) {
      headers.set("content-type", "application/json");
    }
    const response = await this.#fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = parseResponseBody(await response.text());
    if (!response.ok) {
      throw new SharedMemoryApiError({
        status: response.status,
        method,
        url,
        details: parsed,
      });
    }
    if (parsed === undefined) {
      return undefined as T;
    }
    return schema.parse(parsed);
  }

  observe(input: AgentInteraction): Promise<ObserveResponse> {
    return this.#request(
      "POST",
      "/v1/interactions",
      ObserveResponseSchema,
      input,
    );
  }

  observeEvent(input: ObservationRequestInput): Promise<ObservationResponse> {
    return this.#request(
      "POST",
      "/v1/observations",
      ObservationResponseSchema,
      input,
    );
  }

  observeObservation(
    input: ObservationRequestInput,
  ): Promise<ObservationResponse> {
    return this.observeEvent(input);
  }

  processTurn(
    input: PairedTurnRequest,
    idempotencyKey?: string,
  ): Promise<PairedTurnResponse> {
    return this.#request(
      "POST",
      "/v1/turns",
      PairedTurnResponseSchema,
      input,
      idempotencyKey === undefined
        ? undefined
        : { "idempotency-key": idempotencyKey },
    );
  }

  getContext(input: AgentTask): Promise<ContextResponse> {
    return this.#request(
      "POST",
      "/v1/context",
      FormattedContextResponseSchema,
      input,
    );
  }

  registerDevinSession(
    input: DevinSessionRegistration,
  ): Promise<DevinSessionRegistrationResponse> {
    return this.#request(
      "POST",
      "/v1/connectors/devin/sessions",
      DevinSessionRegistrationResponseSchema,
      input,
    );
  }

  deliverContext(
    input: ContextDeliveryRequest,
  ): Promise<ContextDeliveryResponse> {
    return this.#request(
      "POST",
      "/v1/context/deliveries",
      ContextDeliveryResponseSchema,
      input,
    );
  }

  remember(input: RememberInput): Promise<RememberResponse> {
    return this.#request(
      "POST",
      "/v1/memories",
      RememberResponseSchema,
      input,
    );
  }

  getMemory(id: string): Promise<GetMemoryResponse> {
    return this.#request(
      "GET",
      `/v1/memories/${encodeURIComponent(id)}`,
      GetMemoryResponseSchema,
    );
  }

  listMemories(
    input: ListMemoriesInput = {},
  ): Promise<ListMemoriesResponse> {
    return this.#listMemoriesAt("/v1/memories", input);
  }

  #listMemoriesAt(
    path: string,
    input: ListMemoriesInput,
  ): Promise<ListMemoriesResponse> {
    const query = new URLSearchParams();
    const scope = input.scope ?? {};
    const organization = scope.organization ?? input.organization;
    const project = scope.project ?? input.project;
    const repo = scope.repo ?? input.repo;
    const learningPath = scope.path ?? input.path;
    const component = scope.component ?? input.component;
    if (input.query !== undefined) {
      query.set("query", input.query);
    }
    const categories =
      input.category === undefined
        ? []
        : Array.isArray(input.category)
          ? input.category
          : [input.category];
    for (const category of categories) {
      query.append("category", category);
    }
    const statuses =
      input.status === undefined
        ? []
        : Array.isArray(input.status)
          ? input.status
          : [input.status];
    for (const status of statuses) {
      query.append("status", status);
    }
    if (organization !== undefined) {
      query.set("organization", organization);
    }
    if (project !== undefined) {
      query.set("project", project);
    }
    if (repo !== undefined) {
      query.set("repo", repo);
    }
    if (learningPath !== undefined) {
      query.set("path", learningPath);
    }
    if (component !== undefined) {
      query.set("component", component);
    }
    if (input.limit !== undefined) {
      query.set("limit", String(input.limit));
    }
    if (input.offset !== undefined) {
      query.set("offset", String(input.offset));
    }
    const serialized = query.toString();
    return this.#request(
      "GET",
      `${path}${serialized === "" ? "" : `?${serialized}`}`,
      ListMemoriesResponseSchema,
    );
  }

  createLearning(input: RememberInput): Promise<RememberResponse> {
    return this.#request(
      "POST",
      "/v1/learnings",
      RememberResponseSchema,
      input,
    );
  }

  getLearning(id: string): Promise<GetMemoryResponse> {
    return this.#request(
      "GET",
      `/v1/learnings/${encodeURIComponent(id)}`,
      GetMemoryResponseSchema,
    );
  }

  inspectLearning(id: string): Promise<LearningInspectionResponse> {
    return this.#request(
      "GET",
      `/v1/learnings/${encodeURIComponent(id)}/inspection`,
      LearningInspectionResponseSchema,
    );
  }

  listLearnings(
    input: ListMemoriesInput = {},
  ): Promise<ListMemoriesResponse> {
    return this.#listMemoriesAt("/v1/learnings", input);
  }

  updateLearning(
    id: string,
    input: UpdateMemoryInput,
  ): Promise<UpdateMemoryResponse> {
    return this.#request(
      "PATCH",
      `/v1/learnings/${encodeURIComponent(id)}`,
      UpdateMemoryResponseSchema,
      input,
    );
  }

  correctLearning(
    id: string,
    input: CorrectMemoryInput,
  ): Promise<CorrectMemoryResponse> {
    return this.#request(
      "POST",
      `/v1/learnings/${encodeURIComponent(id)}/corrections`,
      CorrectMemoryResponseSchema,
      input,
    );
  }

  forgetLearning(id: string): Promise<ForgetMemoryResponse> {
    return this.#request(
      "DELETE",
      `/v1/learnings/${encodeURIComponent(id)}`,
      ForgetMemoryResponseSchema,
    );
  }

  updateMemory(
    id: string,
    input: UpdateMemoryInput,
  ): Promise<UpdateMemoryResponse> {
    return this.#request(
      "PATCH",
      `/v1/memories/${encodeURIComponent(id)}`,
      UpdateMemoryResponseSchema,
      input,
    );
  }

  correct(
    id: string,
    input: CorrectMemoryInput,
  ): Promise<CorrectMemoryResponse> {
    return this.#request(
      "POST",
      `/v1/memories/${encodeURIComponent(id)}/corrections`,
      CorrectMemoryResponseSchema,
      input,
    );
  }

  forget(id: string): Promise<ForgetMemoryResponse> {
    return this.#request(
      "DELETE",
      `/v1/memories/${encodeURIComponent(id)}`,
      ForgetMemoryResponseSchema,
    );
  }

  listActivity(input: ActivityQuery = {}): Promise<ActivityListResponse> {
    const filters = ActivityQuerySchema.parse(input);
    const query = new URLSearchParams();
    if (filters.type !== undefined) {
      query.set("type", filters.type);
    }
    if (filters.agent !== undefined) {
      query.set("agent", filters.agent);
    }
    if (filters.connector !== undefined) {
      query.set("connector", filters.connector);
    }
    if (filters.from !== undefined) {
      query.set("from", filters.from);
    }
    if (filters.to !== undefined) {
      query.set("to", filters.to);
    }
    if (filters.limit !== undefined) {
      query.set("limit", String(filters.limit));
    }
    if (filters.offset !== undefined) {
      query.set("offset", String(filters.offset));
    }
    const serialized = query.toString();
    return this.#request(
      "GET",
      `/v1/activity${serialized === "" ? "" : `?${serialized}`}`,
      ActivityListResponseSchema,
    );
  }

  listWorkspaceTokens(): Promise<ListWorkspaceTokensResponse> {
    return this.#request(
      "GET",
      "/v1/workspace-tokens",
      ListWorkspaceTokensResponseSchema,
    );
  }

  createWorkspaceToken(
    input: CreateWorkspaceTokenRequest,
  ): Promise<CreateWorkspaceTokenResponse> {
    return this.#request(
      "POST",
      "/v1/workspace-tokens",
      CreateWorkspaceTokenResponseSchema,
      input,
    );
  }

  revokeWorkspaceToken(
    tokenId: string,
  ): Promise<RevokeWorkspaceTokenResponse> {
    return this.#request(
      "DELETE",
      `/v1/workspace-tokens/${encodeURIComponent(tokenId)}`,
      RevokeWorkspaceTokenResponseSchema,
    );
  }
}

export class LoreClient extends SharedMemoryClient {}
export { SharedMemoryApiError as LoreApiError };
