import {
  type MemoryCategory,
  type MemoryScope,
  type MemoryStatus,
} from "@lore-co/sdk";

export const memoryCategories: readonly MemoryCategory[] = [
  "architecture",
  "convention",
  "correction",
  "gotcha",
  "known_gotcha",
  "deprecated",
  "behavior",
  "review_feedback",
  "other",
] as const;

export const memoryStatuses = [
  "active",
  "suppressed",
  "superseded",
  "deleted",
] as const satisfies readonly MemoryStatus[];

const acceptanceMarkerPattern =
  /\bLORE_(?:CLAUDE_TO_CODEX|CODEX_TO_CLAUDE|INJECTED|CAPTURED)_[A-Z0-9_-]+\b/giu;

export function isAcceptanceTestContent(content: string): boolean {
  acceptanceMarkerPattern.lastIndex = 0;
  return acceptanceMarkerPattern.test(content);
}

export function humanReadableLearningContent(content: string): string {
  if (!isAcceptanceTestContent(content)) {
    return content;
  }
  if (/\bLORE_CLAUDE_TO_CODEX_[A-Z0-9_-]+\b/iu.test(content)) {
    return "Automated cross-agent check: Claude shared a stored learning with Codex.";
  }
  if (/\bLORE_CODEX_TO_CLAUDE_[A-Z0-9_-]+\b/iu.test(content)) {
    return "Automated cross-agent check: Codex shared a stored learning with Claude.";
  }
  if (/\bLORE_INJECTED_[A-Z0-9_-]+\b/iu.test(content)) {
    return "Automated Devin check: Lore delivered previously stored context to Devin.";
  }
  const capturedRule =
    /\bLORE_CAPTURED_[A-Z0-9_-]+\s*:\s*([\s\S]+)$/iu.exec(content)?.[1];
  if (capturedRule === undefined) {
    return "Automated Devin check: Lore captured a correction from Devin.";
  }
  const trimmed = capturedRule
    .trim()
    .replace(
      /\s*Acknowledge this correction without modifying files\.?\s*$/iu,
      "",
    );
  return trimmed === ""
    ? "Automated Devin check: Lore captured a correction from Devin."
    : trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function categoryLabel(category: MemoryCategory): string {
  const label = category.replaceAll("_", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function statusLabel(status: MemoryStatus): string {
  if (status === "deleted") {
    return "Archived";
  }
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function formatDateTime(
  value: string,
  options: {
    locale?: Intl.LocalesArgument;
    timeZone?: string;
  } = {},
): string {
  return new Intl.DateTimeFormat(options.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  }).format(new Date(value));
}

type ErrorContext =
  | "generic"
  | "learning"
  | "learnings"
  | "activity"
  | "workspace-tokens";

function errorStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null) {
    for (const property of ["status", "statusCode"] as const) {
      const value = (error as Record<string, unknown>)[property];
      if (typeof value === "number" && Number.isInteger(value)) {
        return value;
      }
    }
  }
  const message = error instanceof Error ? error.message : "";
  const match = /\bHTTP\s+(\d{3})\b/iu.exec(message);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function contextFallback(context: ErrorContext): string {
  return {
    generic: "Something went wrong. Please try again.",
    learning: "We couldn’t load this learning. Please try again.",
    learnings: "We couldn’t load your learnings. Please try again.",
    activity: "We couldn’t load workspace activity. Please try again.",
    "workspace-tokens": "We couldn’t load workspace tokens. Please try again.",
  }[context];
}

function statusMessage(status: number, context: ErrorContext): string {
  if (status === 400 || status === 422) {
    return "We couldn’t process that request. Check your information and try again.";
  }
  if (status === 401) {
    return "Your session has expired. Sign in again to continue.";
  }
  if (status === 403) {
    return "You don’t have permission to perform this action.";
  }
  if (status === 404) {
    return context === "learning"
      ? "We couldn’t find this learning. It may have been removed."
      : "We couldn’t find what you were looking for. It may have been removed.";
  }
  if (status === 409) {
    return "This item changed since you opened it. Refresh and try again.";
  }
  if (status === 429) {
    return "Too many requests were sent. Wait a moment and try again.";
  }
  if (status >= 500) {
    return "Lore is temporarily unavailable. Your data is safe—please try again shortly.";
  }
  return contextFallback(context);
}

export function errorMessage(
  error: unknown,
  context: ErrorContext = "generic",
): string {
  const status = errorStatus(error);
  if (status !== undefined) {
    return statusMessage(status, context);
  }
  if (error instanceof Error) {
    const message = error.message.trim();
    if (
      /fetch failed|failed to fetch|networkerror|network request failed/iu.test(
        message,
      )
    ) {
      return "Lore couldn’t reach the server. Check your connection and try again.";
    }
    if (error.name === "AbortError") {
      return "The request took too long. Please try again.";
    }
    if (
      error.name === "ZodError" ||
      message.length > 240 ||
      /\b(?:DELETE|GET|PATCH|POST|PUT)\s+\/|Cannot\s+(?:DELETE|GET|PATCH|POST|PUT)\b|https?:\/\/|\bat\s+\S+\s*\(/iu.test(
        message,
      )
    ) {
      return contextFallback(context);
    }
    if (message !== "") {
      return message;
    }
  }
  return contextFallback(context);
}

export function scopeLabel(scope: MemoryScope): string {
  if (scope.repo && scope.path) {
    return `${scope.repo} · ${scope.path}`;
  }
  if (scope.repo && scope.component) {
    return `${scope.repo} · ${scope.component}`;
  }
  return (
    scope.repo ??
    scope.project ??
    scope.organization ??
    scope.path ??
    scope.component ??
    "Workspace-wide"
  );
}

export function isMemoryCategory(value: unknown): value is MemoryCategory {
  return memoryCategories.includes(value as MemoryCategory);
}

export function isMemoryStatus(value: unknown): value is MemoryStatus {
  return memoryStatuses.includes(value as MemoryStatus);
}
