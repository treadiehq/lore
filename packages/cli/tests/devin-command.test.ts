import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { runDevinCommand } from "../src/devin.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const name of [
    "DEVIN_API_KEY",
    "DEVIN_ORG_ID",
    "LORE_API_URL",
    "LORE_WORKSPACE_TOKEN",
  ]) {
    delete process.env[name];
  }
});

describe("Devin CLI commands", () => {
  it("delivers audited Lore context before creating and registering a session", async () => {
    process.env.DEVIN_API_KEY = "cog_test";
    process.env.DEVIN_ORG_ID = "org-test";
    process.env.LORE_API_URL = "https://lore.example.com";
    process.env.LORE_WORKSPACE_TOKEN = "workspace-token";
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init) => {
        const url = String(input);
        requests.push({
          url,
          body:
            init?.body === undefined
              ? undefined
              : JSON.parse(String(init.body)),
        });
        if (url === "https://lore.example.com/v1/context/deliveries") {
          const body = JSON.parse(String(init?.body)) as {
            eventId: string;
          };
          return Response.json({
            context: "Always use AccountStore.",
            event: {
              id: "lore-event-1",
              externalEventId: body.eventId,
            },
            receipt: {
              id: "delivery-receipt-1",
              eventId: "lore-event-1",
            },
          });
        }
        if (
          url ===
          "https://api.devin.ai/v3/organizations/org-test/sessions"
        ) {
          return Response.json({
            session_id: "devin-123",
            url: "https://app.devin.ai/sessions/devin-123",
            status: "running",
          });
        }
        if (
          url ===
          "https://lore.example.com/v1/connectors/devin/sessions"
        ) {
          return Response.json({
            registered: true,
            sessionId: "devin-123",
            status: "active",
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    await runDevinCommand([
      "start",
      "--repo",
      "acme/api",
      "--prompt",
      "Fix account persistence",
      "--max-acu",
      "2",
    ]);

    expect(requests.map(({ url }) => url)).toEqual([
      "https://lore.example.com/v1/context/deliveries",
      "https://api.devin.ai/v3/organizations/org-test/sessions",
      "https://lore.example.com/v1/connectors/devin/sessions",
    ]);
    expect(requests[0]?.body).toMatchObject({
      connector: "lore-devin-cli",
      eventId: expect.stringMatching(
        /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
      ),
      sessionId: expect.stringMatching(/^lore-devin-start:/u),
      task: {
        agent: "devin",
        task: "Fix account persistence",
        scope: { repo: "acme/api" },
      },
    });
    expect(requests[1]?.body).toMatchObject({
      repos: ["acme/api"],
      max_acu_limit: 2,
      prompt: expect.stringContaining("Always use AccountStore."),
    });
    expect(JSON.stringify(requests[1]?.body)).toContain(
      "<<< RELEVANT ENGINEERING KNOWLEDGE >>>",
    );
    expect(JSON.stringify(requests[1]?.body)).toContain(
      "<<< END RELEVANT ENGINEERING KNOWLEDGE >>>",
    );
    expect(requests[2]?.body).toEqual({
      organizationId: "org-test",
      sessionId: "devin-123",
      repo: "acme/api",
    });
  });

  it("re-registers polling before sending an enriched prompt", async () => {
    process.env.DEVIN_API_KEY = "cog_test";
    process.env.DEVIN_ORG_ID = "org-test";
    process.env.LORE_API_URL = "https://lore.example.com";
    process.env.LORE_WORKSPACE_TOKEN = "workspace-token";
    const requests: Array<{ url: string; body: unknown }> = [];
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init) => {
        const url = String(input);
        const body =
          init?.body === undefined
            ? undefined
            : JSON.parse(String(init.body));
        requests.push({ url, body });
        if (url === "https://lore.example.com/v1/context/deliveries") {
          const eventId = (body as { eventId: string }).eventId;
          return Response.json({
            context: "Correct relative documentation links before merging.",
            event: {
              id: `lore-event-${requests.length}`,
              externalEventId: eventId,
            },
            receipt: {
              id: `delivery-receipt-${requests.length}`,
              eventId: `lore-event-${requests.length}`,
            },
          });
        }
        if (
          url ===
          "https://lore.example.com/v1/connectors/devin/sessions"
        ) {
          return Response.json({
            registered: true,
            sessionId: "devin-123",
            status: "active",
          });
        }
        if (
          url ===
          "https://api.devin.ai/v3/organizations/org-test/sessions/devin-123/messages"
        ) {
          return Response.json({ event_id: "message-1" });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const command = [
      "prompt",
      "--session",
      "devin-123",
      "--repo",
      "acme/api",
      "--prompt",
      "Apply the reviewer correction",
      "--project",
      "payments",
      "--message-as-user-id",
      "user-123",
    ] as const;
    await runDevinCommand(command);
    await runDevinCommand(command);

    expect(requests.map(({ url }) => url)).toEqual([
      "https://lore.example.com/v1/context/deliveries",
      "https://lore.example.com/v1/connectors/devin/sessions",
      "https://api.devin.ai/v3/organizations/org-test/sessions/devin-123/messages",
      "https://lore.example.com/v1/context/deliveries",
      "https://lore.example.com/v1/connectors/devin/sessions",
      "https://api.devin.ai/v3/organizations/org-test/sessions/devin-123/messages",
    ]);
    expect(requests[0]?.body).toMatchObject({
      connector: "lore-devin-cli",
      sessionId: "devin-123",
      task: {
        agent: "devin",
        task: "Apply the reviewer correction",
        scope: { project: "payments", repo: "acme/api" },
      },
    });
    expect(
      (requests[0]?.body as { eventId: string }).eventId,
    ).toBe((requests[3]?.body as { eventId: string }).eventId);
    expect(requests[1]?.body).toEqual({
      organizationId: "org-test",
      sessionId: "devin-123",
      repo: "acme/api",
      project: "payments",
    });
    expect(requests[2]?.body).toEqual({
      message: [
        "<<< RELEVANT ENGINEERING KNOWLEDGE >>>",
        "Correct relative documentation links before merging.",
        "<<< END RELEVANT ENGINEERING KNOWLEDGE >>>",
        "",
        "Apply the reviewer correction",
      ].join("\n"),
      message_as_user_id: "user-123",
    });
    const success = JSON.parse(String(stdout.mock.calls[0]?.[0])) as Record<
      string,
      unknown
    >;
    expect(success).toMatchObject({
      sessionId: "devin-123",
      loreContextInjected: true,
      lorePollingRegistered: true,
      sent: true,
    });
  });

  it("prints prompt-specific help without requiring credentials", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await runCli(["devin", "prompt", "--help"]);

    expect(String(stdout.mock.calls[0]?.[0])).toContain(
      "lore devin prompt --session",
    );
    expect(String(stdout.mock.calls[0]?.[0])).toContain("--stdin");
  });
});
