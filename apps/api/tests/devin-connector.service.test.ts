import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DevinSessionCheckpoint,
  DevinSessionCursor,
  PostgresDevinConnectorRepository,
} from "@lore-co/database";
import type { TurnService } from "../src/turn/turn.service.js";
import { DevinConnectorService } from "../src/devin/devin-connector.service.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const tokenId = "22222222-2222-4222-8222-222222222222";

function session(): DevinSessionCursor {
  const now = new Date("2026-08-12T20:00:00.000Z");
  return {
    id: "33333333-3333-4333-8333-333333333333",
    workspaceId,
    workspaceOrganization: "acme",
    organizationId: "org-acme",
    sessionId: "devin-session",
    project: null,
    repo: "acme/api",
    cursor: null,
    pendingAssistantId: null,
    pendingAssistantContent: null,
    pendingAssistantAt: null,
    status: "active",
    lastError: null,
    lastPolledAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function configure(): void {
  process.env.DEVIN_POLLING_ENABLED = "true";
  process.env.DEVIN_API_KEY = "cog_test";
  process.env.DEVIN_ORG_ID = "org-acme";
  process.env.DEVIN_REPOSITORY_ALLOWLIST = "acme/api";
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DEVIN_POLLING_ENABLED;
  delete process.env.DEVIN_API_KEY;
  delete process.env.DEVIN_ORG_ID;
  delete process.env.DEVIN_REPOSITORY_ALLOWLIST;
});

describe("DevinConnectorService", () => {
  it("registers only allowlisted sessions", async () => {
    configure();
    const register = vi.fn(async () => session());
    const service = new DevinConnectorService(
      {
        register,
      } as unknown as PostgresDevinConnectorRepository,
      {} as TurnService,
    );

    await expect(
      service.register(
        {
          organizationId: "org-acme",
          sessionId: "devin-session",
          repo: "acme/api",
        },
        { workspaceId, organization: "acme", tokenId },
      ),
    ).resolves.toMatchObject({
      registered: true,
      sessionId: "devin-session",
      status: "active",
    });
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, repo: "acme/api" }),
    );
  });

  it("pairs Devin and user messages through the durable turn service", async () => {
    configure();
    const checkpoint = vi.fn(async () => undefined);
    const process = vi.fn(async () => ({}) as never);
    const pairedSession = { ...session(), project: "payments" };
    const repository = {
      listActive: vi.fn(async () => [pairedSession]),
      checkpoint,
      recordError: vi.fn(async () => undefined),
      setStatus: vi.fn(async () => true),
    } as unknown as PostgresDevinConnectorRepository;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) =>
        String(input).includes("/messages?")
          ? Response.json({
              items: [
                {
                  event_id: "assistant-1",
                  source: "devin",
                  message: "Use RepositoryFactory.",
                  created_at: 1_786_564_800,
                },
                {
                  event_id: "user-2",
                  source: "user",
                  message:
                    "<<< RELEVANT ENGINEERING KNOWLEDGE >>>\nRepositoryFactory is safe to use.\n<<< END RELEVANT ENGINEERING KNOWLEDGE >>>\n\nNo, RepositoryFactory is deprecated. Use AccountStore instead.",
                  created_at: 1_786_564_860,
                },
              ],
              has_next_page: false,
              end_cursor: "cursor-2",
            })
          : Response.json({ status: "running", is_archived: false }),
      ),
    );
    const service = new DevinConnectorService(
      repository,
      { process } as unknown as TurnService,
    );

    await service.pollNow();

    expect(process).toHaveBeenCalledTimes(1);
    expect(process.mock.calls[0]?.[0]).toMatchObject({
      connector: "devin-poller",
      agent: "devin",
      sessionId: "devin-session",
      scope: { project: "payments", repo: "acme/api" },
      learningScope: {},
      task: "No, RepositoryFactory is deprecated. Use AccountStore instead.",
      previousAssistant: {
        id: "assistant-1",
        content: "Use RepositoryFactory.",
      },
      currentUser: {
        id: "user-2",
        content:
          "No, RepositoryFactory is deprecated. Use AccountStore instead.",
      },
    });
    expect(checkpoint).toHaveBeenCalledWith(
      session().id,
      expect.objectContaining({
        cursor: "user-2",
        pendingAssistantContent: null,
      }),
    );
  });

  it("pauses polling after an archived session is drained", async () => {
    configure();
    const setStatus = vi.fn(async () => true);
    const repository = {
      listActive: vi.fn(async () => [session()]),
      checkpoint: vi.fn(async () => undefined),
      recordError: vi.fn(async () => undefined),
      setStatus,
    } as unknown as PostgresDevinConnectorRepository;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) =>
        String(input).includes("/messages?")
          ? Response.json({ items: [], has_next_page: false })
          : Response.json({ status: "running", is_archived: true }),
      ),
    );
    const service = new DevinConnectorService(
      repository,
      { process: vi.fn() } as unknown as TurnService,
    );

    await service.pollNow();

    expect(setStatus).toHaveBeenCalledWith(
      {
        workspaceId,
        organizationId: "org-acme",
        sessionId: "devin-session",
      },
      "paused",
    );
  });

  it("does not replay messages after the final-page cursor is null", async () => {
    configure();
    let stored = session();
    const process = vi.fn(async () => ({}) as never);
    const repository = {
      listActive: vi.fn(async () => [stored]),
      checkpoint: vi.fn(async (_id: string, value: DevinSessionCheckpoint) => {
        stored = { ...stored, ...value };
      }),
      recordError: vi.fn(async () => undefined),
      setStatus: vi.fn(async () => true),
    } as unknown as PostgresDevinConnectorRepository;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) =>
        String(input).includes("/messages?")
          ? Response.json({
              items: [
                {
                  event_id: "assistant-1",
                  source: "devin",
                  message: "Use RepositoryFactory.",
                  created_at: 1_786_564_800,
                },
                {
                  event_id: "user-2",
                  source: "user",
                  message: "Use AccountStore instead.",
                  created_at: 1_786_564_860,
                },
              ],
              has_next_page: false,
              end_cursor: null,
            })
          : Response.json({ status: "running", is_archived: false }),
      ),
    );
    const service = new DevinConnectorService(
      repository,
      { process } as unknown as TurnService,
    );

    await service.pollNow();
    await service.pollNow();

    expect(process).toHaveBeenCalledTimes(1);
    expect(stored.cursor).toBe("user-2");
  });
});
