import { describe, expect, it, vi } from "vitest";
import { DevinApiClient } from "../src/devin-client.js";

const session = {
  session_id: "devin-123",
  url: "https://app.devin.ai/sessions/devin-123",
  status: "running" as const,
};

function client(fetchImplementation: typeof fetch): DevinApiClient {
  return new DevinApiClient({
    apiKey: "cog_test",
    organizationId: "org-test",
    fetch: fetchImplementation,
    sleep: async () => undefined,
    maximumRetries: 0,
  });
}

describe("DevinApiClient", () => {
  it("creates a bounded, non-bypass session", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(session), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await client(fetchMock).createSession({
      prompt: "Fix the tests",
      repos: ["owner/repo"],
      createAsUserId: "user-123",
      maxAcuLimit: 2,
      resumable: false,
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://api.devin.ai/v3/organizations/org-test/sessions",
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      prompt: "Fix the tests",
      repos: ["owner/repo"],
      create_as_user_id: "user-123",
      max_acu_limit: 2,
      devin_mode: "normal",
      resumable: false,
      bypass_approval: false,
    });
  });

  it("paginates session messages", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                event_id: "one",
                source: "devin",
                message: "First",
                created_at: 1_786_564_800,
              },
            ],
            has_next_page: true,
            end_cursor: "next",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                event_id: "two",
                source: "user",
                message: "Second",
                created_at: 1_786_564_860,
              },
            ],
            has_next_page: false,
          }),
          { status: 200 },
        ),
      );

    const messages = await client(fetchMock).listMessages("devin-123");

    expect(messages.map(({ event_id }) => event_id)).toEqual(["one", "two"]);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "first=200&after=next",
    );
  });

  it("sends a message with an optional user identity", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ event_id: "message-1" }),
    );

    await client(fetchMock).sendMessage(
      "devin-123",
      "Apply the reviewer correction",
      "user-123",
    );

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://api.devin.ai/v3/organizations/org-test/sessions/devin-123/messages",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      message: "Apply the reviewer correction",
      message_as_user_id: "user-123",
    });
  });

  it("rejects malformed success responses", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: "running" }), { status: 200 }),
    );

    await expect(client(fetchMock).getSession("devin-123")).rejects.toThrow(
      "invalid response",
    );
  });

  it("stops polling after a terminal status", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(session), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...session,
            status: "running",
            status_detail: "waiting_for_user",
          }),
          { status: 200 },
        ),
      );

    const completed = await client(fetchMock).waitForCompletion(
      "devin-123",
      10_000,
      250,
    );

    expect(completed.status_detail).toBe("waiting_for_user");
  });
});
