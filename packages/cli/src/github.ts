import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  parseReviewOutput,
  type ReviewOutput,
} from "./review-output.js";
import { GITHUB_TEMPLATE_ASSETS } from "./generated-assets.js";
import { boundedUtf8Text } from "./repository.js";

type ReviewProvider = "codex" | "devin";

interface PullRequestEvent {
  repository?: {
    full_name?: string;
    owner?: { login?: string };
  };
  pull_request?: {
    number?: number;
    title?: string;
    body?: string | null;
    html_url?: string;
    draft?: boolean;
    base?: { sha?: string };
    head?: { sha?: string; repo?: { full_name?: string } };
  };
  issue?: { number?: number; pull_request?: unknown };
  comment?: {
    id?: number;
    body?: string;
    html_url?: string;
    user?: { login?: string };
    created_at?: string;
  };
  sender?: { login?: string };
}

export interface ReviewIdentity {
  provider: ReviewProvider;
  repository: string;
  prNumber: number;
  headSha: string;
}

interface ReviewMetadata extends ReviewIdentity {
  owner: string;
  repo: string;
  prUrl: string;
  marker: string;
  sessionId?: string;
  loreDelivery?: {
    eventId: string;
    receiptId: string;
    contextSha256: string;
    memoryIds: string[];
    deliveredAt: string;
  };
}

interface LoreConnection {
  apiUrl: string;
  token: string;
}

const TEMPLATE_FILES = [
  "lore-codex-review.yml",
  "lore-devin-review.yml",
  "lore-observe-correction.yml",
] as const;
const MAX_DIFF_BYTES = 512 * 1024;
const MAX_FILES = 500;
const MAX_COMMENT_LENGTH = 60_000;
const REVIEW_MARKER_V2 = "lore-review:v2";
const REVIEW_PROVENANCE_MARKER = "lore-review-provenance:v1";

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function parseProvider(value: string | undefined): ReviewProvider {
  if (value === "codex" || value === "devin") {
    return value;
  }
  throw new Error("--provider must be codex or devin");
}

function valueAfter(args: readonly string[], index: number): [string, number] {
  const value = args[index + 1];
  if (value === undefined) {
    throw new Error(`Missing value for ${args[index] ?? "option"}`);
  }
  return [value, index + 1];
}

function parseFlags(args: readonly string[]): Map<string, string[]> {
  const flags = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === undefined || !name.startsWith("--")) {
      throw new Error(`Unexpected argument: ${name ?? ""}`);
    }
    if (name === "--configure-secrets" || name === "--yes") {
      flags.set(name, ["true"]);
      continue;
    }
    const [value, valueIndex] = valueAfter(args, index);
    index = valueIndex;
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return flags;
}

async function readLoreConnection(): Promise<LoreConnection> {
  const envUrl = process.env.LORE_API_URL;
  const envToken = process.env.LORE_WORKSPACE_TOKEN ?? process.env.LORE_TOKEN;
  if (envUrl !== undefined && envToken !== undefined) {
    return {
      apiUrl: envUrl.replace(/\/+$/u, ""),
      token: envToken,
    };
  }
  const configPath = resolve(
    process.env.HOME ?? homedir(),
    ".lore",
    "config.json",
  );
  const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
    apiUrl?: unknown;
    token?: unknown;
  };
  if (typeof parsed.apiUrl !== "string" || typeof parsed.token !== "string") {
    throw new Error(`Invalid Lore connector config: ${configPath}`);
  }
  return {
    apiUrl: parsed.apiUrl.replace(/\/+$/u, ""),
    token: parsed.token,
  };
}

async function readEvent(path?: string): Promise<PullRequestEvent> {
  const eventPath = required(
    path ?? process.env.GITHUB_EVENT_PATH,
    "GitHub event path",
  );
  return JSON.parse(await readFile(eventPath, "utf8")) as PullRequestEvent;
}

function reviewMetadata(
  event: PullRequestEvent,
  provider: ReviewProvider,
): ReviewMetadata {
  const repository = required(event.repository?.full_name, "event repository");
  const pr = event.pull_request;
  if (
    pr?.number === undefined ||
    pr.html_url === undefined ||
    pr.head?.sha === undefined
  ) {
    throw new Error("The event does not contain a pull request");
  }
  if (pr.draft === true) {
    throw new Error("Draft pull requests are not reviewed");
  }
  if (
    pr.head.repo?.full_name !== undefined &&
    pr.head.repo.full_name !== repository
  ) {
    throw new Error("Fork pull requests are not eligible for secret-backed reviews");
  }
  const [owner, repo] = repository.split("/", 2);
  if (owner === undefined || repo === undefined) {
    throw new Error(`Invalid repository slug: ${repository}`);
  }
  const metadata = {
    provider,
    repository,
    owner,
    repo,
    prNumber: pr.number,
    prUrl: pr.html_url,
    headSha: pr.head.sha,
  };
  return { ...metadata, marker: reviewMarker(metadata) };
}

async function runProcess(
  command: string,
  args: readonly string[],
  cwd?: string,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
      } else {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed (${code ?? "signal"}): ${stderr.trim()}`,
          ),
        );
      }
    });
  });
}

async function gitReviewEvidence(
  checkout: string,
  baseSha: string,
  headSha: string,
): Promise<{ diff: string; files: string[] }> {
  const range = `${baseSha}...${headSha}`;
  const [rawDiff, rawFiles] = await Promise.all([
    runProcess("git", ["diff", "--no-ext-diff", "--unified=40", range], checkout),
    runProcess("git", ["diff", "--name-only", range], checkout),
  ]);
  const diff = boundedUtf8Text(
    rawDiff,
    MAX_DIFF_BYTES,
    "\n\n[diff truncated by Lore]",
  );
  return {
    diff,
    files: rawFiles
      .split("\n")
      .map((file) => file.trim())
      .filter(Boolean)
      .slice(0, MAX_FILES),
  };
}

async function fetchLoreContext(input: {
  metadata: ReviewMetadata;
  title: string;
  body: string;
  diff: string;
  files: string[];
}): Promise<{
  context: string;
  delivery: NonNullable<ReviewMetadata["loreDelivery"]>;
}> {
  const connection = await readLoreConnection();
  const eventId = reviewEventKey(input.metadata);
  const response = await fetch(`${connection.apiUrl}/v1/context/deliveries`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${connection.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      connector: `github-${input.metadata.provider}-review`,
      eventId,
      sessionId: `github:${input.metadata.repository}:pr:${input.metadata.prNumber}:${input.metadata.headSha}`,
      task: {
        agent: input.metadata.provider,
        organization: input.metadata.owner,
        repo: input.metadata.repository,
        task: `Review PR #${input.metadata.prNumber}: ${input.title}\n${input.body}`,
        diff: input.diff,
        files: input.files,
        limit: 8,
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Lore context request failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    context?: unknown;
    memories?: Array<{ id?: unknown }>;
    packing?: { contextSha256?: unknown };
    receipt?: { id?: unknown; deliveredAt?: unknown };
  };
  if (
    typeof body.context !== "string" ||
    typeof body.packing?.contextSha256 !== "string" ||
    typeof body.receipt?.id !== "string" ||
    typeof body.receipt.deliveredAt !== "string" ||
    !Array.isArray(body.memories)
  ) {
    throw new Error("Lore context delivery returned an invalid response");
  }
  return {
    context: body.context,
    delivery: {
      eventId,
      receiptId: body.receipt.id,
      contextSha256: body.packing.contextSha256,
      memoryIds: body.memories
        .map((memory) => memory.id)
        .filter((id): id is string => typeof id === "string"),
      deliveredAt: body.receipt.deliveredAt,
    },
  };
}

async function prepareReview(args: readonly string[]): Promise<void> {
  const flags = parseFlags(args);
  const provider = parseProvider(flags.get("--provider")?.[0]);
  const event = await readEvent(flags.get("--event")?.[0]);
  const metadata = reviewMetadata(event, provider);
  const checkout = resolve(required(flags.get("--checkout")?.[0], "--checkout"));
  const baseSha = required(event.pull_request?.base?.sha, "base SHA");
  const { diff, files } = await gitReviewEvidence(
    checkout,
    baseSha,
    metadata.headSha,
  );
  const lore = await fetchLoreContext({
    metadata,
    title: event.pull_request?.title ?? "",
    body: event.pull_request?.body ?? "",
    diff,
    files,
  });
  metadata.loreDelivery = lore.delivery;
  const prompt = [
    `Review ${metadata.prUrl} at exact head ${metadata.headSha}.`,
    "Only report consequential, actionable defects introduced by this pull request.",
    lore.context === ""
      ? ""
      : `\n<<< RELEVANT LORE ENGINEERING KNOWLEDGE >>>\n${lore.context}\n<<< END RELEVANT LORE ENGINEERING KNOWLEDGE >>>`,
    "\nReturn JSON matching the supplied review schema.",
  ]
    .filter(Boolean)
    .join("\n");
  const promptOut = resolve(required(flags.get("--prompt-out")?.[0], "--prompt-out"));
  const metadataOut = resolve(
    required(flags.get("--metadata-out")?.[0], "--metadata-out"),
  );
  await Promise.all([
    mkdir(dirname(promptOut), { recursive: true }),
    mkdir(dirname(metadataOut), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(promptOut, `${prompt}\n`, "utf8"),
    writeFile(metadataOut, `${JSON.stringify(metadata, null, 2)}\n`, "utf8"),
    ...(flags.get("--schema-out")?.[0] === undefined
      ? []
      : [
          (async () => {
            const schemaOut = resolve(flags.get("--schema-out")?.[0] ?? "");
            await mkdir(dirname(schemaOut), { recursive: true });
            await writeFile(
              schemaOut,
              GITHUB_TEMPLATE_ASSETS["review-output.schema.json"],
              "utf8",
            );
          })(),
        ]),
  ]);
}

async function githubRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = required(
    process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
    "GH_TOKEN",
  );
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${path} failed with HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function inlineCode(value: string, maxLength: number): string {
  const bounded = value
    .trim()
    .replace(/[\r\n]+/gu, " ")
    .slice(0, maxLength)
    .replaceAll("`", "'")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `\`${bounded}\``;
}

function boundedSessionId(metadata: ReviewMetadata): string | undefined {
  const value = metadata.sessionId?.trim();
  return value === undefined || value === "" || value.length > 128
    ? undefined
    : value;
}

function renderProvenance(metadata: ReviewMetadata): string {
  const sessionId = boundedSessionId(metadata);
  const hidden =
    sessionId === undefined
      ? ""
      : `\n<!-- ${REVIEW_PROVENANCE_MARKER} session=${encodeURIComponent(sessionId)} -->`;
  const visible = [
    `provider ${inlineCode(metadata.provider, 16)}`,
    `repository ${inlineCode(metadata.repository, 120)}`,
    `PR ${metadata.prNumber}`,
    `head ${inlineCode(metadata.headSha, 64)}`,
    ...(sessionId === undefined
      ? []
      : [`session ${inlineCode(sessionId, 128)}`]),
  ].join(" · ");
  return `${hidden}\n\n---\n<sub>Provenance: ${visible}</sub>`;
}

function renderReviewOutput(output: ReviewOutput): string {
  return [
    output.summary,
    ...output.findings.map((finding) => {
      const location =
        finding.path === null
          ? ""
          : ` (${inlineCode(finding.path, 500)}${finding.line === null ? "" : `:${finding.line}`})`;
      return `- **${finding.severity} — ${finding.title}**${location}\n  ${finding.body}`;
    }),
  ].join("\n\n");
}

function renderReview(metadata: ReviewMetadata, raw: string): string {
  const marker = reviewMarker(metadata);
  const prefix = `${marker}\n### Lore ${metadata.provider} review\n\n`;
  const suffix = renderProvenance(metadata);
  const rendered = renderReviewOutput(parseReviewOutput(raw));
  const truncationNotice = "\n\n[Review truncated by Lore]";
  const available = MAX_COMMENT_LENGTH - prefix.length - suffix.length;
  const body =
    rendered.length <= available
      ? rendered
      : `${rendered.slice(0, Math.max(0, available - truncationNotice.length))}${truncationNotice}`;
  return `${prefix}${body}${suffix}`;
}

interface GithubIssueComment {
  id: number;
  body?: string | null;
  user?: { login?: string };
}

async function findExistingReviewComment(
  metadata: ReviewMetadata,
  marker: string,
): Promise<GithubIssueComment | undefined> {
  for (let page = 1; ; page += 1) {
    const comments = await githubRequest<GithubIssueComment[]>(
      `/repos/${metadata.owner}/${metadata.repo}/issues/${metadata.prNumber}/comments?per_page=100&page=${page}`,
    );
    const existing = comments.find(
      (comment) =>
        comment.user?.login === "github-actions[bot]" &&
        comment.body?.includes(marker) === true,
    );
    if (existing !== undefined) {
      return existing;
    }
    if (comments.length < 100) {
      return undefined;
    }
  }
}

async function postReview(args: readonly string[]): Promise<void> {
  const flags = parseFlags(args);
  const metadata = JSON.parse(
    await readFile(
      resolve(required(flags.get("--metadata")?.[0], "--metadata")),
      "utf8",
    ),
  ) as ReviewMetadata;
  const raw = await readFile(
    resolve(required(flags.get("--output")?.[0], "--output")),
    "utf8",
  );
  const marker = reviewMarker(metadata);
  const body = renderReview(metadata, raw);
  const existing = await findExistingReviewComment(metadata, marker);
  if (existing === undefined) {
    await githubRequest(
      `/repos/${metadata.owner}/${metadata.repo}/issues/${metadata.prNumber}/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );
  } else {
    await githubRequest(
      `/repos/${metadata.owner}/${metadata.repo}/issues/comments/${existing.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );
  }
}

function commentIdFromUrl(url: string): number {
  const match = /#issuecomment-(\d+)$/u.exec(url);
  if (match?.[1] === undefined) {
    throw new Error("Correction must reference a GitHub issue-comment URL");
  }
  return Number(match[1]);
}

interface ParsedReviewMarker {
  provider: ReviewProvider;
  prNumber: number;
  headSha: string;
  sessionId?: string;
}

function provenanceSessionId(body: string): string | undefined {
  const encoded =
    /<!-- lore-review-provenance:v1 session=(\S+) -->/u.exec(body)?.[1];
  if (encoded === undefined) {
    return undefined;
  }
  try {
    const decoded = decodeURIComponent(encoded);
    return decoded !== "" && decoded.length <= 128 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function parseReviewMarker(
  body: string,
  repository: string,
): ParsedReviewMarker | undefined {
  const v2 =
    /<!-- lore-review:v2 key=([a-f0-9]{64}) provider=(codex|devin) head=(\S+) pr=(\d+) -->/u.exec(
      body,
    );
  if (
    v2?.[1] !== undefined &&
    v2[2] !== undefined &&
    v2[3] !== undefined &&
    v2[4] !== undefined
  ) {
    let headSha: string;
    try {
      headSha = decodeURIComponent(v2[3]);
    } catch {
      return undefined;
    }
    const provider = v2[2] as ReviewProvider;
    const prNumber = Number(v2[4]);
    if (
      Number.isSafeInteger(prNumber) &&
      reviewEventKey({ provider, repository, prNumber, headSha }) === v2[1]
    ) {
      const sessionId = provenanceSessionId(body);
      return {
        provider,
        prNumber,
        headSha,
        ...(sessionId === undefined ? {} : { sessionId }),
      };
    }
    return undefined;
  }

  const v1 =
    /<!-- lore-review:v1 provider=(codex|devin)(?: session=(\S+))? head=(\S+) pr=(\d+) -->/u.exec(
      body,
    );
  if (v1?.[1] === undefined || v1[3] === undefined || v1[4] === undefined) {
    return undefined;
  }
  return {
    provider: v1[1] as ReviewProvider,
    prNumber: Number(v1[4]),
    headSha: v1[3],
    ...(v1[2] === undefined ? {} : { sessionId: v1[2] }),
  };
}

async function observeCorrection(args: readonly string[]): Promise<void> {
  const flags = parseFlags(args);
  const event = await readEvent(flags.get("--event")?.[0]);
  const repository = required(event.repository?.full_name, "event repository");
  const [owner, repo] = repository.split("/", 2);
  const body = required(event.comment?.body, "comment body");
  const match = /^\/lore\s+correct\s+(\S+)\s*\n+([\s\S]+)$/u.exec(body);
  if (
    owner === undefined ||
    repo === undefined ||
    match?.[1] === undefined ||
    match[2] === undefined ||
    event.comment?.id === undefined ||
    event.issue?.number === undefined
  ) {
    throw new Error(
      "Use `/lore correct <bot-comment-url>` followed by the correction",
    );
  }
  const sender = required(event.sender?.login, "event sender");
  const permission = await githubRequest<{ permission?: string }>(
    `/repos/${owner}/${repo}/collaborators/${encodeURIComponent(sender)}/permission`,
  );
  if (!["write", "maintain", "admin"].includes(permission.permission ?? "")) {
    throw new Error("The commenter does not have permission to teach Lore");
  }
  const targetId = commentIdFromUrl(match[1]);
  const target = await githubRequest<{
    id: number;
    body?: string | null;
    user?: { login?: string };
  }>(`/repos/${owner}/${repo}/issues/comments/${targetId}`);
  const marker = parseReviewMarker(target.body ?? "", repository);
  if (
    target.user?.login !== "github-actions[bot]" ||
    marker === undefined ||
    marker.prNumber !== event.issue.number
  ) {
    throw new Error("The referenced comment is not a Lore review on this PR");
  }
  const connection = await readLoreConnection();
  const eventId = `github:issue_comment:${repository}:${event.comment.id}`;
  const response = await fetch(`${connection.apiUrl}/v1/turns`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${connection.token}`,
      "content-type": "application/json",
      "idempotency-key": eventId,
    },
    body: JSON.stringify({
      connector: "github",
      eventId,
      agent: marker.provider,
      sessionId:
        marker.sessionId ?? `github:${repository}:pull:${event.issue.number}`,
      previousAssistant: {
        id: `github-comment:${target.id}`,
        content: (target.body ?? "").replace(/<!--[\s\S]*?-->/gu, "").trim(),
      },
      currentUser: {
        id: `github-comment:${event.comment.id}`,
        content: match[2].trim(),
        ...(event.comment.created_at === undefined
          ? {}
          : { timestamp: event.comment.created_at }),
      },
      occurredAt: event.comment.created_at ?? new Date().toISOString(),
      scope: { repo: repository },
      learningScope: {},
      metadata: {
        prNumber: event.issue.number,
        headSha: marker.headSha,
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).trim().slice(0, 1_000);
    throw new Error(
      `Lore correction failed with HTTP ${response.status}${
        detail === "" ? "" : `: ${detail}`
      }`,
    );
  }
}

async function writeGhSecret(
  repo: string,
  name: string,
  value: string,
  variable = false,
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const args = variable
      ? ["variable", "set", name, "--repo", repo, "--body", value]
      : ["secret", "set", name, "--repo", repo];
    const child = spawn(
      "gh",
      args,
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`gh failed to set ${name}: ${stderr.trim()}`));
      }
    });
    child.stdin.end(variable ? undefined : value);
  });
}

export async function connectGithub(args: readonly string[]): Promise<void> {
  const flags = parseFlags(args);
  const root = resolve(flags.get("--repo-root")?.[0] ?? process.cwd());
  const repository =
    flags.get("--repo")?.[0] ?? process.env.GITHUB_REPOSITORY;
  const workflowRoot = resolve(root, ".github", "workflows");
  const loreRoot = resolve(root, ".github", "lore");
  await Promise.all([
    mkdir(workflowRoot, { recursive: true }),
    mkdir(loreRoot, { recursive: true }),
  ]);
  await Promise.all([
    ...TEMPLATE_FILES.map((file) =>
      writeFile(resolve(workflowRoot, file), GITHUB_TEMPLATE_ASSETS[file], "utf8"),
    ),
    writeFile(
      resolve(loreRoot, "review-output.schema.json"),
      GITHUB_TEMPLATE_ASSETS["review-output.schema.json"],
      "utf8",
    ),
  ]);
  if (flags.has("--configure-secrets")) {
    const repo = required(repository, "--repo");
    const connection = await readLoreConnection();
    await writeGhSecret(repo, "LORE_WORKSPACE_TOKEN", connection.token);
    await writeGhSecret(repo, "LORE_API_URL", connection.apiUrl, true);
    const openAiKey = process.env.OPENAI_API_KEY;
    const devinKey = process.env.DEVIN_API_KEY;
    const devinOrg = process.env.DEVIN_ORG_ID;
    if (openAiKey !== undefined) {
      await writeGhSecret(repo, "OPENAI_API_KEY", openAiKey);
    }
    if (devinKey !== undefined) {
      await writeGhSecret(repo, "DEVIN_API_KEY", devinKey);
    }
    if (devinOrg !== undefined) {
      await writeGhSecret(repo, "DEVIN_ORG_ID", devinOrg, true);
    }
  }
  process.stdout.write(
    `GitHub workflows installed in ${resolve(root, ".github")}.\nSet LORE_WORKSPACE_TOKEN and vendor credentials before enabling review labels.\n`,
  );
}

export async function runGithubCommand(args: readonly string[]): Promise<void> {
  const command = args[0];
  switch (command) {
    case "prepare-review":
      await prepareReview(args.slice(1));
      return;
    case "post-review":
      await postReview(args.slice(1));
      return;
    case "observe-correction":
      await observeCorrection(args.slice(1));
      return;
    default:
      throw new Error(
        `Unknown github command: ${command ?? ""}. Use prepare-review, post-review, or observe-correction.`,
      );
  }
}

export function reviewEventKey(metadata: ReviewIdentity): string {
  return createHash("sha256")
    .update(
      `${metadata.provider}\0${metadata.repository}\0${metadata.prNumber}\0${metadata.headSha}`,
    )
    .digest("hex");
}

export function reviewMarker(metadata: ReviewIdentity): string {
  return `<!-- ${REVIEW_MARKER_V2} key=${reviewEventKey(metadata)} provider=${metadata.provider} head=${encodeURIComponent(metadata.headSha)} pr=${metadata.prNumber} -->`;
}
