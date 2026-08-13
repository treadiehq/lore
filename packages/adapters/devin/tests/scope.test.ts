import { describe, expect, it } from "vitest";
import {
  devinSessionToInteraction,
  devinTaskToSharedTask,
} from "../src/index.js";

describe("Devin scope propagation", () => {
  it("retains path and component on observations and tasks", () => {
    expect(
      devinSessionToInteraction({
        messages: [],
        path: "services/review",
        component: "review",
      }),
    ).toMatchObject({ path: "services/review", component: "review" });
    expect(
      devinTaskToSharedTask({
        task: "Review the service",
        path: "services/review",
        component: "review",
      }),
    ).toMatchObject({ path: "services/review", component: "review" });
  });
});
