#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  SharedMemoryApiError,
  LoreClient,
  type SharedMemoryClientOptions,
} from "@lore-co/sdk";
import { z } from "zod";

const scopeShape = {
  organization: z.string().trim().min(1).optional(),
  project: z.string().trim().min(1).optional(),
  repo: z.string().trim().min(1).optional(),
  path: z.string().trim().min(1).optional(),
  component: z.string().trim().min(1).optional(),
};

const scopeSchema = z.object(scopeShape).strict();
const categorySchema = z.enum([
  "architecture",
  "convention",
  "correction",
  "gotcha",
  "known_gotcha",
  "deprecated",
  "behavior",
  "review_feedback",
  "other",
]);

export const MemorySearchInputSchema = z
  .object({
    agent: z.string().trim().min(1).default("mcp"),
    task: z.string().trim().min(1).describe("Task or question to search for"),
    scope: scopeSchema.optional(),
    ...scopeShape,
    diff: z.string().optional().describe("Relevant code diff"),
    files: z.array(z.string().trim().min(1)).optional(),
    components: z.array(z.string().trim().min(1)).optional(),
    symbols: z.array(z.string().trim().min(1)).optional(),
    limit: z.number().int().positive().max(20).optional(),
  })
  .strict();

export const MemoryGetInputSchema = z
  .object({
    id: z.uuid().describe("Memory UUID"),
  })
  .strict();

export const MemoryRememberInputSchema = z
  .object({
    content: z.string().trim().min(1).describe("Durable knowledge to save"),
    scope: scopeSchema.optional(),
    ...scopeShape,
    category: categorySchema.optional(),
    agent: z.string().trim().min(1).default("mcp"),
    sessionId: z.string().trim().min(1).optional(),
  })
  .strict();

export const MemoryCorrectInputSchema = z
  .object({
    id: z.uuid().describe("Active memory UUID to correct"),
    content: z.string().trim().min(1).describe("Correct replacement content"),
    category: categorySchema.optional(),
    agent: z.string().trim().min(1).default("mcp"),
    sessionId: z.string().trim().min(1).optional(),
  })
  .strict();

export const MemoryForgetInputSchema = MemoryGetInputSchema;

interface TextToolResult extends Record<string, unknown> {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: true;
}

function serializableObject(value: unknown): Record<string, unknown> {
  const serialized = JSON.parse(JSON.stringify(value)) as unknown;
  if (
    typeof serialized !== "object" ||
    serialized === null ||
    Array.isArray(serialized)
  ) {
    return { value: serialized };
  }
  return serialized as Record<string, unknown>;
}

function toolResult(value: unknown, text?: string): TextToolResult {
  const structuredContent = serializableObject(value);
  return {
    content: [
      {
        type: "text",
        text: text ?? JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
  };
}

function toolError(error: unknown): TextToolResult {
  const details =
    error instanceof SharedMemoryApiError
      ? {
          error: error.message,
          status: error.status,
          method: error.method,
          url: error.url,
          details: error.details,
        }
      : {
          error: error instanceof Error ? error.message : String(error),
        };
  return {
    ...toolResult(details),
    isError: true,
  };
}

export interface CreateMcpServerOptions {
  client?: LoreClient;
  baseUrl?: string;
  fetch?: SharedMemoryClientOptions["fetch"];
  headers?: SharedMemoryClientOptions["headers"];
}

export function createMcpServer(
  options: CreateMcpServerOptions = {},
): McpServer {
  const client =
    options.client ??
    new LoreClient({
      baseUrl:
        options.baseUrl ??
        process.env.LORE_API_URL?.trim() ??
        "http://localhost:3004",
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.headers !== undefined
        ? { headers: options.headers }
        : process.env.LORE_WORKSPACE_TOKEN?.trim()
          ? {
              headers: {
                authorization: `Bearer ${process.env.LORE_WORKSPACE_TOKEN.trim()}`,
              },
            }
          : {}),
    });
  const server = new McpServer({
    name: "lore",
    version: "0.0.0",
  });

  server.registerTool(
    "search_learnings",
    {
      title: "Search shared learnings",
      description:
        "Find shared engineering learnings relevant to a task and return formatted context.",
      inputSchema: MemorySearchInputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        const result = await client.getContext(input);
        return toolResult(
          result,
          result.context || "No relevant shared learnings found.",
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_learning",
    {
      title: "Get shared learning",
      description: "Get one shared engineering learning by UUID.",
      inputSchema: MemoryGetInputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ id }) => {
      try {
        return toolResult(await client.getLearning(id));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "remember_learning",
    {
      title: "Remember engineering knowledge",
      description:
        "Store a durable engineering fact, convention, correction, or decision.",
      inputSchema: MemoryRememberInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        return toolResult(
          await client.createLearning({
            content: input.content,
            ...(input.scope === undefined ? {} : { scope: input.scope }),
            ...(input.organization === undefined
              ? {}
              : { organization: input.organization }),
            ...(input.project === undefined
              ? {}
              : { project: input.project }),
            ...(input.repo === undefined ? {} : { repo: input.repo }),
            ...(input.path === undefined ? {} : { path: input.path }),
            ...(input.component === undefined
              ? {}
              : { component: input.component }),
            ...(input.category === undefined
              ? {}
              : { category: input.category }),
            source: {
              agent: input.agent,
              ...(input.sessionId === undefined
                ? {}
                : { sessionId: input.sessionId }),
            },
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "correct_learning",
    {
      title: "Correct shared learning",
      description:
        "Supersede an active learning with corrected replacement content.",
      inputSchema: MemoryCorrectInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        return toolResult(
          await client.correctLearning(input.id, {
            content: input.content,
            ...(input.category === undefined
              ? {}
              : { category: input.category }),
            source: {
              agent: input.agent,
              ...(input.sessionId === undefined
                ? {}
                : { sessionId: input.sessionId }),
            },
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "forget_learning",
    {
      title: "Forget shared learning",
      description: "Soft-delete a shared engineering learning by UUID.",
      inputSchema: MemoryForgetInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id }) => {
      try {
        return toolResult(await client.forgetLearning(id));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}

export async function runStdioServer(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return (
      realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void runStdioServer().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Failed to start MCP server",
    );
    process.exitCode = 1;
  });
}
