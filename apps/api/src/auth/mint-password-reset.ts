#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { AuthEmailSchema } from "@lore-co/core";
import {
  closeDatabase,
  createDatabase,
  hashAuthToken,
  PostgresAuthRepository,
} from "@lore-co/database";
import { apiDeploymentConfig } from "../common/deployment-config.js";
import { createOpaqueAuthToken } from "./auth.service.js";

interface Arguments {
  email: string;
  output?: string;
}

function usage(): string {
  return [
    "Usage: lore-reset-password --email <owner-email> [--output <file>]",
    "",
    "Mints a short-lived, one-use local-owner password reset link.",
    "Without --output, the secret link is written once to stdout.",
    "",
    "Examples:",
    "  lore-reset-password --email owner@example.com",
    "  lore-reset-password --email owner@example.com --output /tmp/lore-reset.txt",
  ].join("\n");
}

function parseArguments(argv: readonly string[]): Arguments {
  let email: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (argument === "--email") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--email requires a value. Run with --help.");
      }
      email = value;
      index += 1;
      continue;
    }
    if (argument === "--output") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--output requires a value. Run with --help.");
      }
      output = value;
      index += 1;
      continue;
    }
    throw new Error("Unknown or incomplete argument. Run with --help.");
  }
  if (email === undefined) {
    throw new Error("Owner email is required. Run with --help.");
  }
  return {
    email: AuthEmailSchema.parse(email),
    ...(output === undefined ? {} : { output }),
  };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const config = apiDeploymentConfig();
  if (config.auth.mode !== "local_owner") {
    throw new Error("Password recovery requires AUTH_MODE=local_owner.");
  }
  if (config.databaseUrl === null) {
    throw new Error("DATABASE_URL is required for password recovery.");
  }
  if (config.workspaceBootstrap === null) {
    throw new Error("Workspace bootstrap is required for password recovery.");
  }

  const connection = createDatabase(config.databaseUrl);
  try {
    const repository = new PostgresAuthRepository(connection);
    const token = createOpaqueAuthToken();
    const issued = await repository.issuePasswordReset({
      id: randomUUID(),
      email: args.email,
      organization: config.workspaceBootstrap.organization,
      tokenHash: hashAuthToken(token),
      expiresAt: new Date(Date.now() + config.auth.passwordResetTtlMs),
    });
    if (!issued) {
      throw new Error("Active owner account not found.");
    }
    const resetUrl = new URL("/auth/reset", config.auth.webOrigin);
    resetUrl.hash = new URLSearchParams({ token }).toString();
    const secretLink = `${resetUrl.toString()}\n`;
    if (args.output === undefined) {
      process.stdout.write(secretLink);
      return;
    }
    await writeFile(args.output, secretLink, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    process.stdout.write(`Password reset link written to ${args.output}.\n`);
  } finally {
    await closeDatabase(connection);
  }
}

try {
  await main();
} catch (error) {
  const message =
    error instanceof Error ? error.message : "Password reset command failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
