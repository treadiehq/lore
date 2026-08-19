import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export interface RunCommittedMigrationsOptions {
  databaseUrl?: string;
  migrationsFolder?: string;
}

export function committedMigrationsFolder(
  moduleUrl = import.meta.url,
): string {
  return fileURLToPath(new URL("../drizzle", moduleUrl));
}

export async function runCommittedMigrations(
  options: RunCommittedMigrationsOptions = {},
): Promise<void> {
  const databaseUrl =
    options.databaseUrl === undefined
      ? process.env.DATABASE_URL?.trim()
      : options.databaseUrl.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("DATABASE_URL is required to run database migrations");
  }

  const client = postgres(databaseUrl, { max: 1 });
  try {
    await migrate(drizzle(client), {
      migrationsFolder:
        options.migrationsFolder ?? committedMigrationsFolder(),
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}
