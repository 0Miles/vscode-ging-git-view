import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { desktopPage, pageErrors, posted, ROOT } from "./harness";

// The desktop entry's settings page (#397), built by the harness from the
// schema the desktop app ships (built once by globalSetup.ts): a row per
// setting, markdown links between them, and an `updateSetting` for each
// change. The host's half is the harness's: it answers every update as saved.

type SchemaSetting = { key: string; description: { en: string }; descriptionFormat: string };
/** The settings the desktop app has: the extension's, less the excluded ones. */
const SCHEMA = (
  JSON.parse(
    readFileSync(path.join(ROOT, "apps/desktop/src/settings/schema.generated.json"), "utf8")
  ) as { settings: SchemaSetting[] }
).settings;

/** The row of a setting, by its key: the row's id. */
const row = (page: Page, key: string) => page.locator(`[id="${key}"]`);

let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = pageErrors(page);
  await page.goto(desktopPage("settings"));
});
test.afterEach(() => expect(errors).toEqual([]));

test("the settings page lists every setting in the schema", async ({ page }) => {
  await expect(page.locator("html")).toHaveAttribute("data-ging-entry", "ging-desktop-entry");
  // One row per setting, in the schema's order, each with the key as its id.
  const rows = page.locator(".settingRow");
  await expect(rows).toHaveCount(SCHEMA.length);
  expect(await rows.evaluateAll((els) => els.map((el) => el.id))).toEqual(SCHEMA.map((s) => s.key));

  // Each `#key#` in a markdown description became a link to that setting's
  // row — deriveSchema wrote it as `](#key)` — and nothing else did.
  const links = SCHEMA.flatMap(({ key, description }) =>
    [...description.en.matchAll(/\]\(#([^)]+)\)/g)].map((m) => ({
      from: key,
      to: m[1],
      landsOnRow: true
    }))
  );
  expect(links.length).toBeGreaterThan(0);
  expect(
    await rows.evaluateAll((els) =>
      els.flatMap((el) =>
        Array.from(el.querySelectorAll(".settingDescription a[href^='#']")).map((a) => {
          const to = decodeURIComponent(a.getAttribute("href")!.slice(1));
          return {
            from: el.id,
            to,
            landsOnRow:
              el.ownerDocument.getElementById(to)?.classList.contains("settingRow") === true
          };
        })
      )
    )
  ).toEqual(links);

  // Following one lands on its row.
  const { from, to } = links[0];
  await row(page, from).locator(`a[href="#${to}"]`).click();
  expect(decodeURIComponent(new URL(page.url()).hash)).toBe(`#${to}`);
  expect(await row(page, to).evaluate((el) => el.matches(":target"))).toBe(true);
  await expect(row(page, to)).toBeInViewport();
});

test("the settings page sends an update for each change", async ({ page }) => {
  const sent = () => posted(page, "updateSetting");

  // An enum, a number and a boolean, each changed once.
  await row(page, "ging-git-view.dates.format")
    .locator("select")
    .selectOption({ label: "Relative" });
  const count = row(page, "ging-git-view.history.loadMoreCount").locator("input");
  await count.fill("250");
  await count.press("Tab");
  await row(page, "ging-git-view.show.tags").locator("input[type=checkbox]").uncheck();

  await expect.poll(sent).toEqual([
    { command: "updateSetting", key: "ging-git-view.dates.format", value: "Relative" },
    { command: "updateSetting", key: "ging-git-view.history.loadMoreCount", value: 250 },
    { command: "updateSetting", key: "ging-git-view.show.tags", value: false }
  ]);
  // The host answered each as saved: no row says otherwise.
  await expect(page.locator(".settingError:visible")).toHaveCount(0);
});
