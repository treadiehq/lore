import { describe, expect, it } from "vitest";
import {
  ActivityQuerySchema,
  ObservationRequestSchema,
  PairedTurnRequestSchema,
} from "@lore-co/core";

describe("paired-turn scopes", () => {
  it("keeps task path evidence separate from repository learning context", () => {
    const parsed = PairedTurnRequestSchema.parse({
      connector: "lore-cli",
      eventId: "event-1",
      agent: "claude",
      sessionId: "session-1",
      previousAssistant: "Use RepositoryFactory.",
      currentUser: "Use AccountStore instead.",
      scope: { repo: "acme/accounts", path: "src/accounts" },
      learningScope: { repo: "acme/accounts" },
    });

    expect(parsed.scope).toEqual({
      repo: "acme/accounts",
      path: "src/accounts",
    });
    expect(parsed.learningScope).toEqual({ repo: "acme/accounts" });
  });
});

describe("auditable observation schemas", () => {
  it("accepts a strict first-prompt observation with an external event ID", () => {
    const parsed = ObservationRequestSchema.parse({
      connector: "lore-cli",
      eventId: "prompt-1",
      agent: "claude",
      sessionId: "session-1",
      scope: { repo: "acme/accounts" },
      task: "Use AccountStore",
      messages: [
        {
          role: "user",
          id: "message-1",
          content: "Always use AccountStore.",
        },
      ],
      occurredAt: "2026-08-13T12:00:00.000Z",
      metadata: { source: "native-hook" },
    });

    expect(parsed.eventId).toBe("prompt-1");
    expect(parsed.scope).toEqual({ repo: "acme/accounts" });
    expect(parsed.learningScope).toEqual({});
    expect(() =>
      ObservationRequestSchema.parse({ ...parsed, workspaceId: crypto.randomUUID() }),
    ).toThrow();
  });

  it("validates activity filters and paging", () => {
    expect(
      ActivityQuerySchema.parse({
        type: "observation",
        connector: "lore-cli",
        agent: "codex",
        from: "2026-08-13T10:00:00.000Z",
        to: "2026-08-13T12:00:00.000Z",
        limit: "25",
        offset: "50",
      }),
    ).toMatchObject({ limit: 25, offset: 50 });
    expect(() =>
      ActivityQuerySchema.parse({
        from: "2026-08-13T13:00:00.000Z",
        to: "2026-08-13T12:00:00.000Z",
      }),
    ).toThrow();
  });
});
