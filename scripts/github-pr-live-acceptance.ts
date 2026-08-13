import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LoreClient,
  type ActivityItem,
  type Learning,
} from "../packages/sdk/src/index.js";

export type ReviewProvider = "codex" | "devin";

export interface CommandSpec {
  executable: string;
  args: string[];
}

export interface WorkflowRequirement {
  name: string;
  path: string;
  state?: string;
}

export interface AcceptanceConfig {
  repository: string;
  baseBranch: string | undefined;
  providers: ReviewProvider[];
  cleanup: boolean;
  cliRepository: string;
  cliVersion: string;
  loreApiUrl: string;
  loreWorkspaceToken: string;
  branchPrefix: string;
  documentationDirectory: string;
  commandTimeoutMs: number;
  reviewTimeoutMs: number;
  correctionTimeoutMs: number;
  learningTimeoutMs: number;
  healthTimeoutMs: number;
  pollIntervalMs: number;
}

export interface PreflightSnapshot {
  actor?: string;
  repository?: {
    fork: boolean;
    canPush: boolean;
    defaultBranch: string;
  };
  baseBranchExists: boolean;
  workflows: WorkflowRequirement[];
  labels: string[];
  secrets: string[];
  variables: string[];
  loreHealthReachable: boolean;
  binaryReleaseUsable: boolean;
  errors: string[];
}

export interface CleanupState {
  repository: string;
  branch?: string;
  prNumber?: number;
  labels: string[];
  commentIds: number[];
}

export interface ReviewMarker {
  provider: ReviewProvider;
  prNumber: number;
  headSha: string;
  key: string;
}

interface RepositoryResponse {
  fork?: boolean;
  default_branch?: string;
  permissions?: { push?: boolean };
}

interface WorkflowListResponse {
  workflows?: Array<{ name?: string; path?: string; state?: string }>;
}

interface PullRequestResponse {
  number?: number;
  html_url?: string;
  head?: { sha?: string; repo?: { full_name?: string } };
}

interface IssueComment {
  id?: number;
  body?: string | null;
  html_url?: string;
  created_at?: string;
  user?: { login?: string };
}

interface ActionRun {
  databaseId?: number;
  displayTitle?: string;
  status?: string;
  conclusion?: string | null;
  headSha?: string;
  createdAt?: string;
  url?: string;
  workflowName?: string;
}

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DEFAULT_REPOSITORY = "treadiehq/retvrn-md";
const DEFAULT_CLI_REPOSITORY = "treadiehq/lore";
const DEFAULT_CLI_VERSION = "v0.1.0";
const CORRECTION_WORKFLOW: WorkflowRequirement = {
  name: "Lore review correction",
  path: ".github/workflows/lore-observe-correction.yml",
};
const PROVIDER_REQUIREMENTS: Record<
  ReviewProvider,
  {
    label: string;
    workflow: WorkflowRequirement;
    secrets: string[];
    variables: string[];
  }
> = {
  codex: {
    label: "lore:codex-review",
    workflow: {
      name: "Lore Codex review",
      path: ".github/workflows/lore-codex-review.yml",
    },
    secrets: ["OPENAI_API_KEY"],
    variables: [],
  },
  devin: {
    label: "lore:devin-review",
    workflow: {
      name: "Lore Devin review",
      path: ".github/workflows/lore-devin-review.yml",
    },
    secrets: ["DEVIN_API_KEY"],
    variables: ["DEVIN_ORG_ID"],
  },
};

function required(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(
      `${name} is required. Configure it in the protected live-acceptance environment or export it before running the command.`,
    );
  }
  return value;
}

function milliseconds(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = environment[name]?.trim();
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1_000) {
    throw new Error(`${name} must be an integer of at least 1000`);
  }
  return value;
}

export function parseProviders(value: string | undefined): ReviewProvider[] {
  const normalized = value?.trim().toLowerCase() || "codex,devin";
  if (normalized === "both") {
    return ["codex", "devin"];
  }
  const providers = normalized
    .split(",")
    .map((provider) => provider.trim())
    .filter(Boolean);
  if (
    providers.length === 0 ||
    providers.some((provider) => provider !== "codex" && provider !== "devin")
  ) {
    throw new Error(
      "GITHUB_PR_LIVE_PROVIDERS must be codex, devin, both, or a comma-separated combination",
    );
  }
  return [...new Set(providers)] as ReviewProvider[];
}

export function parseConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): AcceptanceConfig {
  const cleanupValue =
    environment.GITHUB_PR_LIVE_CLEANUP?.trim().toLowerCase() || "always";
  if (!["always", "never"].includes(cleanupValue)) {
    throw new Error(
      "GITHUB_PR_LIVE_CLEANUP must be either always or never",
    );
  }
  const branchPrefix =
    environment.GITHUB_PR_LIVE_BRANCH_PREFIX?.trim() || "lore-live-acceptance";
  if (!/^[a-z0-9][a-z0-9-]{2,48}$/u.test(branchPrefix)) {
    throw new Error(
      "GITHUB_PR_LIVE_BRANCH_PREFIX must contain 3-49 lowercase letters, digits, or hyphens",
    );
  }
  const documentationDirectory =
    environment.GITHUB_PR_LIVE_DOC_DIRECTORY?.trim() || "docs";
  if (
    documentationDirectory.startsWith("/") ||
    documentationDirectory.includes("..") ||
    !/^[A-Za-z0-9._/-]+$/u.test(documentationDirectory)
  ) {
    throw new Error(
      "GITHUB_PR_LIVE_DOC_DIRECTORY must be a safe relative directory",
    );
  }
  const baseBranch = environment.GITHUB_PR_LIVE_BASE_BRANCH?.trim();
  const repository =
    environment.GITHUB_PR_LIVE_REPO?.trim() || DEFAULT_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error(
      "GITHUB_PR_LIVE_REPO must be a GitHub repository slug in owner/name form",
    );
  }
  const cliRepository =
    environment.GITHUB_PR_LIVE_CLI_REPOSITORY?.trim() ||
    DEFAULT_CLI_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(cliRepository)) {
    throw new Error(
      "GITHUB_PR_LIVE_CLI_REPOSITORY must be a GitHub repository slug in owner/name form",
    );
  }
  const cliVersion =
    environment.GITHUB_PR_LIVE_CLI_VERSION?.trim() || DEFAULT_CLI_VERSION;
  if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(cliVersion)) {
    throw new Error(
      "GITHUB_PR_LIVE_CLI_VERSION must be a release tag such as v0.1.0",
    );
  }
  return {
    repository,
    baseBranch:
      baseBranch === undefined || baseBranch === "" ? undefined : baseBranch,
    providers: parseProviders(environment.GITHUB_PR_LIVE_PROVIDERS),
    cleanup: cleanupValue === "always",
    cliRepository,
    cliVersion,
    loreApiUrl: required(environment, "LORE_API_URL").replace(/\/+$/u, ""),
    loreWorkspaceToken: required(environment, "LORE_WORKSPACE_TOKEN"),
    branchPrefix,
    documentationDirectory: documentationDirectory.replace(/\/+$/u, ""),
    commandTimeoutMs: milliseconds(
      environment,
      "GITHUB_PR_LIVE_COMMAND_TIMEOUT_MS",
      2 * 60_000,
    ),
    reviewTimeoutMs: milliseconds(
      environment,
      "GITHUB_PR_LIVE_REVIEW_TIMEOUT_MS",
      30 * 60_000,
    ),
    correctionTimeoutMs: milliseconds(
      environment,
      "GITHUB_PR_LIVE_CORRECTION_TIMEOUT_MS",
      10 * 60_000,
    ),
    learningTimeoutMs: milliseconds(
      environment,
      "GITHUB_PR_LIVE_LEARNING_TIMEOUT_MS",
      2 * 60_000,
    ),
    healthTimeoutMs: milliseconds(
      environment,
      "GITHUB_PR_LIVE_HEALTH_TIMEOUT_MS",
      10_000,
    ),
    pollIntervalMs: milliseconds(
      environment,
      "GITHUB_PR_LIVE_POLL_INTERVAL_MS",
      10_000,
    ),
  };
}

function commandDisplay(spec: CommandSpec): string {
  return [spec.executable, ...spec.args]
    .map((value) =>
      /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)
        ? value
        : JSON.stringify(value),
    )
    .join(" ");
}

async function runCommand(
  spec: CommandSpec,
  timeoutMs: number,
  cwd = REPOSITORY_ROOT,
): Promise<string> {
  try {
    const result = await new Promise<{ stdout: string; stderr: string }>(
      (resolvePromise, reject) => {
        const child = execFile(
          spec.executable,
          spec.args,
          {
            cwd,
            encoding: "utf8",
            env: {
              ...process.env,
              GH_PAGER: "cat",
              GH_PROMPT_DISABLED: "1",
              GIT_TERMINAL_PROMPT: "0",
              NO_COLOR: "1",
            },
            killSignal: "SIGKILL",
            maxBuffer: 8 * 1024 * 1024,
            timeout: timeoutMs,
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
    return result.stdout.trim();
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
          ].find(Boolean)
        : undefined;
    throw new Error(
      `${commandDisplay(spec)} failed${detail === undefined ? "" : `: ${detail}`}`,
      { cause: error },
    );
  }
}

async function gh(
  args: readonly string[],
  timeoutMs: number,
): Promise<string> {
  return runCommand({ executable: "gh", args: [...args] }, timeoutMs);
}

async function ghJson<T>(
  args: readonly string[],
  timeoutMs: number,
): Promise<T> {
  const output = await gh(args, timeoutMs);
  try {
    return JSON.parse(output) as T;
  } catch (error) {
    throw new Error(`gh returned invalid JSON for ${args.join(" ")}`, {
      cause: error,
    });
  }
}

export function parseNameLines(output: string): string[] {
  return [
    ...new Set(
      output
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

function requiredWorkflowRequirements(
  providers: readonly ReviewProvider[],
): WorkflowRequirement[] {
  return [
    ...providers.map((provider) => PROVIDER_REQUIREMENTS[provider].workflow),
    CORRECTION_WORKFLOW,
  ];
}

function requiredNames(
  providers: readonly ReviewProvider[],
  kind: "secrets" | "variables",
): string[] {
  const common =
    kind === "secrets"
      ? ["LORE_WORKSPACE_TOKEN"]
      : ["LORE_API_URL", "LORE_CLI_VERSION"];
  return [
    ...new Set([
      ...common,
      ...providers.flatMap(
        (provider) => PROVIDER_REQUIREMENTS[provider][kind],
      ),
    ]),
  ];
}

export function collectPreflightFailures(
  config: Pick<
    AcceptanceConfig,
    | "repository"
    | "baseBranch"
    | "providers"
    | "cliRepository"
    | "cliVersion"
  >,
  snapshot: PreflightSnapshot,
): string[] {
  const failures = [...snapshot.errors];
  if (snapshot.actor === undefined) {
    failures.push(
      "GitHub authentication was not verified. Set GH_TOKEN/GITHUB_TOKEN or run `gh auth login` before retrying.",
    );
  }
  if (snapshot.repository === undefined) {
    failures.push(
      `Repository ${config.repository} could not be inspected. Confirm the slug and token access.`,
    );
  } else {
    if (snapshot.repository.fork) {
      failures.push(
        `${config.repository} is a fork. Use a writable non-fork repository because secret-backed review workflows reject fork pull requests.`,
      );
    }
    if (!snapshot.repository.canPush) {
      failures.push(
        `The authenticated GitHub identity cannot push to ${config.repository}. Grant write access or use a token with repository contents and pull-request access.`,
      );
    }
  }
  const baseBranch =
    config.baseBranch ?? snapshot.repository?.defaultBranch ?? "<unknown>";
  if (!snapshot.baseBranchExists) {
    failures.push(
      `Base branch ${baseBranch} does not exist or is not readable in ${config.repository}. Set GITHUB_PR_LIVE_BASE_BRANCH to an existing branch.`,
    );
  }
  for (const requirement of requiredWorkflowRequirements(config.providers)) {
    const workflow = snapshot.workflows.find(
      (candidate) =>
        candidate.name === requirement.name &&
        candidate.path === requirement.path,
    );
    if (workflow === undefined) {
      failures.push(
        `Missing exact workflow ${requirement.name} at ${requirement.path}. Install and commit the current Lore GitHub workflow templates first.`,
      );
    } else if (workflow.state !== undefined && workflow.state !== "active") {
      failures.push(
        `Workflow ${requirement.name} at ${requirement.path} is ${workflow.state}. Enable it before running acceptance.`,
      );
    }
  }
  for (const provider of config.providers) {
    const label = PROVIDER_REQUIREMENTS[provider].label;
    if (!snapshot.labels.includes(label)) {
      failures.push(
        `Missing repository label ${label}. Create it before running acceptance; the harness does not mutate target configuration.`,
      );
    }
  }
  for (const secret of requiredNames(config.providers, "secrets")) {
    if (!snapshot.secrets.includes(secret)) {
      failures.push(
        `Missing Actions secret named ${secret}. Configure that secret in ${config.repository}; its value is never read by preflight.`,
      );
    }
  }
  for (const variable of requiredNames(config.providers, "variables")) {
    if (!snapshot.variables.includes(variable)) {
      failures.push(
        `Missing Actions variable named ${variable}. Configure it in ${config.repository}${
          variable === "LORE_CLI_VERSION"
            ? ` (for example ${config.cliVersion})`
            : ""
        }.`,
      );
    }
  }
  if (!snapshot.loreHealthReachable) {
    failures.push(
      "Lore /health is not reachable from this runner through LORE_API_URL. Use a runner-reachable HTTPS URL and verify network policy.",
    );
  }
  if (!snapshot.binaryReleaseUsable) {
    failures.push(
      `Lore CLI release ${config.cliRepository}@${config.cliVersion} is unavailable or incomplete. Publish its binaries and SHA256SUMS, then set GITHUB_PR_LIVE_CLI_REPOSITORY/GITHUB_PR_LIVE_CLI_VERSION and target variable LORE_CLI_VERSION.`,
    );
  }
  return [...new Set(failures)];
}

async function capture<T>(
  description: string,
  operation: () => Promise<T>,
  errors: string[],
): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    errors.push(
      `${description}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

async function preflight(config: AcceptanceConfig): Promise<{
  snapshot: PreflightSnapshot;
  baseBranch: string;
  defaultBranch: string;
}> {
  const errors: string[] = [];
  const snapshot: PreflightSnapshot = {
    baseBranchExists: false,
    workflows: [],
    labels: [],
    secrets: [],
    variables: [],
    loreHealthReachable: false,
    binaryReleaseUsable: false,
    errors,
  };
  const repositoryPath = `repos/${config.repository}`;
  const [actor, repository, workflows, labels, secrets, variables, health, cli] =
    await Promise.all([
      capture(
        "GitHub authentication check failed",
        async () => {
          const response = await ghJson<{ login?: string }>(
            ["api", "user"],
            config.commandTimeoutMs,
          );
          if (response.login === undefined || response.login.trim() === "") {
            throw new Error("the authenticated user response had no login");
          }
          return response.login;
        },
        errors,
      ),
      capture(
        "Repository inspection failed",
        () =>
          ghJson<RepositoryResponse>(
            ["api", repositoryPath],
            config.commandTimeoutMs,
          ),
        errors,
      ),
      capture(
        "Workflow inspection failed",
        () =>
          ghJson<WorkflowListResponse>(
            ["api", `${repositoryPath}/actions/workflows?per_page=100`],
            config.commandTimeoutMs,
          ),
        errors,
      ),
      capture(
        "Label inspection failed",
        () =>
          gh(
            [
              "api",
              "--paginate",
              `${repositoryPath}/labels?per_page=100`,
              "--jq",
              ".[].name",
            ],
            config.commandTimeoutMs,
          ),
        errors,
      ),
      capture(
        "Actions secret-name inspection failed",
        () =>
          gh(
            [
              "api",
              "--paginate",
              `${repositoryPath}/actions/secrets?per_page=100`,
              "--jq",
              ".secrets[].name",
            ],
            config.commandTimeoutMs,
          ),
        errors,
      ),
      capture(
        "Actions variable-name inspection failed",
        () =>
          gh(
            [
              "api",
              "--paginate",
              `${repositoryPath}/actions/variables?per_page=100`,
              "--jq",
              ".variables[].name",
            ],
            config.commandTimeoutMs,
          ),
        errors,
      ),
      capture(
        "Lore health check failed",
        async () => {
          const response = await fetch(`${config.loreApiUrl}/health`, {
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(config.healthTimeoutMs),
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          return true;
        },
        errors,
      ),
      capture(
        "Lore CLI release check failed",
        async () => {
          const releaseUrl = `https://github.com/${config.cliRepository}/releases/download/${config.cliVersion}/SHA256SUMS`;
          const response = await fetch(releaseUrl, {
            signal: AbortSignal.timeout(config.commandTimeoutMs),
          });
          if (!response.ok) {
            throw new Error(`${releaseUrl} returned HTTP ${response.status}`);
          }
          const manifest = await response.text();
          for (const asset of [
            "lore-linux-x64",
            "lore-linux-arm64",
            "lore-darwin-x64",
            "lore-darwin-arm64",
          ]) {
            if (!manifest.split(/\r?\n/u).some((line) => line.trim().endsWith(asset))) {
              throw new Error(`SHA256SUMS is missing ${asset}`);
            }
          }
          return true;
        },
        errors,
      ),
    ]);
  if (actor !== undefined) {
    snapshot.actor = actor;
  }
  if (
    repository?.fork !== undefined &&
    repository.permissions?.push !== undefined &&
    repository.default_branch !== undefined
  ) {
    snapshot.repository = {
      fork: repository.fork,
      canPush: repository.permissions.push,
      defaultBranch: repository.default_branch,
    };
  }
  snapshot.workflows =
    workflows?.workflows
      ?.filter(
        (
          workflow,
        ): workflow is { name: string; path: string; state?: string } =>
          typeof workflow.name === "string" &&
          typeof workflow.path === "string",
      )
      .map((workflow) => ({
        name: workflow.name,
        path: workflow.path,
        ...(workflow.state === undefined ? {} : { state: workflow.state }),
      })) ?? [];
  snapshot.labels = parseNameLines(labels ?? "");
  snapshot.secrets = parseNameLines(secrets ?? "");
  snapshot.variables = parseNameLines(variables ?? "");
  snapshot.loreHealthReachable = health === true;
  snapshot.binaryReleaseUsable = cli === true;

  const baseBranch =
    config.baseBranch ?? snapshot.repository?.defaultBranch ?? "<unknown>";
  if (baseBranch !== "<unknown>") {
    snapshot.baseBranchExists =
      (await capture(
        "Base branch inspection failed",
        async () => {
          await gh(
            [
              "api",
              `${repositoryPath}/branches/${encodeURIComponent(baseBranch)}`,
            ],
            config.commandTimeoutMs,
          );
          return true;
        },
        errors,
      )) === true;
  }
  const failures = collectPreflightFailures(config, snapshot);
  if (failures.length > 0) {
    throw new Error(
      [
        `GitHub live acceptance preflight failed for ${config.repository}:`,
        ...failures.map((failure) => `- ${failure}`),
        "",
        "No target workflows, labels, secrets, variables, branches, or pull requests were changed.",
      ].join("\n"),
    );
  }
  const defaultBranch = snapshot.repository?.defaultBranch;
  if (defaultBranch === undefined) {
    throw new Error("Preflight did not resolve the repository default branch");
  }
  return { snapshot, baseBranch, defaultBranch };
}

function markerKey(input: {
  provider: ReviewProvider;
  repository: string;
  prNumber: number;
  headSha: string;
}): string {
  return createHash("sha256")
    .update(
      `${input.provider}\0${input.repository}\0${input.prNumber}\0${input.headSha}`,
    )
    .digest("hex");
}

export function parseReviewMarker(
  body: string,
  repository: string,
): ReviewMarker | undefined {
  const match =
    /<!-- lore-review:v2 key=([a-f0-9]{64}) provider=(codex|devin) head=(\S+) pr=(\d+) -->/u.exec(
      body,
    );
  if (
    match?.[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined ||
    match[4] === undefined
  ) {
    return undefined;
  }
  let headSha: string;
  try {
    headSha = decodeURIComponent(match[3]);
  } catch {
    return undefined;
  }
  const provider = match[2] as ReviewProvider;
  const prNumber = Number(match[4]);
  if (
    !Number.isSafeInteger(prNumber) ||
    markerKey({ provider, repository, prNumber, headSha }) !== match[1]
  ) {
    return undefined;
  }
  return { provider, prNumber, headSha, key: match[1] };
}

export function matchesReviewComment(
  comment: Pick<IssueComment, "body" | "user">,
  expected: {
    provider: ReviewProvider;
    repository: string;
    prNumber: number;
    headSha: string;
  },
): boolean {
  if (
    comment.user?.login !== "github-actions[bot]" ||
    typeof comment.body !== "string" ||
    !comment.body.includes("Provenance:")
  ) {
    return false;
  }
  const marker = parseReviewMarker(comment.body, expected.repository);
  return (
    marker?.provider === expected.provider &&
    marker.prNumber === expected.prNumber &&
    marker.headSha === expected.headSha
  );
}

export function buildCleanupCommands(state: CleanupState): CommandSpec[] {
  const commands: CommandSpec[] = [];
  for (const commentId of [...new Set(state.commentIds)]) {
    commands.push({
      executable: "gh",
      args: [
        "api",
        "--method",
        "DELETE",
        `repos/${state.repository}/issues/comments/${commentId}`,
      ],
    });
  }
  if (state.prNumber !== undefined) {
    for (const label of [...new Set(state.labels)]) {
      commands.push({
        executable: "gh",
        args: [
          "api",
          "--method",
          "DELETE",
          `repos/${state.repository}/issues/${state.prNumber}/labels/${encodeURIComponent(label)}`,
        ],
      });
    }
    commands.push({
      executable: "gh",
      args: [
        "api",
        "--method",
        "PATCH",
        `repos/${state.repository}/pulls/${state.prNumber}`,
        "-f",
        "state=closed",
      ],
    });
  }
  if (state.branch !== undefined) {
    commands.push({
      executable: "gh",
      args: [
        "api",
        "--method",
        "DELETE",
        `repos/${state.repository}/git/refs/heads/${state.branch}`,
      ],
    });
  }
  return commands;
}

async function sleep(durationMs: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, durationMs));
}

async function branchHeadSha(
  repository: string,
  branch: string,
  timeoutMs: number,
): Promise<string> {
  const response = await ghJson<{ object?: { sha?: string } }>(
    [
      "api",
      `repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`,
    ],
    timeoutMs,
  );
  const sha = response.object?.sha;
  if (sha === undefined || sha === "") {
    throw new Error(`GitHub did not return a SHA for ${branch}`);
  }
  return sha;
}

async function createPullRequest(input: {
  config: AcceptanceConfig;
  baseBranch: string;
  nonce: string;
  state: CleanupState;
}): Promise<{ number: number; url: string; headSha: string }> {
  const { config, baseBranch, nonce, state } = input;
  const baseSha = await branchHeadSha(
    config.repository,
    baseBranch,
    config.commandTimeoutMs,
  );
  const branch = `${config.branchPrefix}-${nonce.toLowerCase()}`;
  state.branch = branch;
  await gh(
    [
      "api",
      "--method",
      "POST",
      `repos/${config.repository}/git/refs`,
      "-f",
      `ref=refs/heads/${branch}`,
      "-f",
      `sha=${baseSha}`,
    ],
    config.commandTimeoutMs,
  );
  const documentationPath = `${config.documentationDirectory}/lore-live-acceptance-${nonce.toLowerCase()}.md`;
  const documentation = [
    `# Lore GitHub live acceptance ${nonce}`,
    "",
    "This disposable documentation-only change exercises the configured Lore pull-request review workflows.",
    "",
    `Acceptance marker: ${nonce}`,
    "",
  ].join("\n");
  await gh(
    [
      "api",
      "--method",
      "PUT",
      `repos/${config.repository}/contents/${documentationPath}`,
      "-f",
      `message=docs: add Lore live acceptance ${nonce}`,
      "-f",
      `content=${Buffer.from(documentation).toString("base64")}`,
      "-f",
      `branch=${branch}`,
    ],
    config.commandTimeoutMs,
  );
  const created = await ghJson<PullRequestResponse>(
    [
      "api",
      "--method",
      "POST",
      `repos/${config.repository}/pulls`,
      "-f",
      `title=docs: Lore GitHub live acceptance ${nonce}`,
      "-f",
      `head=${branch}`,
      "-f",
      `base=${baseBranch}`,
      "-f",
      `body=Disposable Lore live acceptance run ${nonce}. This pull request changes documentation only and will be closed automatically.`,
    ],
    config.commandTimeoutMs,
  );
  if (created.number !== undefined) {
    state.prNumber = created.number;
  }
  if (
    created.number === undefined ||
    created.html_url === undefined ||
    created.head?.sha === undefined ||
    created.head.repo?.full_name !== config.repository
  ) {
    throw new Error(
      "GitHub created an invalid or non-same-repository pull request",
    );
  }
  return {
    number: created.number,
    url: created.html_url,
    headSha: created.head.sha,
  };
}

async function waitForActionRun(input: {
  config: AcceptanceConfig;
  workflow: WorkflowRequirement;
  event: "pull_request" | "issue_comment";
  headSha: string;
  branch?: string;
  createdAfter: string;
  timeoutMs: number;
  excludedRunIds: ReadonlySet<number>;
  displayTitle: string;
}): Promise<ActionRun> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const runs = await listActionRuns(input);
    const createdAfter = Date.parse(input.createdAfter);
    const run = runs
      .filter(
        (candidate) =>
          candidate.headSha === input.headSha &&
          candidate.workflowName === input.workflow.name &&
          candidate.displayTitle === input.displayTitle &&
          (candidate.databaseId === undefined ||
            !input.excludedRunIds.has(candidate.databaseId)) &&
          Date.parse(candidate.createdAt ?? "") >= createdAfter,
      )
      .sort(
        (left, right) =>
          Date.parse(right.createdAt ?? "") - Date.parse(left.createdAt ?? ""),
      )[0];
    if (run?.status === "completed") {
      if (run.conclusion !== "success") {
        const logs =
          run.databaseId === undefined
            ? ""
            : await gh(
                [
                  "run",
                  "view",
                  String(run.databaseId),
                  "--repo",
                  input.config.repository,
                  "--log-failed",
                ],
                input.config.commandTimeoutMs,
              ).catch((error: unknown) =>
                error instanceof Error ? error.message : String(error),
              );
        throw new Error(
          `${input.workflow.name} completed with ${run.conclusion ?? "no conclusion"} at exact head ${input.headSha}${
            logs === "" ? "" : `\n${logs}`
          }`,
        );
      }
      return run;
    }
    await sleep(input.config.pollIntervalMs);
  }
  throw new Error(
    `Timed out waiting for successful ${input.workflow.name} at exact head ${input.headSha}. Inspect Actions in ${input.config.repository}.`,
  );
}

async function listActionRuns(input: {
  config: AcceptanceConfig;
  workflow: WorkflowRequirement;
  event: "pull_request" | "issue_comment";
  branch?: string;
}): Promise<ActionRun[]> {
  return ghJson<ActionRun[]>(
    [
      "run",
      "list",
      "--repo",
      input.config.repository,
      "--workflow",
      input.workflow.name,
      "--event",
      input.event,
      "--limit",
      "50",
      "--json",
      "databaseId,displayTitle,status,conclusion,headSha,createdAt,url,workflowName",
      ...(input.branch === undefined ? [] : ["--branch", input.branch]),
    ],
    input.config.commandTimeoutMs,
  );
}

function actionRunIds(
  runs: readonly ActionRun[],
  headSha: string,
): Set<number> {
  return new Set(
    runs
      .filter((run) => run.headSha === headSha)
      .map((run) => run.databaseId)
      .filter((id): id is number => id !== undefined),
  );
}

async function waitForReviewComment(input: {
  config: AcceptanceConfig;
  provider: ReviewProvider;
  prNumber: number;
  headSha: string;
}): Promise<Required<Pick<IssueComment, "id" | "html_url">>> {
  const deadline = Date.now() + input.config.reviewTimeoutMs;
  while (Date.now() < deadline) {
    const comments = await ghJson<IssueComment[]>(
      [
        "api",
        `repos/${input.config.repository}/issues/${input.prNumber}/comments?per_page=100`,
      ],
      input.config.commandTimeoutMs,
    );
    const comment = comments.find((candidate) =>
      matchesReviewComment(candidate, {
        provider: input.provider,
        repository: input.config.repository,
        prNumber: input.prNumber,
        headSha: input.headSha,
      }),
    );
    if (comment?.id !== undefined && comment.html_url !== undefined) {
      return { id: comment.id, html_url: comment.html_url };
    }
    await sleep(input.config.pollIntervalMs);
  }
  throw new Error(
    `The successful ${input.provider} workflow did not produce an exact-head Lore bot comment before timeout`,
  );
}

function assertWorkspaceScope(learning: Learning, provider: ReviewProvider): void {
  if (
    learning.scope.organization === undefined ||
    learning.scope.project !== undefined ||
    learning.scope.repo !== undefined ||
    learning.scope.path !== undefined ||
    learning.scope.component !== undefined
  ) {
    throw new Error(
      `${provider} correction learning ${learning.id} was not stored at workspace-only scope`,
    );
  }
}

function matchingActivity(
  activities: readonly ActivityItem[],
  marker: string,
  learningIds: ReadonlySet<string>,
): ActivityItem | undefined {
  return activities.find(
    (activity) =>
      activity.correction.includes(marker) &&
      activity.learnedMemories.some((memory) => learningIds.has(memory.id)),
  );
}

async function verifyLoreCorrection(input: {
  lore: LoreClient;
  config: AcceptanceConfig;
  provider: ReviewProvider;
  marker: string;
  correctionCommentId: number;
  startedAt: string;
  cleanupLearningIds: Set<string>;
}): Promise<{ learningIds: string[]; receiptId: string }> {
  const deadline = Date.now() + input.config.learningTimeoutMs;
  let learnings: Learning[] = [];
  let activity: ActivityItem | undefined;
  while (Date.now() < deadline) {
    const [learningResult, activityResult] = await Promise.all([
      input.lore.listLearnings({
        query: input.marker,
        status: "active",
        limit: 100,
      }),
      input.lore.listActivity({
        connector: "github",
        agent: input.provider,
        from: input.startedAt,
        limit: 100,
      }),
    ]);
    learnings = learningResult.memories.filter((learning) =>
      learning.content.includes(input.marker),
    );
    learnings.forEach((learning) => input.cleanupLearningIds.add(learning.id));
    const ids = new Set(learnings.map((learning) => learning.id));
    activity = matchingActivity(activityResult.activities, input.marker, ids);
    if (learnings.length > 0 && activity !== undefined) {
      break;
    }
    await sleep(input.config.pollIntervalMs);
  }
  if (learnings.length === 0 || activity === undefined) {
    throw new Error(
      `Lore did not expose the ${input.provider} correction learning and matching activity before timeout`,
    );
  }
  for (const learning of learnings) {
    assertWorkspaceScope(learning, input.provider);
    if (
      learning.source.agent !== input.provider ||
      learning.source.eventId !== activity.event.id
    ) {
      throw new Error(
        `${input.provider} correction learning ${learning.id} lacks matching GitHub provenance`,
      );
    }
  }
  if (
    activity.event.connector !== "github" ||
    activity.event.externalEventId !==
      `github:issue_comment:${input.config.repository}:${input.correctionCommentId}` ||
    activity.receipt === null
  ) {
    throw new Error(
      `${input.provider} correction activity lacks the expected GitHub event provenance or receipt`,
    );
  }
  const delivery = await input.lore.deliverContext({
    connector: "github-live-acceptance",
    eventId: `github-live-acceptance:${input.provider}:${randomUUID()}`,
    sessionId: `github-live-acceptance:${input.provider}:${Date.now()}`,
    task: {
      agent: input.provider,
      repo: input.config.repository,
      task:
        "Review a disposable live-acceptance documentation file and determine whether it is test evidence or product behavior.",
      files: [
        `${input.config.documentationDirectory}/lore-live-acceptance-proof.md`,
      ],
      limit: 20,
    },
  });
  const retrieved = delivery.memories.filter((memory) =>
    memory.content.includes(input.marker),
  );
  if (
    retrieved.length === 0 ||
    !delivery.context.includes(input.marker) ||
    !retrieved.some((memory) => delivery.receipt.memoryIds.includes(memory.id))
  ) {
    throw new Error(
      `${input.provider} correction was not retrieved as repository-relevant context with a delivery receipt`,
    );
  }
  return {
    learningIds: learnings.map((learning) => learning.id),
    receiptId: delivery.receipt.id,
  };
}

async function addLabel(input: {
  config: AcceptanceConfig;
  prNumber: number;
  label: string;
}): Promise<void> {
  await gh(
    [
      "api",
      "--method",
      "POST",
      `repos/${input.config.repository}/issues/${input.prNumber}/labels`,
      "-f",
      `labels[]=${input.label}`,
    ],
    input.config.commandTimeoutMs,
  );
}

async function removeLabel(input: {
  config: AcceptanceConfig;
  prNumber: number;
  label: string;
}): Promise<void> {
  await gh(
    [
      "api",
      "--method",
      "DELETE",
      `repos/${input.config.repository}/issues/${input.prNumber}/labels/${encodeURIComponent(input.label)}`,
    ],
    input.config.commandTimeoutMs,
  );
}

async function runProvider(input: {
  lore: LoreClient;
  config: AcceptanceConfig;
  provider: ReviewProvider;
  pullRequest: { number: number; url: string; headSha: string };
  branch: string;
  defaultBranch: string;
  nonce: string;
  state: CleanupState;
  cleanupLearningIds: Set<string>;
}): Promise<{
  provider: ReviewProvider;
  reviewRunUrl: string | undefined;
  reviewCommentUrl: string;
  correctionRunUrl: string | undefined;
  learningIds: string[];
  receiptId: string;
}> {
  const requirement = PROVIDER_REQUIREMENTS[input.provider];
  const existingReviewRunIds = actionRunIds(
    await listActionRuns({
      config: input.config,
      workflow: requirement.workflow,
      event: "pull_request",
      branch: input.branch,
    }),
    input.pullRequest.headSha,
  );
  const reviewStartedAt = new Date(Date.now() - 5_000).toISOString();
  await addLabel({
    config: input.config,
    prNumber: input.pullRequest.number,
    label: requirement.label,
  });
  input.state.labels.push(requirement.label);
  const reviewRun = await waitForActionRun({
    config: input.config,
    workflow: requirement.workflow,
    event: "pull_request",
    headSha: input.pullRequest.headSha,
    branch: input.branch,
    createdAfter: reviewStartedAt,
    timeoutMs: input.config.reviewTimeoutMs,
    excludedRunIds: existingReviewRunIds,
    displayTitle: `${requirement.workflow.name} [labeled] PR #${input.pullRequest.number} @ ${input.pullRequest.headSha}`,
  });
  const reviewComment = await waitForReviewComment({
    config: input.config,
    provider: input.provider,
    prNumber: input.pullRequest.number,
    headSha: input.pullRequest.headSha,
  });
  input.state.commentIds.push(reviewComment.id);

  const correctionMarker = `LORE_GITHUB_${input.provider.toUpperCase()}_CORRECTION_${input.nonce}`;
  const correctionBody = [
    `/lore correct ${reviewComment.html_url}`,
    "",
    `Correction: for ${input.config.repository}, the exact durable documentation review convention is ${correctionMarker}: disposable live-acceptance documents are test evidence, not product behavior. Preserve this repository-specific convention.`,
  ].join("\n");
  const correctionHead = await branchHeadSha(
    input.config.repository,
    input.defaultBranch,
    input.config.commandTimeoutMs,
  );
  const existingCorrectionRunIds = actionRunIds(
    await listActionRuns({
      config: input.config,
      workflow: CORRECTION_WORKFLOW,
      event: "issue_comment",
    }),
    correctionHead,
  );
  const correctionStartedAt = new Date(Date.now() - 5_000).toISOString();
  const correctionComment = await ghJson<IssueComment>(
    [
      "api",
      "--method",
      "POST",
      `repos/${input.config.repository}/issues/${input.pullRequest.number}/comments`,
      "-f",
      `body=${correctionBody}`,
    ],
    input.config.commandTimeoutMs,
  );
  if (
    correctionComment.id === undefined ||
    correctionComment.created_at === undefined
  ) {
    throw new Error("GitHub did not return the created correction comment");
  }
  input.state.commentIds.push(correctionComment.id);
  const correctionRun = await waitForActionRun({
    config: input.config,
    workflow: CORRECTION_WORKFLOW,
    event: "issue_comment",
    headSha: correctionHead,
    createdAfter: correctionStartedAt,
    timeoutMs: input.config.correctionTimeoutMs,
    excludedRunIds: existingCorrectionRunIds,
    displayTitle: `${CORRECTION_WORKFLOW.name} comment #${correctionComment.id}`,
  });
  const lore = await verifyLoreCorrection({
    lore: input.lore,
    config: input.config,
    provider: input.provider,
    marker: correctionMarker,
    correctionCommentId: correctionComment.id,
    startedAt: correctionComment.created_at,
    cleanupLearningIds: input.cleanupLearningIds,
  });
  await removeLabel({
    config: input.config,
    prNumber: input.pullRequest.number,
    label: requirement.label,
  });
  input.state.labels = input.state.labels.filter(
    (label) => label !== requirement.label,
  );
  return {
    provider: input.provider,
    reviewRunUrl: reviewRun.url,
    reviewCommentUrl: reviewComment.html_url,
    correctionRunUrl: correctionRun.url,
    learningIds: lore.learningIds,
    receiptId: lore.receiptId,
  };
}

async function cleanupGithub(
  state: CleanupState,
  timeoutMs: number,
): Promise<string[]> {
  const errors: string[] = [];
  for (const command of buildCleanupCommands(state)) {
    try {
      await runCommand(command, timeoutMs);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors;
}

async function discoverCleanupLearnings(
  lore: LoreClient,
  markers: readonly string[],
  ids: Set<string>,
): Promise<void> {
  for (const marker of markers) {
    const result = await lore
      .listLearnings({ query: marker, status: "active", limit: 100 })
      .catch(() => undefined);
    result?.memories
      .filter((learning) => learning.content.includes(marker))
      .forEach((learning) => ids.add(learning.id));
  }
}

export async function main(): Promise<void> {
  if (process.env.RUN_GITHUB_PR_LIVE_TESTS !== "1") {
    throw new Error(
      "GitHub PR live acceptance is disabled. Set RUN_GITHUB_PR_LIVE_TESTS=1 to acknowledge real, potentially billable Codex/Devin reviews.",
    );
  }
  const config = parseConfiguration();
  const state: CleanupState = {
    repository: config.repository,
    labels: [],
    commentIds: [],
  };
  const cleanupLearningIds = new Set<string>();
  const correctionMarkers: string[] = [];
  const lore = new LoreClient({
    baseUrl: config.loreApiUrl,
    headers: { authorization: `Bearer ${config.loreWorkspaceToken}` },
  });
  let cleanupErrors: string[] = [];
  let output:
    | {
        ok: true;
        repository: string;
        baseBranch: string;
        pullRequest: string;
        headSha: string;
        cliRelease: string;
        providers: Awaited<ReturnType<typeof runProvider>>[];
      }
    | undefined;
  try {
    const checked = await preflight(config);
    const nonce = `${Date.now().toString(36)}${randomUUID().slice(0, 8)}`
      .replaceAll("-", "")
      .toUpperCase();
    correctionMarkers.push(
      ...config.providers.map(
        (provider) =>
          `LORE_GITHUB_${provider.toUpperCase()}_CORRECTION_${nonce}`,
      ),
    );
    const pullRequest = await createPullRequest({
      config,
      baseBranch: checked.baseBranch,
      nonce,
      state,
    });
    if (state.branch === undefined) {
      throw new Error("Acceptance branch state was not recorded");
    }
    const providers: Awaited<ReturnType<typeof runProvider>>[] = [];
    for (const provider of config.providers) {
      providers.push(
        await runProvider({
          lore,
          config,
          provider,
          pullRequest,
          branch: state.branch,
          defaultBranch: checked.defaultBranch,
          nonce,
          state,
          cleanupLearningIds,
        }),
      );
    }
    output = {
      ok: true,
      repository: config.repository,
      baseBranch: checked.baseBranch,
      pullRequest: pullRequest.url,
      headSha: pullRequest.headSha,
      cliRelease: `${config.cliRepository}@${config.cliVersion}`,
      providers,
    };
  } finally {
    await discoverCleanupLearnings(
      lore,
      correctionMarkers,
      cleanupLearningIds,
    );
    for (const learningId of cleanupLearningIds) {
      await lore.forgetLearning(learningId).catch((error: unknown) => {
        cleanupErrors.push(
          `Could not forget learning ${learningId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
    if (config.cleanup) {
      cleanupErrors = [
        ...cleanupErrors,
        ...(await cleanupGithub(state, config.commandTimeoutMs)),
      ];
    }
    if (cleanupErrors.length > 0) {
      process.stderr.write(
        `GitHub live acceptance cleanup warnings:\n${cleanupErrors.map((error) => `- ${error}`).join("\n")}\n`,
      );
    }
  }
  if (output !== undefined) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  }
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPath)).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `Error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
