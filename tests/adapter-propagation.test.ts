import { ClaudeAdapter } from "@lore-co/adapter-claude";
import { CodexAdapter } from "@lore-co/adapter-codex";
import { DevinAdapter } from "@lore-co/adapter-devin";
import { GenericAgentAdapter } from "@lore-co/adapter-generic";
import { describe, expect, it } from "vitest";
import { createEngineHarness, createEngineHttpBridge } from "./helpers.js";

describe("agent-independent propagation through adapter HTTP boundaries", () => {
  it("propagates a Claude teaching to a newly-created Codex review adapter", async () => {
    const { engine } = createEngineHarness();
    const bridge = createEngineHttpBridge(engine);
    const review = {
      repo: "payments",
      task: "Review the customer update",
      review: true,
      diff: "+ await stripe.customers.update(customerId, params)",
      symbols: ["stripe.customers.update"],
    };

    const before = await new CodexAdapter({
      baseUrl: "http://memory.test",
      fetch: bridge,
    }).prepareTask(review);
    expect(before.memories).toEqual([]);
    expect(before.prompt).not.toContain("BillingService");

    const observed = await new ClaudeAdapter({
      baseUrl: "http://memory.test",
      fetch: bridge,
    }).observe({
      repo: "payments",
      sessionId: "claude-development-session",
      messages: [
        {
          role: "human",
          id: "teaching-1",
          content:
            "Never call Stripe directly from API handlers. Use BillingService.",
        },
      ],
    });
    expect(observed.created).toBe(1);
    expect(observed.memories[0]?.source).toMatchObject({
      agent: "claude",
      sessionId: "claude-development-session",
      messageId: "teaching-1",
    });

    const after = await new CodexAdapter({
      baseUrl: "http://memory.test",
      fetch: bridge,
    }).prepareTask(review);
    expect(after.memories).toHaveLength(1);
    expect(after.memories[0]?.source.agent).toBe("claude");
    expect(after.task.agent).toBe("codex");
    expect(after.prompt).toContain(
      "API handlers must use BillingService instead of accessing Stripe directly.",
    );
  });

  it("propagates a Devin-session human correction to a newly-created Claude adapter", async () => {
    const { engine } = createEngineHarness();
    const bridge = createEngineHttpBridge(engine);
    const task = {
      repo: "accounts",
      task: "Implement account persistence",
      symbols: ["RepositoryFactory", "AccountStore"],
    };

    const before = await new ClaudeAdapter({
      baseUrl: "http://memory.test",
      fetch: bridge,
    }).prepareTask(task);
    expect(before.memories).toEqual([]);
    expect(before.prompt).not.toContain("AccountStore");

    const observed = await new DevinAdapter({
      baseUrl: "http://memory.test",
      fetch: bridge,
    }).observe({
      repo: "accounts",
      session_id: "devin-review-session",
      messages: [
        {
          type: "devin_message",
          message: "Use RepositoryFactory for account persistence.",
          messageId: "devin-review",
        },
        {
          type: "user_message",
          message:
            "No, RepositoryFactory is deprecated. Use AccountStore instead.",
          messageId: "human-correction",
        },
      ],
    });
    expect(observed.created).toBe(1);
    expect(observed.memories[0]).toMatchObject({
      category: "correction",
      content: "RepositoryFactory is deprecated. Use AccountStore instead.",
      source: {
        agent: "devin",
        sessionId: "devin-review-session",
        messageId: "human-correction",
        rawText:
          "No, RepositoryFactory is deprecated. Use AccountStore instead.",
      },
    });

    const after = await new ClaudeAdapter({
      baseUrl: "http://memory.test",
      fetch: bridge,
    }).prepareTask(task);
    expect(after.memories).toHaveLength(1);
    expect(after.memories[0]?.source.agent).toBe("devin");
    expect(after.task.agent).toBe("claude");
    expect(after.prompt).toContain(
      "RepositoryFactory is deprecated. Use AccountStore instead.",
    );
  });

  it("propagates an OpenCode teaching to a newly-created Claude adapter", async () => {
    const { engine } = createEngineHarness();
    const bridge = createEngineHttpBridge(engine);
    const task = {
      repo: "payments",
      task: "Update settlement retries",
      symbols: ["SettlementCoordinator"],
    };
    const openCode = new GenericAgentAdapter({
      id: "opencode",
      baseUrl: "http://memory.test",
      fetch: bridge,
    });

    const observed = await openCode.observe({
      repo: "payments",
      sessionId: "opencode-development-session",
      messages: [
        {
          role: "user",
          id: "opencode-teaching-1",
          content:
            "Always keep SettlementCoordinator retries idempotent.",
        },
      ],
    });
    expect(observed.created).toBe(1);
    expect(observed.memories[0]?.source).toMatchObject({
      agent: "opencode",
      sessionId: "opencode-development-session",
      messageId: "opencode-teaching-1",
    });

    const after = await new ClaudeAdapter({
      baseUrl: "http://memory.test",
      fetch: bridge,
    }).prepareTask(task);
    expect(after.memories).toHaveLength(1);
    expect(after.memories[0]?.source.agent).toBe("opencode");
    expect(after.task.agent).toBe("claude");
    expect(after.prompt).toContain(
      "SettlementCoordinator retries idempotent",
    );
  });
});
