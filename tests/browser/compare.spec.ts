/**
 * Compare route smoke: a shareable `/agents/compare?ids=` URL is rendered
 * server-side and fails closed.
 *
 * The smoke build has no database and no agent addresses, so no id resolves to
 * a directory agent. That is exactly the case this spec pins: unknown ids are
 * dropped server-side and the page still serves its own content — a 200 with
 * the real heading and empty-state copy, never a 500, a blank shell or a
 * leaked client exception.
 */

import { expect, test } from "@playwright/test";

import { expectMainLandmark, expectNoSecrets, trackPageErrors } from "./helpers";

const COMPARE_ROUTE = "/en/agents/compare?ids=ghost-alpha,ghost-beta";

test.describe("agents compare", () => {
  test("a shareable compare URL renders server-side", async ({ page }) => {
    const errors: string[] = [];
    trackPageErrors(page, errors);

    const response = await page.goto(COMPARE_ROUTE, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);

    // Server-side render: the content is in the HTML before any client JS runs.
    const html = await response!.text();
    expect(html).toContain("Compare agents");
    expectNoSecrets(html);

    await expectMainLandmark(page);
    await expect(page.getByRole("heading", { name: "Compare agents" }).first()).toBeVisible();

    // The window switcher is part of the shareable URL contract.
    await expect(page.getByRole("group", { name: "Time window" })).toBeVisible();

    // Unknown ids are reported, not rendered as ghost columns.
    await expect(page.getByText("No matching agents")).toBeVisible();
    await expect(page.getByText("not found in the directory")).toBeVisible();

    expect(errors).toEqual([]);
  });

  test("the compare URL without ids explains itself instead of erroring", async ({ page }) => {
    const errors: string[] = [];
    trackPageErrors(page, errors);

    const response = await page.goto("/en/agents/compare", { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    expectNoSecrets(await response!.text());

    await expectMainLandmark(page);
    await expect(page.getByRole("heading", { name: "Compare agents" }).first()).toBeVisible();
    await expect(page.getByText("No agents selected")).toBeVisible();

    expect(errors).toEqual([]);
  });
});
