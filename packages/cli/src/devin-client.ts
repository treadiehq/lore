import { z, type ZodType } from "zod";

const DevinSessionSchema = z
  .object({
    session_id: z.string().min(1),
    url: z.string().url(),
    status: z.enum([
      "new",
      "claimed",
      "running",
      "exit",
      "error",
      "suspended",
      "resuming",
    ]),
    status_detail: z.string().nullable().optional(),
    structured_output: z.record(z.string(), z.unknown()).nullable().optional(),
    acus_consumed: z.number().nonnegative().optional(),
    is_archived: z.boolean().optional(),
  })
  .passthrough();

const DevinMessageSchema = z
  .object({
    event_id: z.string().min(1),
    source: z.enum(["user", "devin"]),
    message: z.string(),
    created_at: z.number().int().nonnegative(),
  })
  .passthrough();

const DevinMessagePageSchema = z
  .object({
    items: z.array(DevinMessageSchema).default([]),
    has_next_page: z.boolean().default(false),
    end_cursor: z.string().min(1).nullable().optional(),
  })
  .passthrough();

const DevinSessionPageSchema = z
  .object({
    items: z.array(DevinSessionSchema).default([]),
    has_next_page: z.boolean().default(false),
    end_cursor: z.string().min(1).nullable().optional(),
  })
  .passthrough();

export type DevinSession = z.infer<typeof DevinSessionSchema>;
export type DevinMessage = z.infer<typeof DevinMessageSchema>;

export interface CreateDevinSessionInput {
  prompt: string;
  repos?: readonly string[];
  title?: string;
  tags?: readonly string[];
  createAsUserId?: string;
  maxAcuLimit?: number;
  structuredOutputRequired?: boolean;
  structuredOutputSchema?: Record<string, unknown>;
  resumable?: boolean;
}

export interface DevinApiClientOptions {
  apiKey: string;
  organizationId: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  maximumRetries?: number;
}

function integer(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isInteger(resolved) ||
    resolved < minimum ||
    resolved > maximum
  ) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return resolved;
}

function required(value: string, name: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new Error(`${name} is required`);
  }
  return trimmed;
}

export class DevinApiClient {
  readonly #apiKey: string;
  readonly #organizationId: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #timeoutMs: number;
  readonly #maximumRetries: number;

  constructor(options: DevinApiClientOptions) {
    this.#apiKey = required(options.apiKey, "DEVIN_API_KEY");
    this.#organizationId = required(
      options.organizationId,
      "DEVIN_ORG_ID",
    );
    this.#baseUrl = (options.baseUrl ?? "https://api.devin.ai").replace(
      /\/+$/u,
      "",
    );
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolvePromise) =>
          setTimeout(resolvePromise, milliseconds),
        ));
    this.#timeoutMs = integer(
      options.timeoutMs,
      30_000,
      1_000,
      60_000,
      "Devin request timeout",
    );
    this.#maximumRetries = integer(
      options.maximumRetries,
      2,
      0,
      5,
      "Devin maximum retries",
    );
  }

  get organizationId(): string {
    return this.#organizationId;
  }

  createSession(input: CreateDevinSessionInput): Promise<DevinSession> {
    const prompt = required(input.prompt, "Devin session prompt");
    const maxAcuLimit =
      input.maxAcuLimit === undefined
        ? undefined
        : integer(input.maxAcuLimit, 1, 1, 100, "max ACU limit");
    return this.#request(
      "POST",
      `/v3/organizations/${encodeURIComponent(this.#organizationId)}/sessions`,
      DevinSessionSchema,
      {
        prompt,
        devin_mode: "normal",
        resumable: input.resumable ?? false,
        bypass_approval: false,
        ...(input.repos === undefined ? {} : { repos: [...input.repos] }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.tags === undefined ? {} : { tags: [...input.tags] }),
        ...(input.createAsUserId === undefined
          ? {}
          : { create_as_user_id: input.createAsUserId }),
        ...(maxAcuLimit === undefined
          ? {}
          : { max_acu_limit: maxAcuLimit }),
        ...(input.structuredOutputRequired === undefined
          ? {}
          : {
              structured_output_required: input.structuredOutputRequired,
            }),
        ...(input.structuredOutputSchema === undefined
          ? {}
          : { structured_output_schema: input.structuredOutputSchema }),
      },
    );
  }

  getSession(sessionId: string): Promise<DevinSession> {
    return this.#request(
      "GET",
      `/v3/organizations/${encodeURIComponent(
        this.#organizationId,
      )}/sessions/${encodeURIComponent(required(sessionId, "Devin session ID"))}`,
      DevinSessionSchema,
    );
  }

  async checkAccess(): Promise<void> {
    await this.#request(
      "GET",
      `/v3/organizations/${encodeURIComponent(
        this.#organizationId,
      )}/sessions?first=1`,
      DevinSessionPageSchema,
    );
  }

  async listMessages(sessionId: string): Promise<DevinMessage[]> {
    const messages: DevinMessage[] = [];
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 50; pageIndex += 1) {
      const query = new URLSearchParams({ first: "200" });
      if (cursor !== undefined) {
        query.set("after", cursor);
      }
      const page = await this.#request(
        "GET",
        `/v3/organizations/${encodeURIComponent(
          this.#organizationId,
        )}/sessions/${encodeURIComponent(
          required(sessionId, "Devin session ID"),
        )}/messages?${query}`,
        DevinMessagePageSchema,
      );
      messages.push(...page.items);
      if (!page.has_next_page) {
        return messages;
      }
      if (page.end_cursor === undefined || page.end_cursor === null) {
        throw new Error("Devin message pagination omitted end_cursor");
      }
      cursor = page.end_cursor;
    }
    throw new Error("Devin message pagination exceeded 50 pages");
  }

  sendMessage(
    sessionId: string,
    message: string,
    messageAsUserId?: string,
  ): Promise<Record<string, unknown>> {
    return this.#request(
      "POST",
      `/v3/organizations/${encodeURIComponent(
        this.#organizationId,
      )}/sessions/${encodeURIComponent(required(sessionId, "Devin session ID"))}/messages`,
      z.record(z.string(), z.unknown()),
      {
        message: required(message, "Devin message"),
        ...(messageAsUserId === undefined
          ? {}
          : { message_as_user_id: messageAsUserId }),
      },
    );
  }

  async archiveSession(sessionId: string): Promise<void> {
    await this.#request(
      "DELETE",
      `/v3/organizations/${encodeURIComponent(
        this.#organizationId,
      )}/sessions/${encodeURIComponent(
        required(sessionId, "Devin session ID"),
      )}?archive=true`,
      z.unknown(),
      undefined,
      true,
    );
  }

  async waitForCompletion(
    sessionId: string,
    timeoutMs = 30 * 60_000,
    pollIntervalMs = 10_000,
  ): Promise<DevinSession> {
    const boundedTimeout = integer(
      timeoutMs,
      30 * 60_000,
      1_000,
      60 * 60_000,
      "Devin session timeout",
    );
    const boundedInterval = integer(
      pollIntervalMs,
      10_000,
      250,
      60_000,
      "Devin poll interval",
    );
    const deadline = Date.now() + boundedTimeout;
    while (Date.now() < deadline) {
      const session = await this.getSession(sessionId);
      if (
        session.status === "exit" ||
        session.status_detail === "finished" ||
        session.status_detail === "waiting_for_user"
      ) {
        return session;
      }
      if (
        session.status === "error" ||
        session.status === "suspended" ||
        session.status_detail === "error" ||
        session.status_detail === "out_of_credits" ||
        session.status_detail === "out_of_quota" ||
        session.status_detail === "usage_limit_exceeded"
      ) {
        throw new Error(
          `Devin session stopped in ${session.status}${
            session.status_detail === undefined ||
            session.status_detail === null
              ? ""
              : `/${session.status_detail}`
          }`,
        );
      }
      await this.#sleep(boundedInterval);
    }
    throw new Error(`Devin session timed out after ${boundedTimeout}ms`);
  }

  async #request<T>(
    method: string,
    path: string,
    schema: ZodType<T>,
    body?: unknown,
    allowEmpty = false,
  ): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.#maximumRetries; attempt += 1) {
      let response: Response;
      try {
        response = await this.#fetch(`${this.#baseUrl}${path}`, {
          method,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.#apiKey}`,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (error) {
        lastError =
          error instanceof Error ? error : new Error(String(error));
        if (attempt < this.#maximumRetries) {
          await this.#sleep(250 * 2 ** attempt);
          continue;
        }
        break;
      }
      if (response.ok) {
        if (allowEmpty && response.status === 204) {
          return undefined as T;
        }
        const text = await response.text();
        if (allowEmpty && text.trim() === "") {
          return undefined as T;
        }
        try {
          return schema.parse(JSON.parse(text) as unknown);
        } catch (error) {
          throw new Error(
            `Devin API returned an invalid response for ${method} ${path}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      const detail = (await response.text()).slice(0, 500);
      lastError = new Error(
        `Devin API ${method} ${path} failed with HTTP ${response.status}: ${detail}`,
      );
      if (
        response.status !== 429 &&
        response.status < 500
      ) {
        throw lastError;
      }
      if (attempt < this.#maximumRetries) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await this.#sleep(
          Number.isFinite(retryAfter) && retryAfter >= 0
            ? retryAfter * 1_000
            : 250 * 2 ** attempt,
        );
      }
    }
    throw lastError ?? new Error(`Devin API ${method} ${path} failed`);
  }
}
