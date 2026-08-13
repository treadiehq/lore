import {
  createError,
  getQuery,
  readBody,
  setResponseStatus,
  type H3Event,
} from "h3";
import type { Memory, MemoryCategory, MemoryScope } from "@lore-co/sdk";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const sourceEventId = "11111111-1111-4111-8111-111111111111";
const historicalId = "00000000-0000-4000-8000-000000000001";
const currentId = "00000000-0000-4000-8000-000000000002";
const replacementId = "00000000-0000-4000-8000-000000000003";
const now = "2026-08-13T12:00:00.000Z";

function memory(input: {
  id: string;
  content: string;
  scope: MemoryScope;
  category?: MemoryCategory;
  status?: Memory["status"];
  supersedesMemoryId?: string | null;
  sourceEventId?: string;
  createdAt?: string;
}): Memory {
  return {
    id: input.id,
    workspaceId,
    content: input.content,
    scope: input.scope,
    category: input.category ?? "convention",
    status: input.status ?? "active",
    source: {
      agent: input.sourceEventId === undefined ? "human" : "codex",
      sessionId: "fixture-session",
      rawText: input.content,
      workspaceId,
      ...(input.sourceEventId === undefined
        ? {}
        : { eventId: input.sourceEventId }),
    },
    confidence: 1,
    confirmation: "explicit",
    fingerprint: input.id.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
    supersedesMemoryId: input.supersedesMemoryId ?? null,
    createdAt: input.createdAt ?? now,
    updatedAt: input.createdAt ?? now,
    deletedAt: null,
  };
}

function initialMemories(): Memory[] {
  return [
    memory({
      id: historicalId,
      content: "Use LegacyAccountStore for account writes.",
      scope: {
        organization: "Acme Engineering",
        project: "Commerce",
        repo: "acme/accounts",
        path: "src/accounts",
        component: "billing",
      },
      status: "superseded",
      createdAt: "2026-08-11T10:00:00.000Z",
    }),
    memory({
      id: currentId,
      content: "Use AccountStore for account writes.",
      scope: {
        organization: "Acme Engineering",
        project: "Commerce",
        repo: "acme/accounts",
        path: "src/accounts",
        component: "billing",
      },
      supersedesMemoryId: historicalId,
      sourceEventId,
      createdAt: "2026-08-12T10:00:00.000Z",
    }),
    memory({
      id: "00000000-0000-4000-8000-000000000010",
      content: "Use LedgerStore for ledger writes.",
      scope: {
        organization: "Acme Engineering",
        project: "Finance",
        repo: "acme/ledger",
        path: "src/ledger",
        component: "ledger",
      },
    }),
    ...Array.from({ length: 22 }, (_, index) =>
      memory({
        id: `00000000-0000-4000-8000-${String(index + 20).padStart(12, "0")}`,
        content: `Fixture learning ${index + 1}.`,
        scope: {
          organization: "Acme Engineering",
          project: index % 2 === 0 ? "Commerce" : "Platform",
          repo: index % 2 === 0 ? "acme/accounts" : "acme/platform",
          path: index % 2 === 0 ? "src/accounts" : "src/platform",
          component: index % 2 === 0 ? "billing" : "runtime",
        },
      }),
    ),
  ];
}

function connectorEvent(index = 0) {
  const type = (
    ["paired_turn", "observation", "context_delivery"] as const
  )[index % 3]!;
  const occurredAt = new Date(
    Date.parse("2026-08-13T12:00:00.000Z") - index * 60_000,
  ).toISOString();
  return {
    id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    workspaceId,
    connector: index % 2 === 0 ? "lore-cli" : "devin",
    externalEventId: `fixture-event-${index + 1}`,
    type,
    agent: index % 2 === 0 ? "codex" : "claude",
    sessionId: `fixture-session-${index + 1}`,
    conversationId: null,
    payload:
      type === "context_delivery"
        ? {
            request: {
              task: {
                agent: index % 2 === 0 ? "codex" : "claude",
                task: `Deliver context for fixture task ${index + 1}.`,
              },
            },
          }
        : {},
    redacted: false,
    requestId: `fixture-request-${index + 1}`,
    occurredAt,
    receivedAt: occurredAt,
  };
}

function activityMemory(index: number) {
  return {
    id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    content: `Fixture captured learning ${index + 1}.`,
    category: "correction" as const,
    status: "active" as const,
  };
}

function initialActivities() {
  return Array.from({ length: 45 }, (_, index) => {
    const event = connectorEvent(index);
    const learned =
      event.type === "context_delivery" ? [] : [activityMemory(index)];
    const delivered =
      event.type === "observation" ? [] : [activityMemory(index + 100)];
    return {
      event,
      correction:
        event.type === "paired_turn"
          ? `Human correction for paired turn ${index + 1}.`
          : event.type === "observation"
            ? `Observed user context ${index + 1}.`
            : "",
      learnedMemories: learned,
      deliveredMemories: delivered,
      receipt:
        event.type === "observation"
          ? null
          : {
              id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
              workspaceId,
              eventId: event.id,
              requestId: event.requestId,
              memoryIds: delivered.map((item) => item.id),
              packing: null,
              deliveredAt: event.receivedAt,
            },
    };
  });
}

let memories = initialMemories();
let activities = initialActivities();

export function resetE2eFixture(): void {
  memories = initialMemories();
  activities = initialActivities();
}

export const e2eSession = {
  userId: "44444444-4444-4444-8444-444444444444",
  email: "owner@example.com",
  workspaceId,
  workspaceName: "Acme Engineering",
  organization: "Acme Engineering",
};

function queryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function listLearnings(event: H3Event) {
  const query = getQuery(event);
  const limit = Math.max(1, Math.min(Number(query.limit ?? 50), 100));
  const offset = Math.max(0, Number(query.offset ?? 0));
  const filtered = memories.filter((item) => {
    const status = queryString(query.status);
    const category = queryString(query.category);
    const search = queryString(query.query)?.toLocaleLowerCase();
    return (
      (status === undefined || item.status === status) &&
      (category === undefined || item.category === category) &&
      (search === undefined ||
        item.content.toLocaleLowerCase().includes(search)) &&
      (queryString(query.project) === undefined ||
        item.scope.project === queryString(query.project)) &&
      (queryString(query.repo) === undefined ||
        item.scope.repo === queryString(query.repo)) &&
      (queryString(query.path) === undefined ||
        item.scope.path === queryString(query.path)) &&
      (queryString(query.component) === undefined ||
        item.scope.component === queryString(query.component))
    );
  });
  return {
    memories: filtered.slice(offset, offset + limit),
    total: filtered.length,
    limit,
    offset,
  };
}

function inspection(id: string) {
  const learning = memories.find((item) => item.id === id);
  if (learning === undefined) {
    throw createError({ statusCode: 404, statusMessage: "Learning not found" });
  }
  const sourceEvent =
    learning.source.eventId === sourceEventId
      ? {
          ...connectorEvent(0),
          id: sourceEventId,
          externalEventId: "source-event-1",
          type: "observation" as const,
        }
      : null;
  return {
    learning,
    sourceEvent,
    provenance:
      learning.id === currentId
        ? [
            {
              record: {
                id: "55555555-5555-4555-8555-555555555555",
                workspaceId,
                memoryId: learning.id,
                eventId: sourceEventId,
                messageRole: "user" as const,
                sourceMessageId: "fixture-message-1",
                excerpt: "Use AccountStore for account writes.",
                redacted: false,
                confidence: 1,
                confirmation: "explicit" as const,
                metadata: { connector: "lore-cli" },
                createdAt: "2026-08-12T10:00:00.000Z",
              },
              event: sourceEvent,
            },
          ]
        : [],
    predecessor:
      learning.supersedesMemoryId === null
        ? null
        : (memories.find(
            (item) => item.id === learning.supersedesMemoryId,
          ) ?? null),
    successor:
      memories.find((item) => item.supersedesMemoryId === learning.id) ?? null,
  };
}

async function correctLearning(event: H3Event, id: string) {
  const current = memories.find((item) => item.id === id);
  if (current === undefined) {
    throw createError({ statusCode: 404, statusMessage: "Learning not found" });
  }
  if (current.status !== "active") {
    throw createError({
      statusCode: 409,
      statusMessage: "Only active learnings can be superseded",
    });
  }
  const body = await readBody<{
    content?: string;
    category?: MemoryCategory;
    scope?: MemoryScope;
    source?: Memory["source"];
  }>(event);
  const content = body.content?.trim();
  if (content === undefined || content === "") {
    throw createError({
      statusCode: 400,
      statusMessage: "Corrected content is required",
    });
  }
  current.status = "superseded";
  current.updatedAt = now;
  const replacement = memory({
    id: replacementId,
    content,
    category: body.category ?? "correction",
    scope: {
      ...body.scope,
      organization: current.scope.organization,
    },
    supersedesMemoryId: current.id,
  });
  replacement.source = {
    agent: body.source?.agent ?? "human",
    sessionId: body.source?.sessionId ?? "lore-web-inspection",
    rawText: body.source?.rawText ?? content,
    workspaceId,
  };
  memories = [replacement, ...memories.filter((item) => item.id !== replacement.id)];
  setResponseStatus(event, 201);
  return { memory: replacement, supersededMemory: current };
}

function listActivity(event: H3Event) {
  const query = getQuery(event);
  const limit = Math.max(1, Math.min(Number(query.limit ?? 50), 100));
  const offset = Math.max(0, Number(query.offset ?? 0));
  const from = queryString(query.from);
  const to = queryString(query.to);
  const filtered = activities.filter((item) => {
    const type = queryString(query.type);
    const agent = queryString(query.agent);
    const connector = queryString(query.connector);
    return (
      (type === undefined || item.event.type === type) &&
      (agent === undefined || item.event.agent === agent) &&
      (connector === undefined || item.event.connector === connector) &&
      (from === undefined ||
        Date.parse(item.event.occurredAt) >= Date.parse(from)) &&
      (to === undefined || Date.parse(item.event.occurredAt) <= Date.parse(to))
    );
  });
  return {
    activities: filtered.slice(offset, offset + limit),
    total: filtered.length,
    limit,
    offset,
    hasMore: offset + limit < filtered.length,
  };
}

export async function handleE2eLoreRequest(
  event: H3Event,
  path: string,
  method: string,
): Promise<unknown> {
  if (
    method === "GET" &&
    (path === "v1/learnings" || path === "v1/memories")
  ) {
    return listLearnings(event);
  }
  if (method === "GET" && path === "v1/activity") {
    return listActivity(event);
  }
  const inspectionMatch =
    /^v1\/(?:learnings|memories)\/([^/]+)\/inspection$/u.exec(path);
  if (method === "GET" && inspectionMatch?.[1] !== undefined) {
    return inspection(decodeURIComponent(inspectionMatch[1]));
  }
  const correctionMatch =
    /^v1\/(?:learnings|memories)\/([^/]+)\/corrections$/u.exec(path);
  if (method === "POST" && correctionMatch?.[1] !== undefined) {
    return await correctLearning(
      event,
      decodeURIComponent(correctionMatch[1]),
    );
  }
  throw createError({
    statusCode: 404,
    statusMessage: `Fixture route not found: ${method} ${path}`,
  });
}
