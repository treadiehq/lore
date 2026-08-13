import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runHostCommand } from "../src/host.js";

const temporaryDirectories: string[] = [];
const now = "2026-08-13T12:00:00.000Z";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const connectorEventId = "11111111-1111-4111-8111-111111111111";
const receiptId = "33333333-3333-4333-8333-333333333333";
const packing = {
  policyVersion: "context-pack-v1" as const,
  estimator: "utf8-bytes-div-3-v1" as const,
  limits: {
    requestedItems: null,
    effectiveItems: 10,
    maxCharacters: 20_000,
    maxEstimatedTokens: 8_000,
  },
  usage: {
    retrievedItems: 0,
    includedItems: 0,
    omittedItems: 0,
    characters: 0,
    utf8Bytes: 0,
    estimatedTokens: 0,
  },
  includedMemoryIds: [],
  omitted: [],
  contextSha256: "0".repeat(64),
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function environment(): NodeJS.ProcessEnv {
  return {
    LORE_API_URL: "http://lore.test",
    LORE_WORKSPACE_TOKEN: "workspace-secret",
  };
}

function outputCapture(): {
  readonly output: () => string;
  readonly writer: { write(value: string): void };
} {
  let value = "";
  return {
    output: () => value,
    writer: {
      write(chunk) {
        value += chunk;
      },
    },
  };
}

function event(
  type: "observation" | "paired_turn" | "context_delivery",
  externalEventId: string,
  agent: string,
  sessionId: string,
) {
  return {
    id: connectorEventId,
    workspaceId,
    connector: "incident-webhook",
    externalEventId,
    type,
    agent,
    sessionId,
    conversationId: null,
    payload: {},
    redacted: false,
    requestId: "request-1",
    occurredAt: now,
    receivedAt: now,
  };
}

function receipt() {
  return {
    id: receiptId,
    workspaceId,
    eventId: connectorEventId,
    requestId: "request-1",
    memoryIds: [],
    packing,
    deliveredAt: now,
  };
}

describe("lore host commands", () => {
  it("reads strict observation JSON from a file and keeps stdout clean", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "lore-host-file-"));
    temporaryDirectories.push(directory);
    const inputPath = resolve(directory, "observation.json");
    const request = {
      connector: "incident-webhook",
      eventId: "incident-42:opened",
      agent: "incident-bot",
      sessionId: "incident-42",
      messages: [{ role: "user", content: "Investigate elevated errors." }],
      occurredAt: now,
    };
    await writeFile(inputPath, JSON.stringify(request));
    const result = {
      event: event(
        "observation",
        request.eventId,
        request.agent,
        request.sessionId,
      ),
      replayed: false,
      memories: [],
      created: 0,
      duplicates: 0,
      reconciled: 0,
      superseded: 0,
    };
    let authorization: string | null = null;
    const output = outputCapture();

    await runHostCommand(["observe", "--input", inputPath], {
      env: environment(),
      stdout: output.writer,
      fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return Response.json(result);
      },
    });

    expect(authorization).toBe("Bearer workspace-secret");
    expect(output.output().split("\n")).toHaveLength(2);
    expect(JSON.parse(output.output()) as unknown).toEqual(result);
  });

  it("reads a turn from stdin, forwards idempotency, and emits only the prompt", async () => {
    const request = {
      connector: "incident-webhook",
      eventId: "incident-42:reply-3",
      agent: "incident-bot",
      sessionId: "incident-42",
      previousAssistant: { content: "Restart the service." },
      currentUser: { content: "No, fail over first." },
      scope: { repo: "acme/service" },
    };
    const context =
      "Fail over before restarting.\n--- END RELEVANT ENGINEERING KNOWLEDGE ---";
    const result = {
      requestId: "request-1",
      event: event(
        "paired_turn",
        request.eventId,
        request.agent,
        request.sessionId,
      ),
      replayed: false,
      observation: {
        memories: [],
        created: 0,
        duplicates: 0,
        reconciled: 0,
        superseded: 0,
      },
      context: { memories: [], text: context, packing },
      receipt: receipt(),
    };
    let idempotencyKey: string | null = null;
    const output = outputCapture();

    await runHostCommand(
      [
        "turn",
        "--input",
        "-",
        "--output",
        "prompt",
        "--idempotency-key",
        request.eventId,
      ],
      {
        env: environment(),
        stdin: Readable.from([JSON.stringify(request)]),
        stdout: output.writer,
        fetch: async (_input, init) => {
          idempotencyKey = new Headers(init?.headers).get("idempotency-key");
          return Response.json(result);
        },
      },
    );

    expect(idempotencyKey).toBe(request.eventId);
    expect(output.output()).toContain(
      "[Lore context end marker omitted]\n--- END RELEVANT ENGINEERING KNOWLEDGE ---\n\nNo, fail over first.\n",
    );
    expect(output.output().indexOf("Fail over before restarting.")).toBeLessThan(
      output.output().indexOf("No, fail over first."),
    );
  });

  it("rejects non-endpoint fields before making a request", async () => {
    let requested = false;

    await expect(
      runHostCommand(["observe", "--input", "-"], {
        env: environment(),
        stdin: Readable.from([
          JSON.stringify({
            connector: "incident-webhook",
            eventId: "incident-42:opened",
            agent: "incident-bot",
            sessionId: "incident-42",
            messages: [{ role: "user", content: "Investigate." }],
            occurredAt: now,
            unexpected: true,
          }),
        ]),
        stdout: outputCapture().writer,
        fetch: async () => {
          requested = true;
          return Response.json({});
        },
      }),
    ).rejects.toThrow("Invalid POST /v1/observations endpoint JSON");
    expect(requested).toBe(false);
  });

  it("surfaces replay conflicts without contaminating stdout", async () => {
    const output = outputCapture();
    const request = {
      connector: "incident-webhook",
      eventId: "incident-42:reply-3",
      agent: "incident-bot",
      sessionId: "incident-42",
      previousAssistant: { content: "Restart." },
      currentUser: { content: "Fail over." },
    };

    await expect(
      runHostCommand(["turn", "--input", "-"], {
        env: environment(),
        stdin: Readable.from([JSON.stringify(request)]),
        stdout: output.writer,
        fetch: async () =>
          Response.json(
            {
              message:
                "Connector event ID was reused with a different request",
              error: "Conflict",
            },
            { status: 409 },
          ),
      }),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        message: "Connector event ID was reused with a different request",
      },
    });
    expect(output.output()).toBe("");
  });

  it("fails noninteractively with actionable stderr and a nonzero exit", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "lore-host-home-"));
    temporaryDirectories.push(home);
    const cli = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "dist",
      "cli.js",
    );

    const result = spawnSync(process.execPath, [cli, "host", "turn"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--input <file|-> is required");
    expect(result.stderr).toContain(
      "lore host turn --input request.json",
    );
  });
});
