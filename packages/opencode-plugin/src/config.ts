import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const DEFAULT_TIMEOUT_MS = 2_000;
export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 5_000;
export const MAX_RESPONSE_BYTES = 512 * 1_024;
export const MAX_CONFIG_BYTES = 64 * 1_024;

const MAX_URL_BYTES = 2_048;
const MAX_TOKEN_BYTES = 8_192;

export type LoreEnvironment = Readonly<Record<string, string | undefined>>;

export interface LoreCredentials {
  apiUrl: string;
  token: string;
}

export interface ResolveLoreCredentialsOptions {
  env?: LoreEnvironment;
  home?: string;
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function nonEmptyBounded(
  value: unknown,
  field: string,
  maxBytes: number,
): string {
  if (typeof value !== "string") {
    throw new Error(`${field} is required`);
  }
  const normalized = value.trim();
  if (normalized === "" || utf8Length(normalized) > maxBytes) {
    throw new Error(`${field} has an invalid size`);
  }
  return normalized;
}

function normalizeApiUrl(value: unknown): string {
  const normalized = nonEmptyBounded(value, "Lore API URL", MAX_URL_BYTES);
  const parsed = new URL(normalized);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("Lore API URL is not a supported base URL");
  }
  return normalized.replace(/\/+$/u, "");
}

function environmentToken(env: LoreEnvironment): string | undefined {
  for (const value of [env.LORE_WORKSPACE_TOKEN, env.LORE_TOKEN]) {
    if (value !== undefined && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
}

export async function resolveLoreCredentials(
  options: ResolveLoreCredentialsOptions = {},
): Promise<LoreCredentials> {
  const env = options.env ?? process.env;
  const environmentUrl = env.LORE_API_URL;
  const token = environmentToken(env);
  if (environmentUrl !== undefined || token !== undefined) {
    if (environmentUrl === undefined || environmentUrl.trim() === "") {
      throw new Error("LORE_API_URL is required with a Lore token");
    }
    if (token === undefined) {
      throw new Error(
        "LORE_WORKSPACE_TOKEN or LORE_TOKEN is required with LORE_API_URL",
      );
    }
    return {
      apiUrl: normalizeApiUrl(environmentUrl),
      token: nonEmptyBounded(token, "Lore workspace token", MAX_TOKEN_BYTES),
    };
  }

  const home = options.home ?? env.HOME ?? homedir();
  const configPath = resolve(home, ".lore", "config.json");
  const metadata = await stat(configPath);
  if (!metadata.isFile() || metadata.size > MAX_CONFIG_BYTES) {
    throw new Error("Lore connector config has an invalid size");
  }
  const rawConfig = await readFile(configPath, "utf8");
  if (utf8Length(rawConfig) > MAX_CONFIG_BYTES) {
    throw new Error("Lore connector config has an invalid size");
  }
  const parsed = JSON.parse(rawConfig) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Lore connector config is invalid");
  }
  const config = parsed as Record<string, unknown>;
  return {
    apiUrl: normalizeApiUrl(config.apiUrl),
    token: nonEmptyBounded(
      config.token,
      "Lore workspace token",
      MAX_TOKEN_BYTES,
    ),
  };
}

export function boundedTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(value)));
}

export async function withTimeout<T>(
  timeoutMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Lore integration request timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function readBoundedResponse(
  response: Response,
  signal: AbortSignal,
): Promise<Response> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > MAX_RESPONSE_BYTES
  ) {
    await response.body?.cancel();
    throw new Error("Lore response is too large");
  }
  if (response.body === null) {
    return response;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Lore response is too large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }

  const body =
    bytes === 0
      ? null
      : Buffer.concat(
          chunks.map((chunk) =>
            Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
          ),
          bytes,
        );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function createBoundedFetch(
  fetchImplementation: typeof globalThis.fetch,
  timeoutMs: number,
): typeof globalThis.fetch {
  return (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const controller = new AbortController();
    const upstreamSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const abortFromUpstream = (): void => {
      controller.abort(upstreamSignal?.reason);
    };
    if (upstreamSignal?.aborted === true) {
      abortFromUpstream();
    } else {
      upstreamSignal?.addEventListener("abort", abortFromUpstream, {
        once: true,
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error("Lore request timed out");
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      });
      const request = (async (): Promise<Response> => {
        const response = await fetchImplementation(input, {
          ...init,
          signal: controller.signal,
        });
        return await readBoundedResponse(response, controller.signal);
      })();
      return await Promise.race([request, timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      upstreamSignal?.removeEventListener("abort", abortFromUpstream);
    }
  }) as typeof globalThis.fetch;
}
