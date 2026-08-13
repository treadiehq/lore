import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

function source(path: string): string {
  return fileURLToPath(new URL(path, import.meta.url));
}

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@lore-co\/core\/schemas$/,
        replacement: source("./packages/core/src/schemas.ts"),
      },
      {
        find: /^@lore-co\/core$/,
        replacement: source("./packages/core/src/index.ts"),
      },
      {
        find: /^@lore-co\/extractor$/,
        replacement: source("./packages/extractor/src/index.ts"),
      },
      {
        find: /^@lore-co\/retrieval$/,
        replacement: source("./packages/retrieval/src/index.ts"),
      },
      {
        find: /^@lore-co\/database$/,
        replacement: source("./packages/database/src/index.ts"),
      },
      {
        find: /^@lore-co\/sdk$/,
        replacement: source("./packages/sdk/src/index.ts"),
      },
      {
        find: /^@lore-co\/adapter-generic$/,
        replacement: source("./packages/adapters/generic/src/index.ts"),
      },
      {
        find: /^@lore-co\/adapter-claude$/,
        replacement: source("./packages/adapters/claude/src/index.ts"),
      },
      {
        find: /^@lore-co\/adapter-codex$/,
        replacement: source("./packages/adapters/codex/src/index.ts"),
      },
      {
        find: /^@lore-co\/adapter-devin$/,
        replacement: source("./packages/adapters/devin/src/index.ts"),
      },
    ],
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
