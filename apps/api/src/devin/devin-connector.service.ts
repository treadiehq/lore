import { createHash, randomUUID } from "node:crypto";
import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import {
  DevinSessionRegistrationSchema,
  DevinSessionRegistrationResponseSchema,
  redactUnknown,
  stripLoreInjectedContext,
  type AuthenticatedWorkspace,
  type DevinSessionRegistration,
  type DevinSessionRegistrationResponse,
  type PairedTurnRequest,
} from "@lore-co/core";
import type {
  DevinSessionCheckpoint,
  DevinSessionCursor,
  PostgresDevinConnectorRepository,
} from "@lore-co/database";
import { z } from "zod";
import { DEVIN_CONNECTOR_REPOSITORY } from "../common/tokens.js";
import { TurnService } from "../turn/turn.service.js";

const DevinMessageSchema = z
  .object({
    event_id: z.string().trim().min(1).max(500),
    source: z.enum(["user", "devin"]),
    message: z.string().max(100_000),
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

const DevinSessionSchema = z
  .object({
    status: z.enum([
      "new",
      "claimed",
      "running",
      "exit",
      "error",
      "suspended",
      "resuming",
    ]),
    is_archived: z.boolean().default(false),
  })
  .passthrough();

type DevinMessage = z.infer<typeof DevinMessageSchema>;
type DevinMessagePage = z.infer<typeof DevinMessagePageSchema>;

interface DevinConnectorConfig {
  apiKey: string;
  organizationId: string;
  repositories: Set<string>;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  batchSize: number;
}

function boundedInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return value;
}

function connectorConfig(): DevinConnectorConfig | null {
  const enabled = process.env.DEVIN_POLLING_ENABLED?.trim().toLowerCase();
  if (enabled !== "true" && enabled !== "1") {
    return null;
  }
  const apiKey = process.env.DEVIN_API_KEY?.trim();
  const organizationId = process.env.DEVIN_ORG_ID?.trim();
  const repositories = new Set(
    (process.env.DEVIN_REPOSITORY_ALLOWLIST ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (
    apiKey === undefined ||
    apiKey === "" ||
    organizationId === undefined ||
    organizationId === ""
  ) {
    throw new Error(
      "DEVIN_API_KEY and DEVIN_ORG_ID are required when DEVIN_POLLING_ENABLED=true",
    );
  }
  if (repositories.size === 0) {
    throw new Error(
      "DEVIN_REPOSITORY_ALLOWLIST is required when DEVIN_POLLING_ENABLED=true",
    );
  }
  return {
    apiKey,
    organizationId,
    repositories,
    pollIntervalMs: boundedInteger(
      "DEVIN_POLL_INTERVAL_MS",
      15_000,
      5_000,
      300_000,
    ),
    requestTimeoutMs: boundedInteger(
      "DEVIN_REQUEST_TIMEOUT_MS",
      10_000,
      1_000,
      30_000,
    ),
    batchSize: boundedInteger("DEVIN_POLL_BATCH_SIZE", 25, 1, 100),
  };
}

function eventIdentity(
  organizationId: string,
  sessionId: string,
  eventId: string,
): string {
  return `devin:${createHash("sha256")
    .update(`${organizationId}\0${sessionId}\0${eventId}`)
    .digest("hex")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timestamp(value: number): Date {
  const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Devin message contains an invalid created_at timestamp");
  }
  return date;
}

@Injectable()
export class DevinConnectorService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  readonly #repository: PostgresDevinConnectorRepository;
  readonly #turns: TurnService;
  readonly #config: DevinConnectorConfig | null;
  #timer: NodeJS.Timeout | undefined;
  #polling = false;
  #stopped = false;

  constructor(
    @Inject(DEVIN_CONNECTOR_REPOSITORY)
    repository: PostgresDevinConnectorRepository,
    turns: TurnService,
  ) {
    this.#repository = repository;
    this.#turns = turns;
    this.#config = connectorConfig();
  }

  onApplicationBootstrap(): void {
    if (this.#config === null) {
      return;
    }
    this.#schedule(0);
  }

  onApplicationShutdown(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  async register(
    input: DevinSessionRegistration,
    workspace: AuthenticatedWorkspace,
  ): Promise<DevinSessionRegistrationResponse> {
    const registration = DevinSessionRegistrationSchema.parse(input);
    const config = this.#requireConfig();
    if (registration.organizationId !== config.organizationId) {
      throw new ServiceUnavailableException(
        "The Devin organization does not match this Lore deployment",
      );
    }
    if (!config.repositories.has(registration.repo)) {
      throw new ServiceUnavailableException(
        "The repository is not in DEVIN_REPOSITORY_ALLOWLIST",
      );
    }
    const row = await this.#repository.register({
      workspaceId: workspace.workspaceId,
      organizationId: registration.organizationId,
      sessionId: registration.sessionId,
      ...(registration.project === undefined
        ? {}
        : { project: registration.project }),
      repo: registration.repo,
    });
    return DevinSessionRegistrationResponseSchema.parse({
      registered: true,
      sessionId: row.sessionId,
      status: row.status,
    });
  }

  async pollNow(): Promise<void> {
    if (this.#config === null || this.#polling) {
      return;
    }
    this.#polling = true;
    try {
      const sessions = await this.#repository.listActive(
        this.#config.batchSize,
      );
      for (const session of sessions) {
        try {
          await this.#pollSession(session, this.#config);
        } catch (error) {
          await this.#repository.recordError(
            session.id,
            errorMessage(error),
          );
        }
      }
    } finally {
      this.#polling = false;
    }
  }

  #requireConfig(): DevinConnectorConfig {
    if (this.#config === null) {
      throw new ServiceUnavailableException(
        "Devin polling is not enabled for this Lore deployment",
      );
    }
    return this.#config;
  }

  #schedule(delay: number): void {
    if (this.#stopped || this.#config === null) {
      return;
    }
    this.#timer = setTimeout(() => {
      void this.pollNow().finally(() => {
        this.#schedule(this.#config?.pollIntervalMs ?? 15_000);
      });
    }, delay);
    this.#timer.unref();
  }

  async #pollSession(
    session: DevinSessionCursor,
    config: DevinConnectorConfig,
  ): Promise<void> {
    if (
      session.organizationId !== config.organizationId ||
      !config.repositories.has(session.repo)
    ) {
      return;
    }
    const remote = await this.#session(config, session.sessionId);
    let checkpoint: DevinSessionCheckpoint = {
      cursor: session.cursor,
      pendingAssistantId: session.pendingAssistantId,
      pendingAssistantContent: session.pendingAssistantContent,
      pendingAssistantAt: session.pendingAssistantAt,
    };
    const persistedMessageId = session.cursor;
    let checkpointFound = persistedMessageId === null;
    let pageCursor: string | null = null;
    let pageCount = 0;
    let hasNextPage = false;
    do {
      const page = await this.#messages(
        config,
        session.sessionId,
        pageCursor,
      );
      for (const message of page.items) {
        if (!checkpointFound) {
          if (message.event_id === persistedMessageId) {
            checkpointFound = true;
          }
          continue;
        }
        checkpoint = await this.#processMessage(
          session,
          checkpoint,
          message,
        );
        checkpoint.cursor = message.event_id;
        await this.#repository.checkpoint(session.id, checkpoint);
      }
      pageCount += 1;
      hasNextPage = page.has_next_page;
      if (!hasNextPage) {
        break;
      }
      if (page.end_cursor === undefined || page.end_cursor === null) {
        throw new Error("Devin message pagination omitted end_cursor");
      }
      pageCursor = page.end_cursor;
    } while (pageCount < 20);
    if (hasNextPage) {
      throw new Error("Devin message pagination exceeded 20 pages");
    }
    if (!checkpointFound) {
      throw new Error("Devin transcript no longer contains the saved message");
    }
    await this.#repository.checkpoint(session.id, checkpoint);
    if (
      remote.is_archived ||
      remote.status === "exit" ||
      remote.status === "error" ||
      remote.status === "suspended"
    ) {
      await this.#repository.setStatus(
        {
          workspaceId: session.workspaceId,
          organizationId: session.organizationId,
          sessionId: session.sessionId,
        },
        "paused",
      );
    }
  }

  async #processMessage(
    session: DevinSessionCursor,
    checkpoint: DevinSessionCheckpoint,
    message: DevinMessage,
  ): Promise<DevinSessionCheckpoint> {
    const redacted = redactUnknown(message.message);
    const content =
      typeof redacted.value === "string" ? redacted.value : message.message;
    if (message.source === "devin") {
      return {
        ...checkpoint,
        pendingAssistantId: message.event_id,
        pendingAssistantContent: content,
        pendingAssistantAt: timestamp(message.created_at),
      };
    }
    if (checkpoint.pendingAssistantContent === null) {
      return checkpoint;
    }
    const userContent = stripLoreInjectedContext(content).trim();
    if (userContent === "") {
      return {
        ...checkpoint,
        pendingAssistantId: null,
        pendingAssistantContent: null,
        pendingAssistantAt: null,
      };
    }
    const occurredAt = timestamp(message.created_at).toISOString();
    const turn: PairedTurnRequest = {
      connector: "devin-poller",
      eventId: eventIdentity(
        session.organizationId,
        session.sessionId,
        message.event_id,
      ),
      agent: "devin",
      sessionId: session.sessionId,
      previousAssistant: {
        content: checkpoint.pendingAssistantContent,
        ...(checkpoint.pendingAssistantId === null
          ? {}
          : { id: checkpoint.pendingAssistantId }),
        ...(checkpoint.pendingAssistantAt === null
          ? {}
          : { timestamp: checkpoint.pendingAssistantAt.toISOString() }),
      },
      currentUser: {
        content: userContent,
        id: message.event_id,
        timestamp: occurredAt,
      },
      scope: {
        ...(session.project === null ? {} : { project: session.project }),
        repo: session.repo,
      },
      learningScope: {},
      task: userContent,
      occurredAt,
      metadata: {
        devinOrganizationId: session.organizationId,
        transcriptCursor: checkpoint.cursor,
        redacted: redacted.redacted,
      },
    };
    await this.#turns.process(
      turn,
      {
        workspaceId: session.workspaceId,
        organization: session.workspaceOrganization,
      },
      randomUUID(),
      turn.eventId,
    );
    return {
      ...checkpoint,
      pendingAssistantId: null,
      pendingAssistantContent: null,
      pendingAssistantAt: null,
    };
  }

  async #messages(
    config: DevinConnectorConfig,
    sessionId: string,
    cursor: string | null,
  ): Promise<DevinMessagePage> {
    const query = new URLSearchParams({ first: "200" });
    if (cursor !== null) {
      query.set("after", cursor);
    }
    const path = `/v3/organizations/${encodeURIComponent(
      config.organizationId,
    )}/sessions/${encodeURIComponent(sessionId)}/messages?${query}`;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response: Response | undefined;
      try {
        response = await fetch(`https://api.devin.ai${path}`, {
          headers: {
            accept: "application/json",
            authorization: `Bearer ${config.apiKey}`,
          },
          signal: AbortSignal.timeout(config.requestTimeoutMs),
        });
      } catch (error) {
        lastError =
          error instanceof Error ? error : new Error(String(error));
      }
      if (response !== undefined) {
        if (response.ok) {
          return DevinMessagePageSchema.parse(await response.json());
        }
        const detail = (await response.text()).slice(0, 500);
        const retryable = response.status === 429 || response.status >= 500;
        lastError = new Error(
          `Devin messages failed with HTTP ${response.status}: ${detail}`,
        );
        if (!retryable) {
          throw lastError;
        }
      }
      if (attempt < 2) {
        await new Promise((resolvePromise) =>
          setTimeout(resolvePromise, 250 * 2 ** attempt),
        );
      }
    }
    throw lastError ?? new Error("Devin messages request failed");
  }

  async #session(
    config: DevinConnectorConfig,
    sessionId: string,
  ): Promise<z.infer<typeof DevinSessionSchema>> {
    const path = `/v3/organizations/${encodeURIComponent(
      config.organizationId,
    )}/sessions/${encodeURIComponent(sessionId)}`;
    const response = await fetch(`https://api.devin.ai${path}`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(
        `Devin session failed with HTTP ${response.status}: ${detail}`,
      );
    }
    return DevinSessionSchema.parse((await response.json()) as unknown);
  }
}
