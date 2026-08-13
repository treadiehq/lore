import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("learning API contract", () => {
  it("exposes learning-first routes while preserving memory compatibility", async () => {
    const source = await readFile(
      new URL("../apps/api/src/memory/memory.controller.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain(
      '@Controller(["v1/learnings", "v1/memories"])',
    );
  });

  it("exposes the authenticated auditable observation route", async () => {
    const source = await readFile(
      new URL(
        "../apps/api/src/interaction/interaction.controller.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).toContain('@Controller("v1/observations")');
  });
});
