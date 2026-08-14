export type RedactionKind =
  | "private_key"
  | "authorization"
  | "connection_url"
  | "jwt"
  | "provider_token"
  | "credential";

export interface RedactionFinding {
  kind: RedactionKind;
  count: number;
}

export interface RedactionResult {
  text: string;
  redacted: boolean;
  findings: RedactionFinding[];
}

interface RedactionRule {
  kind: RedactionKind;
  pattern: RegExp;
  replacement: string | ((substring: string, ...groups: string[]) => string);
}

const RULES: readonly RedactionRule[] = [
  {
    kind: "private_key",
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gu,
    replacement: "[REDACTED:PRIVATE_KEY]",
  },
  {
    kind: "authorization",
    pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu,
    replacement: (_match, scheme) => `${scheme} [REDACTED:AUTHORIZATION]`,
  },
  {
    kind: "connection_url",
    pattern:
      /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s/@]+:)[^@\s/]+@/giu,
    replacement: (_match, prefix) => `${prefix}[REDACTED:PASSWORD]@`,
  },
  {
    kind: "jwt",
    pattern:
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
    replacement: "[REDACTED:JWT]",
  },
  {
    kind: "provider_token",
    pattern:
      /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/gu,
    replacement: "[REDACTED:API_KEY]",
  },
  {
    kind: "credential",
    pattern:
      /\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret)\b(\s*[:=]\s*)(["']?)([^\s,"'};]{8,})\3/giu,
    replacement: (_match, name, separator, quote) =>
      `${name}${separator}${quote}[REDACTED:CREDENTIAL]${quote}`,
  },
];

const SENSITIVE_KEY_PATTERN =
  /^(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)$/iu;

export function redactSensitiveText(value: string): RedactionResult {
  let text = value;
  const findings: RedactionFinding[] = [];

  for (const rule of RULES) {
    let count = 0;
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      count += 1;
      if (typeof rule.replacement === "string") {
        return rule.replacement;
      }
      const [match, ...rest] = args;
      return rule.replacement(
        String(match),
        ...rest.filter((value): value is string => typeof value === "string"),
      );
    });
    if (count > 0) {
      findings.push({ kind: rule.kind, count });
    }
  }

  return {
    text,
    redacted: findings.length > 0,
    findings,
  };
}

export function redactUnknown(value: unknown): {
  value: unknown;
  redacted: boolean;
  findings: RedactionFinding[];
} {
  const findings = new Map<RedactionKind, number>();
  const seen = new WeakSet<object>();

  const visit = (current: unknown): unknown => {
    if (typeof current === "string") {
      const result = redactSensitiveText(current);
      for (const finding of result.findings) {
        findings.set(
          finding.kind,
          (findings.get(finding.kind) ?? 0) + finding.count,
        );
      }
      return result.text;
    }
    if (current === null || typeof current !== "object") {
      return current;
    }
    if (seen.has(current)) {
      return "[REDACTED:CIRCULAR]";
    }
    seen.add(current);
    if (Array.isArray(current)) {
      return current.map(visit);
    }
    return Object.fromEntries(
      Object.entries(current).map(([key, entry]) => {
        if (
          SENSITIVE_KEY_PATTERN.test(key) &&
          entry !== null &&
          entry !== undefined
        ) {
          findings.set("credential", (findings.get("credential") ?? 0) + 1);
          return [key, "[REDACTED:CREDENTIAL]"];
        }
        return [key, visit(entry)];
      }),
    );
  };

  const redactedValue = visit(value);
  return {
    value: redactedValue,
    redacted: findings.size > 0,
    findings: [...findings.entries()].map(([kind, count]) => ({ kind, count })),
  };
}
