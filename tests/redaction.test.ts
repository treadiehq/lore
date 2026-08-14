import { redactSensitiveText, redactUnknown } from "@lore-co/core";
import { describe, expect, it } from "vitest";

describe("redaction", () => {
  it("redacts credentials embedded in text", () => {
    const result = redactSensitiveText(
      "Use password=super-secret-value for the local fixture.",
    );

    expect(result.text).toBe(
      "Use password=[REDACTED:CREDENTIAL] for the local fixture.",
    );
    expect(result.redacted).toBe(true);
  });

  it("redacts values under sensitive object keys", () => {
    const result = redactUnknown({
      apiKey: "generic-value-that-does-not-match-a-provider-prefix",
      nested: {
        token: "another-generic-secret-value",
        tokenId: "non-secret-actor-id",
      },
    });

    expect(result.value).toEqual({
      apiKey: "[REDACTED:CREDENTIAL]",
      nested: {
        token: "[REDACTED:CREDENTIAL]",
        tokenId: "non-secret-actor-id",
      },
    });
    expect(result.redacted).toBe(true);
  });
});
