import { expect, test } from "@playwright/test";

import { ENTRIES, harnessPage } from "./harness";

// The harness's graph page carries the markup both hosts send (#442), so the
// elements the hand-copied page once lacked are there to drive. That its body
// is buildWebviewMarkup's, verbatim, is held by
// packages/webview/tests/harnessMarkup.test.ts.
const SENT_BY_THE_HOSTS = [
  "#repoDropdown",
  '#repoDropdownList[role="listbox"][tabindex="-1"]',
  '#repoSettingsBtn[role="button"]',
  '#repoSettingsDrawer[role="dialog"]',
  '#commitTable[tabindex="-1"]',
  '#footer[tabindex="-1"]',
  "#findInput[placeholder]",
  '#dialog[tabindex="-1"]'
];

for (const entry of ENTRIES) {
  test(`the ${entry} harness page has the elements the hosts send`, async ({ page }) => {
    await page.goto(harnessPage(entry));

    await Promise.all(
      SENT_BY_THE_HOSTS.map((selector) => expect(page.locator(selector), selector).toHaveCount(1))
    );
    // The branch sits beside the repository dropdown, not inside its title.
    await expect(page.locator("#repoTitleBranch")).toHaveCount(1);
    await expect(page.locator("#repoTitle #repoTitleBranch")).toHaveCount(0);
    expect(await page.locator("#commitTable tr.commit").count()).toBeGreaterThan(0);
  });
}
