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
  },
  amend: "Amend last commit",
  amendCommit: "Amend Commit",
  signOff: "Sign off",
  signOffDetail: "Add a Signed-off-by line.",
  cannotAmend: {
    unborn: "No commit yet.",
    merge: "A merge is in progress.",
    rebase: "A rebase is in progress.",
    cherrypick: "A cherry-pick is in progress.",
    revert: "A revert is in progress."
  },
  amendPushed: "The last commit is already on {0}. Amend it anyway?",
  amendPushedConfirm: "Amend",
  identityUnknown: "Git does not know who you are."
};

const LONG = "a-file-name-long-enough-to-run-well-past-the-width-of-the-panel-it-is-listed-in.ts";

const HEAD_MESSAGE = "The last commit";
const STATUS = {
  branch: "main",
  staged: [{ path: "src/staged.ts", change: "modified" }],
  unstaged: [{ path: `deep/folder/${LONG}`, change: "untracked" }],
  conflicted: []
};

/** The host's answer to `request`, as the desktop host sends it. */
const answer = (request: string, more: Record<string, unknown> = {}) => ({
  command: "workingTreeStatus",
  request,
  status: STATUS,
  amend: { possible: true, message: HEAD_MESSAGE },
  error: null,
  strings: STRINGS,
  ...more
});

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
  await hostSays(page, answer("workingTreeLoad"));
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

test("a pushed commit's amend is asked in the graph's own dialog, the panel out of reach behind it", async ({
  page
}) => {
  const panel = page.locator("#workingTree");
  const commit = panel.locator("#wtCommitButton");
  const dialog = page.locator("#dialog.active");
  /** The panel's commit requests, as the page sent them to the host. */
  const commitsSent = () =>
    page.evaluate(() =>
      (
        (globalThis as unknown as { harnessRequests: { command: string }[] }).harnessRequests ?? []
      ).filter((m) => m.command === "workingTreeCommit")
    );

  await panel.getByLabel("Amend last commit").check();
  await expect(panel.locator("textarea")).toHaveValue(HEAD_MESSAGE);
  await expect(commit).toHaveText("Amend Commit");
  await commit.click();
  await hostSays(
    page,
    answer("workingTreeCommit", { refused: { kind: "pushed", remoteBranches: ["origin/main"] } })
  );

  // The graph's dialog, over the page: the panel is behind it, out of reach.
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("The last commit is already on origin/main.");
  await expect(dialog.locator("b")).toHaveText("origin/main");
  await expect(panel).toHaveAttribute("inert", "");

  // Walked away from: nothing more asked of the host, the keyboard back on
  // the button that asked.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(panel).not.toHaveAttribute("inert", "");
  await expect(commit).toBeFocused();
  expect(await commitsSent()).toEqual([
    { command: "workingTreeCommit", message: HEAD_MESSAGE, amend: true }
  ]);

  // Said yes to: asked again, now to rewrite it.
  await commit.click();
  await hostSays(
    page,
    answer("workingTreeCommit", { refused: { kind: "pushed", remoteBranches: ["origin/main"] } })
  );
  await dialog.locator("#dialogAction").click();
  await expect(dialog).toHaveCount(0);
  expect((await commitsSent()).at(-1)).toEqual({
    command: "workingTreeCommit",
    message: HEAD_MESSAGE,
    amend: true,
    rewritePushed: true
  });
});

test("closed, it hands the width back to the graph", async ({ page }) => {
  await page.locator("#workingTree").getByRole("button", { name: "Close" }).click();

  await expect(page.locator("#workingTree")).toBeHidden();
  const table = await page.locator("#commitTable").boundingBox();
  expect(table!.x + table!.width).toBeGreaterThan(page.viewportSize()!.width - WIDTH);
});
