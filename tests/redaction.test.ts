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

  it("redacts credentials with quoted JSON keys", () => {
    const content =
      'Use this config: {"password": "super-secret-value", "client_secret": "another-secret-value"}';
    const result = redactSensitiveText(content);

    expect(result.text).toBe(
      'Use this config: {"password": "[REDACTED:CREDENTIAL]", "client_secret": "[REDACTED:CREDENTIAL]"}',
    );
    expect(result.redacted).toBe(true);
    expect(result.findings).toEqual([{ kind: "credential", count: 2 }]);

    expect(redactUnknown({ currentUser: { content } })).toMatchObject({
      value: {
        currentUser: {
          content:
            'Use this config: {"password": "[REDACTED:CREDENTIAL]", "client_secret": "[REDACTED:CREDENTIAL]"}',
        },
      },
      redacted: true,
    });
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
