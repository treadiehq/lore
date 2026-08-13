import { describe, expect, it } from "vitest";
import { errorMessage } from "../apps/web/utils/memory.js";

describe("web error messages", () => {
  it("normalizes API errors without relying on class identity", () => {
    expect(
      errorMessage(
        {
          status: 404,
          message:
            "GET /api/lore/v1/learnings/example/inspection failed with HTTP 404",
        },
        "learning",
      ),
    ).toBe("We couldn’t find this learning. It may have been removed.");
  });

  it("extracts HTTP status from wrapped error messages", () => {
    expect(
      errorMessage(
        new Error(
          "GET /api/lore/v1/activity failed with HTTP 400: Cannot GET /v1/activity",
        ),
        "activity",
      ),
    ).toBe(
      "We couldn’t process that request. Check your information and try again.",
    );
  });

  it("does not expose unknown technical request details", () => {
    expect(
      errorMessage(
        new Error("Cannot GET /v1/learnings/example/inspection"),
        "learning",
      ),
    ).toBe("We couldn’t load this learning. Please try again.");
  });

  it("preserves concise local validation messages", () => {
    expect(errorMessage(new Error("To date must be after the from date."))).toBe(
      "To date must be after the from date.",
    );
  });
});
