import { expect, test } from "@playwright/test";

import { harnessPage, hostSays, pageErrors, sideViewWidth } from "./harness";

// The file history panel of the desktop entry (#408), in a real browser: a
// column over the left of the graph's area, beside the side views (#399),
// that the diff viewer (#404) opens to the right of. The host's half is played
// here, by posting its messages to the page as the desktop preload does.

/** FILE_HISTORY_WIDTH in packages/webview/src/desktop/fileHistory/fileHistoryPanel.ts. */
const WIDTH = 340;

const STRINGS = {
  menuItem: "View File History",
  title: "History of {0}",
  upTo: "up to {0}",
  close: "Close File History",
  loadMore: "Load More",
  empty: "No commit changed this file.",
  renamedFrom: "Renamed from {0}",
  copiedFrom: "Copied from {0}",
  asPath: "As {0}",
  added: "Added",
  deleted: "Deleted",
  merge: "Merge",
  submodule: "Submodule {0} → {1}"
};

const LONG = "a-subject-long-enough-to-run-well-past-the-width-of-the-column-it-is-listed-in";

const entry = (n: number, subject: string) => ({
  hash: String(n).repeat(40),
  parents: [String(n + 1).repeat(40)],
  author: "Alice",
  authorEmail: "alice@example.com",
  date: 1_700_000_000,
  subject,
  change: "M",
  path: `deep/folder/${LONG}.ts`,
  oldPath: `deep/folder/${LONG}.ts`,
  submodule: null
});

const HISTORY = {
  command: "fileHistory",
  path: `deep/folder/${LONG}.ts`,
  request: null,
  start: "f".repeat(40),
  first: true,
  entries: [entry(1, LONG), entry(2, "short")],
  more: true,
  error: null,
  strings: STRINGS
};

let errors: string[];

test.beforeEach(async ({ page }) => {
  errors = pageErrors(page);
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.goto(harnessPage("desktop"));
  await expect(page.locator("#commitTable tr.commit")).toHaveCount(3);
  await hostSays(page, HISTORY);
  await expect(page.locator("#fileHistory")).toBeVisible();
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test("the panel is a column as tall as the window, at the graph's left edge past the side views", async ({
  page
}) => {
  const left = await sideViewWidth(page);
  expect(await page.locator("#fileHistory").boundingBox()).toEqual({
    x: left,
    y: 0,
    width: WIDTH,
    height: 700
  });
  // Over the graph, which stays where it was beneath it.
  expect(
    await page.evaluate(() => globalThis.getComputedStyle(globalThis.document.body).paddingLeft)
  ).toBe(`${left}px`);
});

test("long subjects and paths are cut short in the column, and the close and Load More buttons stay in it", async ({
  page
}) => {
  const column = (await page.locator("#fileHistory").boundingBox())!;
  const inside = async (selector: string) => {
    const box = (await page.locator(selector).first().boundingBox())!;
    expect(box.x, selector).toBeGreaterThanOrEqual(column.x);
    expect(box.x + box.width, selector).toBeLessThanOrEqual(column.x + column.width);
  };
  await Promise.all(
    [".fhTitle", ".fhPath", ".fhClose", ".fhEntry .fhSubject", ".fhMore"].map((selector) =>
      inside(`#fileHistory ${selector}`)
    )
  );
  const subject = page.locator("#fileHistory .fhEntry .fhSubject").first();
  expect(await subject.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
});

test("the diff viewer opens to the panel's right, and takes the graph's area again once it closes", async ({
  page
}) => {
  const left = await sideViewWidth(page);
  // A diff with no text to compare: the real viewer, drawn without an editor,
  // which the harness has none of (Monaco is the app's, #404).
  await hostSays(page, {
    command: "showDiff",
    title: "file.txt (1111111^ ↔ 1111111)",
    original: { path: "file.txt", content: "" },
    modified: { path: "file.txt", content: "" },
    revealLine: null,
    notShown: "Binary file: there is no text to compare.",
    strings: { sideBySide: "Side by Side", inline: "Inline", close: "Close Diff", cannotShow: "x" }
  });
  const viewer = page.locator("#diffViewer");
  await expect(viewer).toBeVisible();
  const box = async () => {
    const { x, width } = (await viewer.boundingBox())!;
    return { left: x, right: x + width };
  };

  expect(await box()).toEqual({ left: left + WIDTH, right: 1200 });

  await page.locator("#fileHistory .fhClose").click();
  await expect(page.locator("#fileHistory")).toBeHidden();
  expect(await box()).toEqual({ left, right: 1200 });
});
