#!/usr/bin/env node

import { runCommittedMigrations } from "./migrations.js";

try {
  await runCommittedMigrations();
  process.stdout.write("Database migrations completed.\n");
} catch (error) {
  const message =
    error instanceof Error ? error.message : "Unknown database migration error";
  process.stderr.write(`Database migration failed: ${message}\n`);
  process.exitCode = 1;
}
