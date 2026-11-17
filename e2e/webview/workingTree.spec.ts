import { expect, type Page, test } from "@playwright/test";

import { harnessPage } from "./harness";

// The working tree panel of the desktop entry (#403), in a real browser: the
// right-hand column ADR-0031 lays out, beside the graph rather than over it.
// The host's half is played here, by posting its messages to the page as the
// desktop preload does.

const harnessUrl = harnessPage("desktop");
/** WORKING_TREE_WIDTH in packages/webview/src/desktop/workingTree/workingTreePanel.ts. */
const WIDTH = 320;

async function hostSays(page: Page, data: unknown) {
  await page.evaluate((message) => {
    globalThis.dispatchEvent(new MessageEvent("message", { data: message }));
  }, data);
}

const STRINGS = {
  title: "Changes",
  close: "Close",
  message: "Commit message",
  commit: "Commit",
  staged: "Staged Changes",
  unstaged: "Changes",
  conflicted: "Merge Conflicts",
  stage: "Stage",
  stageAll: "Stage All",
  unstage: "Unstage",
  unstageAll: "Unstage All",
  clean: "No changes.",
  changes: {
    added: "Added",
    modified: "Modified",
    deleted: "Deleted",
    renamed: "Renamed",
    copied: "Copied",
    typeChanged: "Type changed",
    untracked: "Untracked",
    conflicted: "Conflicted"
  }
};

const LONG = "a-file-name-long-enough-to-run-well-past-the-width-of-the-panel-it-is-listed-in.ts";

let errors: string[];

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(harnessUrl);
  await expect(page.locator("#commitTable tr.commit")).toHaveCount(3);
  await hostSays(page, { command: "workingTreeShow" });
  await hostSays(page, {
    command: "workingTreeStatus",
    request: "workingTreeLoad",
    status: {
      branch: "main",
      staged: [{ path: "src/staged.ts", change: "modified" }],
      unstaged: [{ path: `deep/folder/${LONG}`, change: "untracked" }],
      conflicted: []
    },
    error: null,
    strings: STRINGS
  });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test("the panel is a column on the right, as tall as the window, and the graph gives up its width", async ({
  page
}) => {
  const viewport = page.viewportSize()!;
  const panel = await page.locator("#workingTree").boundingBox();
  expect(panel).toEqual({ x: viewport.width - WIDTH, y: 0, width: WIDTH, height: viewport.height });

  // The graph ends where the panel starts.
  const table = await page.locator("#commitTable").boundingBox();
  expect(table!.x + table!.width).toBeLessThanOrEqual(viewport.width - WIDTH);
  const controls = await page.locator("#controls").boundingBox();
  expect(controls!.x + controls!.width).toBeLessThanOrEqual(viewport.width - WIDTH);
});

test("the find widget opens beside the panel, not under it", async ({ page }) => {
  await page.keyboard.press("Control+f");
  await expect(page.locator("#findWidget")).toBeVisible();
  const find = await page.locator("#findWidget").boundingBox();
  expect(find!.x + find!.width).toBeLessThanOrEqual(page.viewportSize()!.width - WIDTH);
});

test("a long name is cut short, and its row's button stays in the panel", async ({ page }) => {
  const row = page.locator('.wtFile[data-area="unstaged"]');
  await row.hover();
  const stage = row.getByRole("button", { name: "Stage" });
  await expect(stage).toBeVisible();
  const panel = (await page.locator("#workingTree").boundingBox())!;
  const button = (await stage.boundingBox())!;
  expect(button.x + button.width).toBeLessThanOrEqual(panel.x + panel.width);
  expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test("closed, it hands the width back to the graph", async ({ page }) => {
  await page.locator("#workingTree").getByRole("button", { name: "Close" }).click();

  await expect(page.locator("#workingTree")).toBeHidden();
  const table = await page.locator("#commitTable").boundingBox();
  expect(table!.x + table!.width).toBeGreaterThan(page.viewportSize()!.width - WIDTH);
});
