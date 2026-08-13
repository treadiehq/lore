import { describe, expect, it } from "vitest";
import {
  codexObservationToInteraction,
  codexTaskToSharedTask,
} from "../src/index.js";

describe("Codex scope propagation", () => {
  it("retains path and component on observations and tasks", () => {
    expect(
      codexObservationToInteraction({
        messages: [],
        path: "packages/cli",
        component: "connector",
      }),
    ).toMatchObject({
      path: "packages/cli",
      component: "connector",
    });
    expect(
      codexTaskToSharedTask({
        task: "Check the connector",
        path: "packages/cli",
        component: "connector",
      }),
    ).toMatchObject({
      path: "packages/cli",
      component: "connector",
    });
  });
});
