import { describe, expect, it } from "vitest";
import { FixedWindowRateLimiter } from "../src/common/fixed-window-rate-limiter.js";

describe("FixedWindowRateLimiter", () => {
  it("enforces the limit and resets after the window", () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter({
      limit: 2,
      windowMs: 60_000,
      maxKeys: 10,
      now: () => now,
    });

    expect(limiter.allow("token-a")).toBe(true);
    expect(limiter.allow("token-a")).toBe(true);
    expect(limiter.allow("token-a")).toBe(false);

    now = 60_000;
    expect(limiter.allow("token-a")).toBe(true);
    expect(limiter.size).toBe(1);
  });

  it("removes expired entries before adding a new key at capacity", () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 60_000,
      maxKeys: 2,
      now: () => now,
    });

    expect(limiter.allow("token-a")).toBe(true);
    expect(limiter.allow("token-b")).toBe(true);
    expect(limiter.size).toBe(2);

    now = 60_000;
    expect(limiter.allow("token-c")).toBe(true);
    expect(limiter.size).toBe(1);
  });

  it("evicts the oldest entry when all windows are active", () => {
    const limiter = new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 60_000,
      maxKeys: 2,
      now: () => 0,
    });

    expect(limiter.allow("token-a")).toBe(true);
    expect(limiter.allow("token-b")).toBe(true);
    expect(limiter.allow("token-c")).toBe(true);
    expect(limiter.size).toBe(2);

    expect(limiter.allow("token-a")).toBe(true);
    expect(limiter.size).toBe(2);
  });
});
