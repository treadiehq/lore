import { describe, expect, it } from "vitest";
import { withSameOriginCredentials } from "../apps/web/composables/useSharedMemoryClient.js";

describe("web API client", () => {
  it("sends browser requests with same-origin credentials", async () => {
    let receiver: unknown;
    let requestInit: RequestInit | undefined;
    const browserFetch = async function (
      this: unknown,
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      receiver = this;
      requestInit = init;
      return new Response(null, { status: 204 });
    };

    const fetchWithCredentials = withSameOriginCredentials(
      browserFetch as typeof fetch,
    );
    await fetchWithCredentials("/api/lore/v1/learnings", {
      method: "GET",
      credentials: "omit",
    });

    expect(receiver).toBe(globalThis);
    expect(requestInit).toMatchObject({
      method: "GET",
      credentials: "same-origin",
    });
  });
});
