import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  committedMigrationsFolder,
  runCommittedMigrations,
} from "../src/migrations.js";

interface MigrationJournal {
  entries: Array<{ tag: string }>;
}

describe("committed database migrations", () => {
  it("resolves every journal entry to a committed SQL file", async () => {
    const folder = committedMigrationsFolder();
    const journal = JSON.parse(
      await readFile(join(folder, "meta", "_journal.json"), "utf8"),
    ) as MigrationJournal;

    expect(journal.entries.length).toBeGreaterThan(0);
    await Promise.all(
      journal.entries.map(({ tag }) => access(join(folder, `${tag}.sql`))),
    );
  });

  it("requires an explicit production database URL", async () => {
    await expect(
      runCommittedMigrations({ databaseUrl: " " }),
    ).rejects.toThrow("DATABASE_URL is required");
  });
});
