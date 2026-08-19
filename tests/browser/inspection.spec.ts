import { expect, test } from "@playwright/test";

const currentLearningId = "00000000-0000-4000-8000-000000000002";
const replacementLearningId = "00000000-0000-4000-8000-000000000003";
const proposalLearningId = "00000000-0000-4000-8000-000000000004";

test.beforeEach(async ({ context, request }) => {
  const response = await request.post("/api/e2e/reset");
  expect(response.ok()).toBe(true);
  await context.addCookies([
    {
      name: "lore_session",
      value: "e2e-fixture-session",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: false,
    },
  ]);
});

test("redirects authenticated users away from login and signup", async ({
  page,
}) => {
  await page.goto("/login");
  await expect(page).toHaveURL(/\/activity$/u);

  await page.goto("/signup");
  await expect(page).toHaveURL(/\/activity$/u);
});

test("signs in with a local owner password", async ({ context, page }) => {
  await context.clearCookies();
  await page.goto("/login");

  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page).toHaveURL(/\/activity$/u);
  await expect(page.getByText("owner@example.com").first()).toBeVisible();
});

test("claims the first owner without persisting the bootstrap token", async ({
  context,
  page,
}) => {
  await context.clearCookies();
  const token = "b".repeat(64);
  await page.goto("/setup");
  expect(page.url()).not.toContain(token);

  await page.getByLabel("Owner email").fill("owner@example.com");
  await page.getByLabel("Owner password").fill("correct horse battery staple");
  await page
    .getByLabel("Confirm password")
    .fill("correct horse battery staple");
  await page.getByLabel("Bootstrap token").fill(token);
  await page
    .getByRole("button", { name: "Create owner account" })
    .click();

  await expect(page).toHaveURL(/\/activity$/u);
  expect(page.url()).not.toContain(token);
  await expect
    .poll(() =>
      page.evaluate((secret) => {
        return (
          Object.values(localStorage).includes(secret) ||
          Object.values(sessionStorage).includes(secret)
        );
      }, token),
    )
    .toBe(false);
});

test("consumes a reset token from a fragment and removes it immediately", async ({
  context,
  page,
}) => {
  await context.clearCookies();
  const token = "r".repeat(43);
  await page.goto(`/auth/reset#token=${token}`);
  await expect.poll(() => page.url()).not.toContain(token);

  await page.locator("#reset-password").fill("replacement password value");
  await page
    .getByLabel("Confirm new password")
    .fill("replacement password value");
  await page.getByRole("button", { name: "Update password" }).click();

  await expect(page).toHaveURL(/\/activity$/u);
});

test("updates workspace learning governance settings", async ({ page }) => {
  await page.goto("/settings");

  await page.getByLabel("Proposal only").check();
  await page.getByRole("button", { name: "Save settings" }).click();

  await expect(page.getByText("Workspace learning policy updated.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Proposal only")).toBeChecked();
});

test("reviews proposal evidence and promotes scope before activation", async ({
  page,
}) => {
  await page.goto(`/memories/${proposalLearningId}`);

  await expect(
    page.getByRole("heading", { name: "Conflict evidence" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", {
      name: "Use AccountStore for account writes.",
    }).first(),
  ).toBeVisible();
  await page.getByLabel("Promote organization-wide").check();
  await page
    .getByLabel("Review reason")
    .fill("This correction applies across all repositories.");
  await page.getByRole("button", { name: "Use proposal" }).click();

  await expect(page.getByText("The proposal is now active.")).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Use BillingAccountStore for account writes.",
    }),
  ).toBeVisible();
  await expect(page.getByText("Review proposal")).toHaveCount(0);
  await expect(page.getByText("Active", { exact: true }).first()).toBeVisible();
});

test("filters learnings by exact URL-backed scope and resets paging", async ({
  page,
}) => {
  await page.goto("/memories?page=2");

  await page.getByText("Advanced filters", { exact: true }).click();
  await page.getByLabel("Project").fill("Commerce");
  await page.getByLabel("Repository").fill("acme/accounts");
  await page.getByLabel("Path").fill("src/accounts");
  await page.getByLabel("Component").fill("billing");
  await page.getByRole("button", { name: "Apply" }).click();

  await expect
    .poll(() => {
      const url = new URL(page.url());
      return {
        pathname: url.pathname,
        page: url.searchParams.get("page"),
        project: url.searchParams.get("project"),
        repo: url.searchParams.get("repo"),
        path: url.searchParams.get("path"),
        component: url.searchParams.get("component"),
      };
    })
    .toEqual({
      pathname: "/memories",
      page: null,
      project: "Commerce",
      repo: "acme/accounts",
      path: "src/accounts",
      component: "billing",
    });
  await expect(
    page.getByRole("link", {
      name: "Use AccountStore for account writes.",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", {
      name: "Use LedgerStore for ledger writes.",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Remove repo filter acme\/accounts/u }),
  ).toBeVisible();
  await expect(
    page.getByText("Scope values must match stored learnings exactly."),
  ).toBeVisible();
});

test("creates a linked correction and displays complete inspection lineage", async ({
  page,
}) => {
  await page.goto(`/memories/${currentLearningId}`);

  await expect(page.getByText("Provenance records")).toBeVisible();
  await expect(page.getByText("lore-cli · observation")).toBeVisible();
  await page
    .getByRole("button", { name: "That was wrong", exact: true })
    .click();
  await page
    .getByLabel("Corrected statement")
    .fill("Use BillingAccountStore for account writes.");
  await page.getByLabel("Component").fill("payments");
  await page
    .getByLabel(/Keep the current learning as read-only history/u)
    .check();
  await page.getByRole("button", { name: "Save correction" }).click();

  await expect(page).toHaveURL(
    new RegExp(`/memories/${replacementLearningId}$`, "u"),
  );
  await expect(
    page.getByRole("heading", {
      name: "Use BillingAccountStore for account writes.",
    }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.getByText("Replaced an earlier learning")).toBeVisible();
  await page
    .getByRole("link", { name: "Use AccountStore for account writes." })
    .click();

  await expect(page).toHaveURL(
    new RegExp(`/memories/${currentLearningId}$`, "u"),
  );
  await expect(page.getByText("Provenance records")).toBeVisible();
  await expect(page.getByText("lore-cli · observation")).toBeVisible();
  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.getByText("Replaced by a newer learning")).toBeVisible();
  await expect(
    page.getByRole("link", {
      name: "Use BillingAccountStore for account writes.",
    }),
  ).toBeVisible();
});

test("filters and paginates event-aware activity", async ({ page }) => {
  await page.goto("/activity");

  const delivery = page
    .locator("article")
    .filter({ hasText: "Context delivery" })
    .first();
  await expect(delivery).toContainText("Context delivery request");
  await expect(delivery).not.toContainText("Human correction");

  await page.getByLabel("Event type").selectOption("observation");
  await page.getByLabel("Agent").fill("codex");
  await page.getByRole("textbox", { name: "Connector" }).fill("lore-cli");
  await page.getByLabel("From", { exact: true }).fill("2026-08-12T00:00");
  await page.getByLabel("To", { exact: true }).fill("2026-08-14T00:00");
  await page.getByRole("button", { name: "Apply", exact: true }).click();

  await expect(page).toHaveURL(/type=observation/u);
  await expect(page).toHaveURL(/agent=codex/u);
  await expect(page).toHaveURL(/connector=lore-cli/u);
  await expect(page).toHaveURL(/from=/u);
  await expect(page).toHaveURL(/to=/u);
  await expect(page.getByText("Observed user message").first()).toBeVisible();
  await expect(page.getByText("Human correction")).toHaveCount(0);

  await page.getByRole("button", { name: "Reset" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page).toHaveURL(/\/activity\?page=2$/u);
  await expect(page.getByText("Page 2 of 3")).toBeVisible();
  await expect(page.getByRole("button", { name: "Previous" })).toBeEnabled();
});
