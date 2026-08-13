import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  outputDir: "output/playwright/artifacts",
  reporter: [
    ["list"],
    ["html", { outputFolder: "output/playwright/report", open: "never" }],
    ["junit", { outputFile: "output/playwright/results.xml" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  expect: {
    timeout: 10_000,
  },
  webServer: {
    command:
      "NUXT_E2E_FIXTURE=1 NUXT_AUTH_COOKIE_SECURE=false pnpm --dir apps/web exec nuxt build && NUXT_E2E_FIXTURE=1 NUXT_AUTH_COOKIE_SECURE=false pnpm --dir apps/web exec nuxt preview --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173/health",
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      NUXT_E2E_FIXTURE: "1",
      NUXT_AUTH_COOKIE_SECURE: "false",
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
