import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

export function boundedUtf8Text(
  value: string,
  maximumBytes: number,
  truncationNotice = "",
): string {
  const bytes = Buffer.from(value, "utf8");
  return bytes.byteLength <= maximumBytes
    ? value
    : `${bytes.subarray(0, maximumBytes).toString("utf8")}${truncationNotice}`;
}

export function canonicalRepositoryScope(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, "");
  if (trimmed === "") {
    throw new Error("Repository scope cannot be empty");
  }
  const scp = /^[^@\s]+@[^:\s]+:(.+)$/u.exec(trimmed);
  const candidate = scp?.[1] ?? trimmed;
  try {
    const url = new URL(candidate);
    if (url.hostname.toLowerCase() === "github.com") {
      const path = url.pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
      const parts = path.split("/").filter(Boolean);
      if (parts.length >= 2) {
        return `${parts[0]}/${parts[1]}`;
      }
    }
  } catch {
    // SCP-style URLs and owner/repository values are handled below.
  }
  const normalized = candidate
    .replace(/^https?:\/\/github\.com\//iu, "")
    .replace(/^ssh:\/\/git@github\.com\//iu, "")
    .replace(/^git:\/\/github\.com\//iu, "")
    .replace(/^\/+|\/+$/gu, "")
    .replace(/\.git$/u, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length >= 2
    ? `${parts.at(-2)}/${parts.at(-1)}`
    : normalized;
}

function originUrl(config: string): string | undefined {
  const sections = config.split(/^\s*\[/gmu);
  for (const section of sections) {
    if (!/^remote\s+"origin"\]/u.test(section.trimStart())) {
      continue;
    }
    const match = /^\s*url\s*=\s*(.+?)\s*$/mu.exec(section);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return undefined;
}

export async function repositoryScopeFromGitRoot(
  root: string,
): Promise<string> {
  try {
    const config = await readFile(resolve(root, ".git", "config"), "utf8");
    const remote = originUrl(config);
    if (remote !== undefined) {
      return canonicalRepositoryScope(remote);
    }
  } catch {
    // Worktrees and repositories without an origin use the directory fallback.
  }
  return basename(root);
}
