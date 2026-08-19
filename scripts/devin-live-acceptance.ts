import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LoreClient,
  type Learning,
} from "../packages/sdk/src/index.js";
import { DevinApiClient } from "../packages/cli/src/devin-client.js";

interface DevinCliResult {
  sessionId: string;
  loreContextInjected: boolean;
  lorePollingRegistered: boolean;
  loreDeliveryReceiptId: string;
  sent?: boolean;
  url?: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function milliseconds(name: string, fallback: number): number {
  const value = process.env[name];
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(resolved) || resolved < 1_000) {
    throw new Error(`${name} must be an integer of at least 1000`);
  }
  return resolved;
}

async function sleep(duration: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, duration));
}

function parseCliResult(
  output: string,
  command: "start" | "prompt",
): DevinCliResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`lore devin ${command} returned invalid JSON`, {
      cause: error,
    });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).sessionId !== "string" ||
    typeof (parsed as Record<string, unknown>).loreContextInjected !==
      "boolean" ||
    typeof (parsed as Record<string, unknown>).lorePollingRegistered !==
      "boolean" ||
    typeof (parsed as Record<string, unknown>).loreDeliveryReceiptId !==
      "string" ||
    (command === "prompt" &&
      (parsed as Record<string, unknown>).sent !== true)
  ) {
    throw new Error(`lore devin ${command} returned an invalid result`);
  }
  return parsed as DevinCliResult;
}

async function runCustomerCli(
  command: "start" | "prompt",
  args: readonly string[],
): Promise<DevinCliResult> {
  const repositoryRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const cli = resolve(repositoryRoot, "packages/cli/dist/cli.js");
  try {
    const result = await new Promise<{ stdout: string; stderr: string }>(
      (resolvePromise, reject) => {
        const child = execFile(
          process.execPath,
          [cli, "devin", command, ...args],
          {
            cwd: repositoryRoot,
            encoding: "utf8",
            env: { ...process.env, NO_COLOR: "1" },
            killSignal: "SIGKILL",
            maxBuffer: 2 * 1024 * 1024,
            timeout: 2 * 60_000,
          },
          (error, stdout, stderr) => {
            if (error !== null) {
              reject(Object.assign(error, { stdout, stderr }));
              return;
            }
            resolvePromise({ stdout, stderr });
          },
        );
        child.stdin?.end();
      },
    );
    return parseCliResult(result.stdout.trim(), command);
  } catch (error) {
    const detail =
      typeof error === "object" && error !== null
        ? [
            "stderr" in error && typeof error.stderr === "string"
              ? error.stderr.trim()
              : "",
            "stdout" in error && typeof error.stdout === "string"
              ? error.stdout.trim()
              : "",
          ].find((value) => value !== "")
        : undefined;
    throw new Error(
      `Built customer CLI failed for lore devin ${command}${
        detail === undefined ? "" : `: ${detail}`
      }`,
      { cause: error },
    );
  }
}

function assertRepositoryScoped(
  learning: Learning,
  repository: string,
): void {
  if (
    learning.scope.organization === undefined ||
    learning.scope.project !== undefined ||
    learning.scope.repo !== repository ||
    learning.scope.path !== undefined ||
    learning.scope.component !== undefined
  ) {
    throw new Error(
      `Captured Devin learning ${learning.id} was not stored at repository scope for ${repository}`,
    );
  }
}

async function main(): Promise<void> {
  if (process.env.RUN_DEVIN_LIVE_TESTS !== "1") {
    throw new Error(
      "Live Devin acceptance is disabled. Set RUN_DEVIN_LIVE_TESTS=1 to acknowledge that this creates one billable session.",
    );
  }

  const apiUrl = required("LORE_API_URL").replace(/\/+$/u, "");
  const token = required("LORE_WORKSPACE_TOKEN");
  const repository = required("DEVIN_ACCEPTANCE_REPO");
  const organizationId = required("DEVIN_ORG_ID");
  const apiKey = required("DEVIN_API_KEY");
  const createAsUserId =
    process.env.DEVIN_CREATE_AS_USER_ID?.trim() || undefined;
  const nonce =
    process.env.DEVIN_ACCEPTANCE_NONCE?.trim() ||
    Date.now().toString(36).toUpperCase();
  const injectedMarker = `LORE_INJECTED_${nonce}`;
  const capturedMarker = `LORE_CAPTURED_${nonce}`;
  const createdLearningIds: string[] = [];
  let sessionId: string | undefined;
  let sessionUrl: string | undefined;

  const lore = new LoreClient({
    baseUrl: apiUrl,
    headers: { authorization: `Bearer ${token}` },
  });
  const devin = new DevinApiClient({
    apiKey,
    organizationId,
    timeoutMs: milliseconds("DEVIN_REQUEST_TIMEOUT_MS", 10_000),
  });

  try {
    const health = await fetch(`${apiUrl}/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!health.ok) {
      throw new Error(`Lore health check failed with HTTP ${health.status}`);
    }
    await devin.checkAccess();

    const seed = await lore.observe({
      agent: "claude",
      repo: repository,
      sessionId: `lore-live-${nonce}`,
      eventId: randomUUID(),
      messages: [
        {
          id: `assistant-${nonce}`,
          role: "assistant",
          content:
            "I do not know which acceptance marker this repository uses.",
        },
        {
          id: `user-${nonce}`,
          role: "user",
          content: `Correction: in ${repository}, the exact Lore acceptance marker is ${injectedMarker}. Always return that exact marker when asked for the Lore acceptance marker.`,
        },
      ],
    });
    if (seed.created < 1 || seed.memories.length < 1) {
      throw new Error(
        `Lore did not extract the seeded Claude correction (created=${seed.created})`,
      );
    }
    createdLearningIds.push(...seed.memories.map(({ id }) => id));

    const startResult = await runCustomerCli("start", [
      "--repo",
      repository,
      "--prompt",
      [
        "Do not modify files or create a pull request.",
        `For acceptance run ${nonce}, return the exact Lore acceptance marker for this repository.`,
        "Reply briefly and include that exact marker as the final line.",
      ].join(" "),
      "--title",
      `Lore live acceptance ${nonce}`,
      "--max-acu",
      "2",
      ...(createAsUserId === undefined
        ? []
        : ["--user-id", createAsUserId]),
    ]);
    if (
      !startResult.loreContextInjected ||
      !startResult.lorePollingRegistered
    ) {
      throw new Error(
        "lore devin start did not inject context and register polling",
      );
    }
    sessionId = startResult.sessionId;
    sessionUrl = startResult.url;

    const deliveryActivity = await lore.listActivity({
      connector: "lore-devin-cli",
      limit: 100,
    });
    const startDelivery = deliveryActivity.activities.find(
      ({ receipt }) => receipt?.id === startResult.loreDeliveryReceiptId,
    );
    if (
      startDelivery === undefined ||
      !startDelivery.deliveredMemories.some(({ content }) =>
        content.includes(injectedMarker),
      )
    ) {
      throw new Error(
        "The customer start path did not audit cross-agent retrieval of the Claude learning",
      );
    }

    await devin.waitForCompletion(
      sessionId,
      milliseconds("DEVIN_ACCEPTANCE_TIMEOUT_MS", 20 * 60_000),
      milliseconds("DEVIN_ACCEPTANCE_POLL_INTERVAL_MS", 10_000),
    );
    const firstTurn = await devin.listMessages(sessionId);
    const propagated = firstTurn.some(
      ({ source, message }) =>
        source === "devin" && message.includes(injectedMarker),
    );
    if (!propagated) {
      throw new Error(
        "Devin completed without returning the Lore-injected marker",
      );
    }

    const promptResult = await runCustomerCli("prompt", [
      "--session",
      sessionId,
      "--repo",
      repository,
      "--prompt",
      `Correction: in ${repository}, the durable review convention is ${capturedMarker}: when a reviewer identifies a broken relative documentation link, fix the link before merging. The existing Lore acceptance marker is relevant context. Acknowledge this correction and the acceptance marker without modifying files.`,
      ...(createAsUserId === undefined
        ? []
        : ["--message-as-user-id", createAsUserId]),
    ]);
    if (
      promptResult.sessionId !== sessionId ||
      !promptResult.loreContextInjected ||
      !promptResult.lorePollingRegistered ||
      promptResult.sent !== true
    ) {
      throw new Error(
        "lore devin prompt did not inject context, re-register polling, and send",
      );
    }

    const captureDeadline =
      Date.now() + milliseconds("DEVIN_CAPTURE_TIMEOUT_MS", 120_000);
    let capturedLearning: Learning | undefined;
    while (Date.now() < captureDeadline && capturedLearning === undefined) {
      const result = await lore.listLearnings({
        query: capturedMarker,
        status: "active",
        limit: 20,
      });
      capturedLearning = result.memories.find(({ content }) =>
        content.includes(capturedMarker),
      );
      if (capturedLearning === undefined) {
        await sleep(5_000);
      }
    }
    if (capturedLearning === undefined) {
      throw new Error(
        "Lore's Devin poller did not capture the user correction before timeout",
      );
    }
    assertRepositoryScoped(capturedLearning, repository);
    createdLearningIds.push(capturedLearning.id);

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          repository,
          sessionId,
          sessionUrl,
          checks: {
            loreHealth: true,
            devinCredentials: true,
            claudeCorrectionExtracted: true,
            startCliContextInjected: true,
            startCliPollingRegistered: true,
            crossAgentRetrievalAudited: true,
            contextPropagatedToDevin: true,
            promptCliContextInjected: true,
            promptCliPollingRegistered: true,
            promptCliSent: true,
            devinCorrectionCaptured: true,
            workspaceScopeStored: true,
          },
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    if (sessionId !== undefined) {
      await devin.archiveSession(sessionId).catch(() => undefined);
    }
    for (const learningId of createdLearningIds) {
      await lore.forgetLearning(learningId).catch(() => undefined);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
