import { createError, defineEventHandler } from "h3";
import { resetE2eFixture } from "~/server/utils/e2e-fixture";

export default defineEventHandler(() => {
  if (process.env.NUXT_E2E_FIXTURE !== "1") {
    throw createError({ statusCode: 404, statusMessage: "Not found" });
  }
  resetE2eFixture();
  return { reset: true };
});
