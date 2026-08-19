import { execFile } from "node:child_process";
import { basename, resolve } from "node:path";

const REPOSITORY_LOOKUP_TIMEOUT_MS = 1_000;

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

export async function repositoryScopeFromWorktree(
  worktree: string,
): Promise<string> {
  const root = resolve(worktree);
  try {
    const remote = await new Promise<string>((resolveRemote, reject) => {
      execFile(
        "git",
        ["-C", root, "config", "--get", "remote.origin.url"],
        {
          encoding: "utf8",
          timeout: REPOSITORY_LOOKUP_TIMEOUT_MS,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error !== null) {
            reject(error);
            return;
          }
          resolveRemote(stdout);
        },
      );
    });
    return canonicalRepositoryScope(remote);
  } catch {
    return basename(root);
  }
}
