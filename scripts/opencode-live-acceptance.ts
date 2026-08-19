import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LoreClient,
  type ActivityItem,
  type Learning,
  type WorkspaceLearningPolicy,
} from "../packages/sdk/src/index.js";
import {
  assertLearningSource,
  assertOpenCodeCliCapabilities,
  buildOpenCodeRunArgs,
  matchingLearnings,
  milliseconds,
  parseOpenCodeRunJsonl,
  positiveNumberString,
  runCommand,
  sleep,
  type OpenCodeRunResult,
} from "./live-agent-acceptance-helpers.js";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const CONNECTOR = "lore-opencode-plugin";
const AGENT = "opencode";
const MAX_MODEL_INVOCATIONS = 3;

function required(name: string, requirement?: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(
      `${name} is required${
        requirement === undefined ? "" : `. ${requirement}`
      }`,
    );
  }
  return value;
}

function progress(message: string): void {
  process.stdout.write(`[opencode-live] ${message}\n`);
}

function assertMarkerAbsent(
  activity: ActivityItem,
  input: { memoryId: string; marker: string; label: string },
): void {
  if (
    activity.receipt?.memoryIds.includes(input.memoryId) === true ||
    activity.deliveredMemories.some(({ content }) =>
      content.includes(input.marker),
    )
  ) {
    throw new Error(`${input.label} injected excluded knowledge`);
  }
}

function assertRepositoryCandidate(
  learning: Learning,
  expectedRepository: string,
): string {
  const repository = learning.scope.repo;
  if (
    learning.scope.organization === undefined ||
    repository === undefined ||
    learning.scope.path !== undefined ||
    learning.scope.component !== undefined
  ) {
    throw new Error(
      `OpenCode proposal ${learning.id} was not captured at repository scope`,
    );
  }
  if (repository !== expectedRepository) {
    throw new Error(
      `OpenCode proposal ${learning.id} used repository scope ${repository}; expected ${expectedRepository}`,
    );
  }
  return repository;
}

async function waitForActivity(input: {
  lore: LoreClient;
  from: string;
  timeoutMs: number;
  pollIntervalMs: number;
  label: string;
  predicate: (activity: ActivityItem) => boolean;
}): Promise<ActivityItem> {
  const deadline = Date.now() + input.timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await input.lore.listActivity({
        connector: CONNECTOR,
        agent: AGENT,
        from: input.from,
        limit: 100,
      });
      const activity = result.activities.find(input.predicate);
      if (activity !== undefined) {
        return activity;
      }
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    await sleep(input.pollIntervalMs);
  }
  throw new Error(
    `${input.label} did not appear in audited Lore activity before timeout${
      lastError instanceof Error
        ? `; last query failed: ${lastError.message}`
        : ""
    }`,
    lastError === undefined ? undefined : { cause: lastError },
  );
}

async function waitForProposedLearning(input: {
  lore: LoreClient;
  marker: string;
  timeoutMs: number;
  pollIntervalMs: number;
}): Promise<Learning> {
  const deadline = Date.now() + input.timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await input.lore.listLearnings({
        query: input.marker,
        status: "proposed",
        limit: 20,
      });
      const learning = result.memories.find(({ content }) =>
        content.includes(input.marker),
      );
      if (learning !== undefined) {
        return learning;
      }
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    await sleep(input.pollIntervalMs);
  }
  throw new Error(
    `Lore did not capture proposed OpenCode learning ${input.marker} before timeout${
      lastError instanceof Error
        ? `; last query failed: ${lastError.message}`
        : ""
    }`,
    lastError === undefined ? undefined : { cause: lastError },
  );
}

async function prepareFixture(input: {
  directory: string;
  configDirectory: string;
  repository: string;
}): Promise<NodeJS.ProcessEnv> {
  await runCommand({
    label: "Temporary OpenCode repository initialization",
    executable: "git",
    args: ["init", "-q"],
    cwd: input.directory,
    timeoutMs: 30_000,
  });
  await writeFile(
    join(input.directory, "README.md"),
    "# OpenCode Lore live acceptance fixture\n",
    "utf8",
  );
  await runCommand({
    label: "Temporary OpenCode repository staging",
    executable: "git",
    args: ["add", "README.md"],
    cwd: input.directory,
    timeoutMs: 30_000,
  });
  await runCommand({
    label: "Temporary OpenCode repository commit",
    executable: "git",
    args: [
      "-c",
      "user.name=Lore Acceptance",
      "-c",
      "user.email=lore-acceptance@example.invalid",
      "commit",
      "-qm",
      "Create acceptance fixture",
    ],
    cwd: input.directory,
    timeoutMs: 30_000,
  });
  await runCommand({
    label: "Temporary OpenCode repository remote setup",
    executable: "git",
    args: [
      "remote",
      "add",
      "origin",
      `https://github.com/${input.repository}.git`,
    ],
    cwd: input.directory,
    timeoutMs: 30_000,
  });

  const pluginsDirectory = join(input.configDirectory, "plugins");
  await mkdir(pluginsDirectory, { recursive: true });
  const pluginEntry = pathToFileURL(
    resolve(REPOSITORY_ROOT, "packages/opencode-plugin/dist/index.js"),
  ).href;
  await writeFile(
    join(pluginsDirectory, "lore-live-acceptance.js"),
    `export { default } from ${JSON.stringify(pluginEntry)};\n`,
    "utf8",
  );
  const configPath = join(input.configDirectory, "opencode.json");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        share: "disabled",
        tools: {
          bash: false,
          edit: false,
          write: false,
        },
        permission: { "*": "deny" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return {
    OPENCODE_CONFIG: configPath,
    OPENCODE_CONFIG_DIR: input.configDirectory,
    XDG_CONFIG_HOME: join(input.directory, "xdg-config"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  };
}

async function main(): Promise<void> {
  if (process.env.RUN_OPENCODE_LIVE_TESTS !== "RUN") {
    throw new Error(
      "Live OpenCode acceptance is disabled. Set RUN_OPENCODE_LIVE_TESTS=RUN to acknowledge three real model invocations and provider charges.",
    );
  }

  const apiUrl = required("LORE_API_URL").replace(/\/+$/u, "");
  const workspaceToken = required("LORE_WORKSPACE_TOKEN");
  const dashboardSessionToken = required(
    "LORE_DASHBOARD_SESSION_TOKEN",
    "Use an unexpired dashboard session bearer token from the same workspace; connector tokens cannot change policy or review proposals",
  );
  const repository = required(
    "OPENCODE_ACCEPTANCE_REPO",
    "Use a disposable owner/repository identity for the temporary Git fixture",
  );
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) {
    throw new Error(
      "OPENCODE_ACCEPTANCE_REPO must use owner/repository format",
    );
  }
  const model = required(
    "OPENCODE_ACCEPTANCE_MODEL",
    'Use OpenCode provider/model format and authenticate that provider first (for example, run "opencode providers login" or set its API-key environment variable)',
  );
  if (!model.includes("/")) {
    throw new Error(
      "OPENCODE_ACCEPTANCE_MODEL must use OpenCode provider/model format",
    );
  }
  const executable =
    process.env.OPENCODE_ACCEPTANCE_EXECUTABLE?.trim() || "opencode";
  const commandTimeoutMs = milliseconds(
    process.env,
    "OPENCODE_ACCEPTANCE_COMMAND_TIMEOUT_MS",
    3 * 60_000,
  );
  const captureTimeoutMs = milliseconds(
    process.env,
    "OPENCODE_ACCEPTANCE_CAPTURE_TIMEOUT_MS",
    120_000,
  );
  const activityTimeoutMs = milliseconds(
    process.env,
    "OPENCODE_ACCEPTANCE_ACTIVITY_TIMEOUT_MS",
    120_000,
  );
  const pollIntervalMs = milliseconds(
    process.env,
    "OPENCODE_ACCEPTANCE_POLL_INTERVAL_MS",
    5_000,
  );
  const maxCostUsd = Number(
    positiveNumberString(
      process.env,
      "OPENCODE_ACCEPTANCE_MAX_COST_USD",
      "0.50",
    ),
  );
  const nonce =
    process.env.OPENCODE_ACCEPTANCE_NONCE?.trim() ||
    Date.now().toString(36).toUpperCase();
  const activeMarker = `LORE_OPENCODE_ACTIVE_${nonce}`;
  const rejectedMarker = `LORE_OPENCODE_REJECTED_${nonce}`;
  const capturedMarker = `LORE_OPENCODE_CAPTURED_${nonce}`;
  const markers = [activeMarker, rejectedMarker, capturedMarker];
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "lore-opencode-live-"),
  );
  const fixtureDirectory = join(temporaryDirectory, "repository");
  const configDirectory = join(temporaryDirectory, "opencode-config");
  await mkdir(fixtureDirectory, { recursive: true });

  const lore = new LoreClient({
    baseUrl: apiUrl,
    headers: { authorization: `Bearer ${workspaceToken}` },
  });
  const governance = new LoreClient({
    baseUrl: apiUrl,
    headers: { authorization: `Bearer ${dashboardSessionToken}` },
  });
  const cleanupLearningIds = new Set<string>();
  const cleanupProposalIds = new Set<string>();
  const sessionIds = new Set<string>();
  let originalPolicy: WorkspaceLearningPolicy | undefined;
  let policyUpdated = false;
  let totalCostUsd = 0;
  let modelInvocations = 0;
  let openCodeEnvironment: NodeJS.ProcessEnv | undefined;

  const runOpenCode = async (
    label: string,
    input: Parameters<typeof buildOpenCodeRunArgs>[0],
  ): Promise<OpenCodeRunResult> => {
    if (modelInvocations >= MAX_MODEL_INVOCATIONS) {
      throw new Error(
        `OpenCode acceptance exceeded its ${MAX_MODEL_INVOCATIONS}-invocation hard limit`,
      );
    }
    modelInvocations += 1;
    const command = await runCommand({
      label,
      executable,
      args: buildOpenCodeRunArgs(input),
      cwd: fixtureDirectory,
      timeoutMs: commandTimeoutMs,
      ...(openCodeEnvironment === undefined
        ? {}
        : { environment: openCodeEnvironment }),
    });
    const result = parseOpenCodeRunJsonl(command.stdout);
    totalCostUsd += result.costUsd;
    sessionIds.add(result.sessionId);
    if (totalCostUsd > maxCostUsd) {
      throw new Error(
        `OpenCode reported $${totalCostUsd.toFixed(
          4,
        )} after ${modelInvocations} invocation(s), exceeding OPENCODE_ACCEPTANCE_MAX_COST_USD=${maxCostUsd}. The gate stopped before another model call.`,
      );
    }
    return result;
  };

  try {
    const pluginMetadata = await stat(
      resolve(REPOSITORY_ROOT, "packages/opencode-plugin/dist/index.js"),
    );
    if (!pluginMetadata.isFile()) {
      throw new Error(
        "The built OpenCode plugin entry is missing. Run pnpm build:packages before live acceptance.",
      );
    }
    const [rootHelp, runHelp, sessionDeleteHelp] = await Promise.all([
      runCommand({
        label: "OpenCode CLI preflight",
        executable,
        args: ["--help"],
        cwd: REPOSITORY_ROOT,
        timeoutMs: 30_000,
      }),
      runCommand({
        label: "OpenCode run preflight",
        executable,
        args: ["run", "--help"],
        cwd: REPOSITORY_ROOT,
        timeoutMs: 30_000,
      }),
      runCommand({
        label: "OpenCode session cleanup preflight",
        executable,
        args: ["session", "delete", "--help"],
        cwd: REPOSITORY_ROOT,
        timeoutMs: 30_000,
      }),
    ]);
    assertOpenCodeCliCapabilities({
      rootHelp: rootHelp.stdout,
      runHelp: runHelp.stdout,
      sessionDeleteHelp: sessionDeleteHelp.stdout,
    });
    const health = await fetch(`${apiUrl}/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!health.ok) {
      throw new Error(`Lore health check failed with HTTP ${health.status}`);
    }
    await lore.listActivity({ limit: 1 });
    originalPolicy = await governance.getWorkspaceLearningPolicy();
    openCodeEnvironment = await prepareFixture({
      directory: fixtureDirectory,
      configDirectory,
      repository,
    });
    const provider = model.slice(0, model.indexOf("/"));
    const models = await runCommand({
      label: `OpenCode ${provider} model preflight`,
      executable,
      args: ["models", provider],
      cwd: fixtureDirectory,
      timeoutMs: commandTimeoutMs,
      environment: openCodeEnvironment,
    });
    if (
      !models.stdout
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .includes(model)
    ) {
      throw new Error(
        `OpenCode did not list ${model}. Choose an installed model with "opencode models ${provider}" and set OPENCODE_ACCEPTANCE_MODEL before retrying.`,
      );
    }
    await runCommand({
      label: "Isolated OpenCode configuration preflight",
      executable,
      args: ["debug", "config"],
      cwd: fixtureDirectory,
      timeoutMs: commandTimeoutMs,
      environment: openCodeEnvironment,
    });
    progress(
      `Preflight passed; at most ${MAX_MODEL_INVOCATIONS} model invocations and $${maxCostUsd.toFixed(
        2,
      )} reported cost are allowed`,
    );

    await governance.updateWorkspaceLearningPolicy({
      learningMode: "proposal_only",
    });
    policyUpdated = true;
    const policy = await governance.getWorkspaceLearningPolicy();
    if (policy.learningMode !== "proposal_only") {
      throw new Error("Lore did not enter proposal_only learning mode");
    }
    progress("Workspace is in proposal_only mode");

    const activeStatement = `For OpenCode acceptance ${nonce}, the supported component-catalog token is ${activeMarker}.`;
    const baseline = await lore.remember({
      content: activeStatement,
      scope: {},
      category: "convention",
      source: {
        agent: "human",
        sessionId: `opencode-live-setup-${nonce}`,
        rawText: activeStatement,
      },
    });
    cleanupLearningIds.add(baseline.memory.id);
    if (baseline.memory.status !== "active") {
      throw new Error("Manual OpenCode acceptance baseline was not active");
    }

    const rejected = await lore.observe({
      agent: "codex",
      repo: repository,
      sessionId: `opencode-live-rejected-${nonce}`,
      messages: [
        {
          id: `assistant-rejected-${nonce}`,
          role: "assistant",
          content: activeStatement,
        },
        {
          id: `user-rejected-${nonce}`,
          role: "user",
          content: `No, this is organization-wide across all repositories: the supported component-catalog token is ${rejectedMarker}, not ${activeMarker}.`,
        },
      ],
    });
    const rejectedProposal = rejected.memories.find(({ content }) =>
      content.includes(rejectedMarker),
    );
    if (
      rejectedProposal === undefined ||
      rejectedProposal.status !== "proposed"
    ) {
      throw new Error(
        "proposal_only did not keep the conflicting setup correction proposed",
      );
    }
    cleanupProposalIds.add(rejectedProposal.id);
    const rejectedDetail = await governance.getProposal(rejectedProposal.id);
    if (
      !rejectedDetail.conflicts.some(
        ({ severity, targetMemoryId }) =>
          severity === "blocking" &&
          targetMemoryId === baseline.memory.id,
      )
    ) {
      throw new Error(
        "Lore did not record a blocking conflict against the active baseline",
      );
    }
    const rejectedReview = await governance.reviewProposal(
      rejectedProposal.id,
      {
        decision: "reject",
        reason: "Live acceptance verifies rejected conflicts stay unavailable.",
      },
    );
    if (rejectedReview.proposal.status !== "deleted") {
      throw new Error("Rejected OpenCode setup proposal did not become deleted");
    }
    progress("Conflicting setup proposal was reviewed and rejected");

    const startedAt = new Date(Date.now() - 5_000).toISOString();
    const first = await runOpenCode("Real OpenCode first prompt", {
      model,
      title: `Lore OpenCode acceptance ${nonce}`,
      prompt: [
        "Do not inspect or modify files and do not use tools.",
        "What is the exact supported component-catalog token for this workspace?",
        "Reply only with the exact active token.",
      ].join(" "),
    });
    if (!first.text.includes(activeMarker)) {
      throw new Error(
        `Real OpenCode did not return the delivered active token: ${first.text}`,
      );
    }
    const firstDelivery = await waitForActivity({
      lore,
      from: startedAt,
      timeoutMs: activityTimeoutMs,
      pollIntervalMs,
      label: "OpenCode first-prompt delivery",
      predicate: ({ event, receipt }) =>
        event.type === "context_delivery" &&
        event.sessionId === first.sessionId &&
        receipt?.memoryIds.includes(baseline.memory.id) === true,
    });
    if (firstDelivery.receipt === null) {
      throw new Error("OpenCode first prompt did not record a delivery receipt");
    }
    assertMarkerAbsent(firstDelivery, {
      memoryId: rejectedProposal.id,
      marker: rejectedMarker,
      label: "OpenCode first prompt",
    });
    progress("First prompt delivered active context with an audited receipt");

    const correctionText = [
      `Correction: the durable repository rule ${capturedMarker} is that every new component-catalog entry needs a story file before merge.`,
      `The previously returned ${activeMarker} token remains correct.`,
      `Do not inspect or modify files and do not use tools. Reply only with ${capturedMarker}.`,
    ].join(" ");
    const correction = await runOpenCode("Real OpenCode correction prompt", {
      model,
      sessionId: first.sessionId,
      prompt: correctionText,
    });
    if (correction.sessionId !== first.sessionId) {
      throw new Error("OpenCode resumed into a different session");
    }
    if (!correction.text.includes(capturedMarker)) {
      throw new Error(
        `Real OpenCode did not acknowledge the correction marker: ${correction.text}`,
      );
    }
    const proposedLearning = await waitForProposedLearning({
      lore,
      marker: capturedMarker,
      timeoutMs: captureTimeoutMs,
      pollIntervalMs,
    });
    cleanupProposalIds.add(proposedLearning.id);
    assertLearningSource(proposedLearning, {
      agent: AGENT,
      sessionId: first.sessionId,
      label: "OpenCode paired correction",
    });
    const capturedRepository = assertRepositoryCandidate(
      proposedLearning,
      repository,
    );
    const pairedTurn = await waitForActivity({
      lore,
      from: startedAt,
      timeoutMs: activityTimeoutMs,
      pollIntervalMs,
      label: "OpenCode paired correction",
      predicate: ({ event, learnedMemories }) =>
        event.type === "paired_turn" &&
        event.sessionId === first.sessionId &&
        learnedMemories.some(({ id }) => id === proposedLearning.id),
    });
    if (pairedTurn.receipt === null) {
      throw new Error("OpenCode paired turn did not record a delivery receipt");
    }
    assertMarkerAbsent(pairedTurn, {
      memoryId: proposedLearning.id,
      marker: capturedMarker,
      label: "Unreviewed OpenCode proposal",
    });
    assertMarkerAbsent(pairedTurn, {
      memoryId: rejectedProposal.id,
      marker: rejectedMarker,
      label: "Rejected OpenCode conflict",
    });
    progress(
      "Assistant staging produced one paired turn; its proposal stayed out of delivery",
    );

    const proposalDetail = await governance.getProposal(proposedLearning.id);
    const blockingConflict = proposalDetail.conflicts.find(
      ({ severity, resolution }) =>
        severity === "blocking" && resolution === null,
    );
    const review =
      blockingConflict === undefined
        ? await governance.reviewProposal(proposedLearning.id, {
            decision: "approve",
            reason:
              "The live OpenCode correction is durable and repository-scoped.",
            scope: proposedLearning.scope,
          })
        : await governance.reviewProposal(proposedLearning.id, {
            decision: "use_proposal",
            targetMemoryId: blockingConflict.targetMemoryId,
            reason:
              "The live OpenCode correction is the authoritative replacement.",
            scope: proposedLearning.scope,
          });
    if (review.proposal.status !== "active") {
      throw new Error("Reviewed OpenCode proposal did not become active");
    }
    cleanupLearningIds.add(review.proposal.id);
    progress("OpenCode proposal was reviewed and activated");

    const fresh = await runOpenCode("Fresh OpenCode retrieval", {
      model,
      title: `Lore OpenCode fresh retrieval ${nonce}`,
      prompt: [
        "Do not inspect or modify files and do not use tools.",
        "What exact marker identifies the durable component-catalog story-file rule for this repository?",
        "Reply only with that marker.",
      ].join(" "),
    });
    if (fresh.sessionId === first.sessionId) {
      throw new Error("Fresh OpenCode retrieval reused the teaching session");
    }
    if (
      !fresh.text.includes(capturedMarker) ||
      fresh.text.includes(rejectedMarker)
    ) {
      throw new Error(
        `Fresh OpenCode did not return only the activated rule marker: ${fresh.text}`,
      );
    }
    const freshDelivery = await waitForActivity({
      lore,
      from: startedAt,
      timeoutMs: activityTimeoutMs,
      pollIntervalMs,
      label: "Fresh OpenCode delivery",
      predicate: ({ event, receipt }) =>
        event.type === "context_delivery" &&
        event.sessionId === fresh.sessionId &&
        receipt?.memoryIds.includes(proposedLearning.id) === true,
    });
    if (
      freshDelivery.receipt === null ||
      !freshDelivery.deliveredMemories.some(
        ({ id }) => id === proposedLearning.id,
      )
    ) {
      throw new Error(
        "Fresh OpenCode retrieval did not audit the activated learning",
      );
    }
    assertMarkerAbsent(freshDelivery, {
      memoryId: rejectedProposal.id,
      marker: rejectedMarker,
      label: "Fresh OpenCode retrieval",
    });
    progress("Fresh OpenCode session retrieved the active rule with a receipt");

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          repository,
          capturedRepository,
          model,
          teachingSessionId: first.sessionId,
          freshSessionId: fresh.sessionId,
          proposalId: proposedLearning.id,
          receiptId: freshDelivery.receipt.id,
          caps: {
            maxModelInvocations: MAX_MODEL_INVOCATIONS,
            actualModelInvocations: modelInvocations,
            maxReportedCostUsd: maxCostUsd,
            actualReportedCostUsd: totalCostUsd,
          },
          checks: {
            firstPromptDelivered: true,
            assistantStaged: true,
            correctionCapturedAsPairedTurn: true,
            proposalOnlyKeptCaptureInactive: true,
            proposalReviewedAndActivated: true,
            freshOpenCodeRetrievedActiveRule: true,
            freshDeliveryReceiptRecorded: true,
            rejectedConflictNotInjected: true,
            unreviewedProposalNotInjected: true,
          },
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    for (const proposalId of cleanupProposalIds) {
      await governance
        .reviewProposal(proposalId, {
          decision: "reject",
          reason: "Clean up an unfinished OpenCode live acceptance proposal.",
        })
        .catch(() => undefined);
    }
    if (policyUpdated && originalPolicy !== undefined) {
      await governance
        .updateWorkspaceLearningPolicy({
          learningMode: originalPolicy.learningMode,
          llmConflictAnalysisEnabled:
            originalPolicy.llmConflictAnalysisEnabled,
        })
        .catch((error: unknown) => {
          process.stderr.write(
            `Could not restore workspace learning policy: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          );
        });
    }
    for (const marker of markers) {
      const learnings = await matchingLearnings(lore, marker).catch(() => []);
      learnings.forEach(({ id }) => cleanupLearningIds.add(id));
    }
    for (const learningId of cleanupLearningIds) {
      await lore.forgetLearning(learningId).catch((error: unknown) => {
        process.stderr.write(
          `Could not forget OpenCode acceptance learning ${learningId}: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      });
    }
    if (openCodeEnvironment !== undefined) {
      for (const sessionId of sessionIds) {
        await runCommand({
          label: `OpenCode session cleanup ${sessionId}`,
          executable,
          args: ["session", "delete", sessionId],
          cwd: fixtureDirectory,
          timeoutMs: 30_000,
          environment: openCodeEnvironment,
        }).catch((error: unknown) => {
          process.stderr.write(
            `Could not delete OpenCode session ${sessionId}: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          );
        });
      }
    }
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(
      (error: unknown) => {
        process.stderr.write(
          `Could not remove ${temporaryDirectory}: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      },
    );
  }
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPath)).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `OpenCode live acceptance failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
