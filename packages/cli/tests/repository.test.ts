import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalRepositoryScope,
  repositoryScopeFromGitRoot,
} from "../src/repository.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("canonical repository scope", () => {
  it.each([
    ["git@github.com:Acme/payments.git", "Acme/payments"],
    ["https://github.com/Acme/payments.git", "Acme/payments"],
    ["ssh://git@github.com/Acme/payments.git", "Acme/payments"],
    ["Acme/payments", "Acme/payments"],
  ])("normalizes %s", (input, expected) => {
    expect(canonicalRepositoryScope(input)).toBe(expected);
  });

  it("reads the origin from git config", async () => {
    const root = await mkdtemp(resolve(process.cwd(), ".tmp-repository-"));
    directories.push(root);
    await mkdir(resolve(root, ".git"));
    await writeFile(
      resolve(root, ".git", "config"),
      [
        "[core]",
        "\trepositoryformatversion = 0",
        '[remote "origin"]',
        "\turl = git@github.com:acme/accounts.git",
      ].join("\n"),
    );

    await expect(repositoryScopeFromGitRoot(root)).resolves.toBe(
      "acme/accounts",
    );
  });
});
