import {
  InMemoryMemoryRepository,
  SharedMemoryEngine,
  type AgentInteraction,
  type AgentTask,
} from "@lore-co/core";
import { HeuristicMemoryExtractor } from "@lore-co/extractor";
import {
  packRelevantMemories,
  ScopedKeywordMemoryRetriever,
} from "@lore-co/retrieval";

export interface EngineHarness {
  engine: SharedMemoryEngine;
  repository: InMemoryMemoryRepository;
}

export function createEngineHarness(): EngineHarness {
  const repository = new InMemoryMemoryRepository();
  const engine = new SharedMemoryEngine({
    repository,
    extractor: new HeuristicMemoryExtractor(),
    retriever: new ScopedKeywordMemoryRetriever(repository),
  });
  return { engine, repository };
}

function inputUrl(input: URL | RequestInfo): string {
  return input instanceof Request ? input.url : String(input);
}

async function requestBody(
  input: URL | RequestInfo,
  init?: RequestInit,
): Promise<unknown> {
  if (init?.body !== undefined && typeof init.body === "string") {
    return JSON.parse(init.body) as unknown;
  }
  if (input instanceof Request) {
    const text = await input.text();
    return text === "" ? undefined : (JSON.parse(text) as unknown);
  }
  return undefined;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function createEngineHttpBridge(
  engine: SharedMemoryEngine,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(inputUrl(input));
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = await requestBody(input, init);

    try {
      if (method === "POST" && url.pathname === "/v1/interactions") {
        return json(await engine.observe(body as AgentInteraction));
      }
      if (method === "POST" && url.pathname === "/v1/context") {
        const result = await engine.getContext(body as AgentTask);
        const packed = packRelevantMemories(result.memories);
        return json({
          memories: packed.memories,
          hits: (result.hits ?? []).filter((hit) =>
            packed.memories.some((memory) => memory.id === hit.memory.id),
          ),
          context: packed.text,
          packing: packed.packing,
        });
      }
      return json({ message: `No fake route for ${method} ${url.pathname}` }, 404);
    } catch (error) {
      return json(
        { message: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  };
}
