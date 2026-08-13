import { describe, expect, it } from "vitest";
import {
  claudeSessionToInteraction,
  claudeTaskToSharedTask,
} from "../src/index.js";

describe("Claude scope propagation", () => {
  it("retains path and component on observations and tasks", () => {
    expect(
      claudeSessionToInteraction({
        messages: [],
        path: "src/api",
        component: "api",
      }),
    ).toMatchObject({ path: "src/api", component: "api" });
    expect(
      claudeTaskToSharedTask({
        task: "Check the API",
        path: "src/api",
        component: "api",
      }),
    ).toMatchObject({ path: "src/api", component: "api" });
  });
});
