export const REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings"],
  properties: {
    summary: { type: "string", minLength: 1, pattern: "\\S" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "title", "body", "path", "line"],
        properties: {
          severity: { enum: ["critical", "high", "medium", "low"] },
          title: { type: "string", minLength: 1, pattern: "\\S" },
          body: { type: "string", minLength: 1, pattern: "\\S" },
          path: {
            type: ["string", "null"],
            minLength: 1,
            pattern: "\\S",
          },
          line: { type: ["integer", "null"], minimum: 1 },
        },
      },
    },
  },
} as const;

export type ReviewSeverity = "critical" | "high" | "medium" | "low";

export interface ReviewFinding {
  severity: ReviewSeverity;
  title: string;
  body: string;
  path: string | null;
  line: number | null;
}

export interface ReviewOutput {
  summary: string;
  findings: ReviewFinding[];
}

const REVIEW_SEVERITIES = new Set<ReviewSeverity>([
  "critical",
  "high",
  "medium",
  "low",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function invalid(detail: string): never {
  throw new Error(`Review output does not match the required schema: ${detail}`);
}

export function validateReviewOutput(value: unknown): ReviewOutput {
  if (!isRecord(value) || !hasExactlyKeys(value, ["summary", "findings"])) {
    invalid("expected only summary and findings");
  }
  if (!nonBlankString(value.summary)) {
    invalid("summary must be a non-blank string");
  }
  if (!Array.isArray(value.findings)) {
    invalid("findings must be an array");
  }

  const findings = value.findings.map((finding, index): ReviewFinding => {
    if (
      !isRecord(finding) ||
      !hasExactlyKeys(finding, [
        "severity",
        "title",
        "body",
        "path",
        "line",
      ])
    ) {
      invalid(`findings[${index}] has missing or additional properties`);
    }
    if (
      typeof finding.severity !== "string" ||
      !REVIEW_SEVERITIES.has(finding.severity as ReviewSeverity)
    ) {
      invalid(`findings[${index}].severity is invalid`);
    }
    if (!nonBlankString(finding.title)) {
      invalid(`findings[${index}].title must be a non-blank string`);
    }
    if (!nonBlankString(finding.body)) {
      invalid(`findings[${index}].body must be a non-blank string`);
    }
    if (
      finding.path !== null &&
      !nonBlankString(finding.path)
    ) {
      invalid(`findings[${index}].path must be null or a non-blank string`);
    }
    if (
      finding.line !== null &&
      (typeof finding.line !== "number" ||
        !Number.isInteger(finding.line) ||
        finding.line < 1)
    ) {
      invalid(`findings[${index}].line must be null or a positive integer`);
    }
    return {
      severity: finding.severity as ReviewSeverity,
      title: finding.title,
      body: finding.body,
      path: finding.path,
      line: finding.line,
    };
  });

  return { summary: value.summary, findings };
}

export function parseReviewOutput(raw: string): ReviewOutput {
  if (raw.trim() === "") {
    throw new Error("Review output is blank");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Review output must be valid JSON");
  }
  return validateReviewOutput(parsed);
}
