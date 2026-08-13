import { LoreClient } from "@lore-co/sdk";
import type { useRequestEvent as NuxtUseRequestEvent } from "nuxt/app";

declare const useRequestEvent: typeof NuxtUseRequestEvent;

export function withSameOriginCredentials(
  fetchImplementation: typeof fetch,
): typeof fetch {
  return (input, init) =>
    fetchImplementation.call(globalThis, input, {
      ...init,
      credentials: "same-origin",
    });
}

export function useSharedMemoryClient(): LoreClient {
  if (typeof window === "undefined") {
    const event = useRequestEvent() as
      | (ReturnType<typeof useRequestEvent> & { fetch?: typeof fetch })
      | undefined;
    if (event?.fetch === undefined) {
      throw new Error("A request-scoped fetch implementation is required");
    }
    return new LoreClient({
      baseUrl: "/api/lore",
      fetch: event.fetch,
    });
  }

  return new LoreClient({
    baseUrl: "/api/lore",
    fetch: withSameOriginCredentials(globalThis.fetch),
  });
}
