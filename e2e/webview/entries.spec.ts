import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "@playwright/test";

const ROOT = path.resolve(__dirname, "../..");

/** Builds the harness page for one webview entry through the script's own
 *  command line, and returns the page's file:// URL. */
function harnessPage(entry: string): string {
  execFileSync(process.execPath, [
    path.join(ROOT, "scripts", "webview-harness.js"),
    `--entry=${entry}`
  ]);
  return pathToFileURL(path.join(ROOT, "out", "webview-harness", entry, "index.html")).href;
}

// Each webview entry, loaded by the harness, draws the harness's sample commits
// from its canned host answers. The desktop entry is told apart by the marker it
// writes on <html>, which the VS Code entry must not carry (ADR-0031).
const ENTRIES = [
  { entry: "vscode", marker: null },
  { entry: "desktop", marker: "ging-desktop-entry" }
];

for (const { entry, marker } of ENTRIES) {
  test(`the ${entry} entry draws the sample commits`, async ({ page }) => {
    // The harness's own guard reports an empty table on the console; any other
    // error there is a failure the rows alone would not show.
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto(harnessPage(entry));

    await expect(page.locator("#commitTable tr.commit")).toHaveCount(3);
    await expect(page.locator("#commitTable tr.commit").first()).toContainText(
      "Add the login feature"
    );
    expect(await page.locator("html").getAttribute("data-ging-entry")).toBe(marker);
    expect(errors).toEqual([]);
  });
}
