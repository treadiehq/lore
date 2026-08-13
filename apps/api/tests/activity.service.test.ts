import { describe, expect, it, vi } from "vitest";
import type { PostgresPilotRepository } from "@lore-co/database";
import { ActivityService } from "../src/activity/activity.service.js";

describe("ActivityService", () => {
  it("passes tenant-scoped filters and paging to the repository", async () => {
    const listActivity = vi.fn(async () => ({
      activities: [],
      total: 0,
      limit: 10,
      offset: 20,
      hasMore: false,
    }));
    const service = new ActivityService({
      listActivity,
    } as unknown as PostgresPilotRepository);

    await service.list("workspace-1", {
      type: "context_delivery",
      agent: "claude",
      connector: "lore-cli",
      from: "2026-08-13T10:00:00.000Z",
      to: "2026-08-13T12:00:00.000Z",
      limit: 10,
      offset: 20,
    });

    expect(listActivity).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      type: "context_delivery",
      agent: "claude",
      connector: "lore-cli",
      from: "2026-08-13T10:00:00.000Z",
      to: "2026-08-13T12:00:00.000Z",
      limit: 10,
      offset: 20,
    });
  });
});
