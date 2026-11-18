import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { type ElectronApplication, expect, type Page, test } from "@playwright/test";

import { diffShown, keepTraceIfFailed, startTrace } from "./diffViewerPage";
import { datedGit, type FixtureRepo, isolatedGitEnv, makeFixtureRepo } from "./fixtureRepo";
import { APP_DIR, launchApp } from "./launch";
import { focusedTabPage } from "./tabPages";

// Hunk staging (#406): a file opened from the working tree panel in the diff
// viewer (#460), one of its hunks staged there and unstaged again, and a hunk
// refused once the file changed on disk after its diff was shown. Real git
// under the real main process, Monaco drawing the hunks' buttons; read
// through the page, the repository and the app's log (ADR-0032).

let scratch: string;
let env: NodeJS.ProcessEnv;
let app: ElectronApplication | null = null;
let repo: FixtureRepo | null = null;

test.beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "ging-e2e-"));
  env = isolatedGitEnv(path.join(scratch, "home"));
});

test.afterEach(async () => {
  if (app !== null) await keepTraceIfFailed(app, test.info());
  await app?.close();
  app = null;
  // The app's log too, for a failed test: the main process's side of it.
  const log = path.join(scratch, "userData", "logs", "main.log");
  if (test.info().status !== test.info().expectedStatus && existsSync(log)) {
    copyFileSync(log, test.info().outputPath("main.log"));
  }
  for (const dir of [scratch, repo?.path]) {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
  repo = null;
});

/** Thirty numbered lines, `change` making some of them something else. */
const numbered = (change: (n: number) => string = String) =>
  Array.from({ length: 30 }, (_, i) => change(i + 1)).join("\n") + "\n";
/** Lines 3 and 28 changed: two hunks, far apart. */
const EDITED = numbered((n) => (n === 3 ? "three" : n === 28 ? "twenty-eight" : String(n)));

/** The fixture repository with `numbers.txt` committed, then edited at two
 *  places in the working tree; changed before the app starts, for the reason
 *  workingTree.spec.ts gives. */
function repoWithTwoHunks() {
  repo = makeFixtureRepo(env);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo!.path, env, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  writeFileSync(path.join(repo.path, "numbers.txt"), numbered());
  const dated = datedGit(repo.path, env, 1_800_000_000);
  dated("add", "numbers.txt");
  dated("commit", "-qm", "Numbers");
  writeFileSync(path.join(repo.path, "numbers.txt"), EDITED);
  return { path: repo.path, git };
}

async function launch(repoPath: string): Promise<Page> {
  app = await launchApp(
    [
      "--lang=en-US",
      APP_DIR,
      `--user-data-dir=${path.join(scratch, "userData")}`,
      "--repo",
      repoPath
    ],
    env
  );
  await startTrace(app);
  const page = await focusedTabPage(app);
  await expect(page.locator("#commitTable tr.commit").first()).toBeVisible();
  // The working tree panel, from the graph's Open Source Control View.
  await page.locator("#commitTable tr.unsavedChanges").click({ button: "right" });
  await page.locator("#contextMenu").getByText("Open Source Control View").click();
  await expect(page.locator("#workingTree")).toBeVisible();
  return page;
}

/** `numbers.txt`'s row in the panel's `area` list. */
const row = (page: Page, area: "staged" | "unstaged") =>
  page.locator(`#workingTree .wtFile[data-area="${area}"][data-path="numbers.txt"]`);
/** The diff viewer's hunk buttons, in the order of the file's lines. */
const hunkButtons = (page: Page) => page.locator("#diffViewer .diffViewerHunk button");

test("one hunk of a file, opened from the working tree panel, staged from its diff and unstaged again", async () => {
  const { path: dir, git } = repoWithTwoHunks();
  const page = await launch(dir);

  // The file's row opens its diff: the index against the working tree.
  await row(page, "unstaged").click();
  await diffShown(page);
  const viewer = page.locator("#diffViewer");
  await expect(viewer.locator(".diffViewerTitle")).toHaveText("numbers.txt (Working Tree)");
  await expect(hunkButtons(page)).toHaveText(["Stage Hunk", "Stage Hunk"]);
  // Named apart by their lines: every button says the same word.
  await expect(hunkButtons(page).nth(1)).toHaveAccessibleName("Stage Hunk: lines 25 to 30");
  // Each above its hunk: git's hunk starts three lines of context before the
  // line changed, the button on a row of its own just above that.
  const changedLine = viewer.locator(".editor.modified .view-line", { hasText: "twenty-eight" });
  const [button, line] = await Promise.all([
    hunkButtons(page).nth(1).boundingBox(),
    changedLine.boundingBox()
  ]);
  expect(button!.y).toBeLessThan(line!.y);
  expect(line!.y - button!.y).toBeLessThan(5 * line!.height + 24);
  expect(line!.y - button!.y).toBeGreaterThan(3 * line!.height);

  // The second hunk alone into the index; the working tree as it was.
  await hunkButtons(page).nth(1).click();
  await diffShown(page, 5_000);
  await expect(hunkButtons(page)).toHaveCount(1);
  expect(git("show", ":0:numbers.txt") + "\n").toBe(
    numbered((n) => (n === 28 ? "twenty-eight" : String(n)))
  );
  expect(readFileSync(path.join(dir, "numbers.txt"), "utf8")).toBe(EDITED);
  // The panel follows: the file is staged now, and still has a change left.
  await expect(row(page, "staged")).toHaveCount(1);
  await expect(row(page, "unstaged")).toHaveCount(1);
  await expect(viewer.locator(".diffViewerSaid")).toBeHidden();

  // The staged diff, HEAD against the index, takes it back out.
  await row(page, "staged").click();
  await diffShown(page, 5_000);
  await expect(viewer.locator(".diffViewerTitle")).toHaveText("numbers.txt (Index)");
  await expect(hunkButtons(page)).toHaveText(["Unstage Hunk"]);
  await hunkButtons(page).click();
  await diffShown(page, 5_000);
  await expect(hunkButtons(page)).toHaveCount(0);
  expect(git("diff", "--cached", "--name-only")).toBe("");
  await expect(row(page, "staged")).toHaveCount(0);

  await expect(page.locator("#dialog.active")).toHaveCount(0);
  await app!.close();
  app = null;
  const logged = readFileSync(path.join(scratch, "userData", "logs", "main.log"), "utf8");
  expect(logged).not.toContain("ERROR:");
});

test("a hunk staged through the editor's context menu, opened from the keyboard at the cursor", async () => {
  const { path: dir, git } = repoWithTwoHunks();
  const page = await launch(dir);
  await row(page, "unstaged").focus();
  await page.keyboard.press("Enter");
  await diffShown(page);
  await expect(hunkButtons(page)).toHaveCount(2);

  // The viewer says how, in its description, read out as it is entered.
  await expect(page.locator("#diffViewer")).toHaveAccessibleDescription(/Shift\+F10/);
  const modified = page.locator("#diffViewer .editor.modified");
  // The cursor on the first hunk's changed line, then the context menu.
  await modified.locator(".view-line", { hasText: "three" }).click();
  await page.keyboard.press("Shift+F10");
  const item = page.getByRole("menuitem", { name: "Stage Hunk" });
  await expect(item).toBeVisible();
  // Chosen from the keyboard: it is the menu's first item.
  await page.keyboard.press("ArrowDown");
  await expect(item).toBeFocused();
  await page.keyboard.press("Enter");

  // The menu runs its action once it has closed: the index tells when.
  await expect
    .poll(() => git("show", ":0:numbers.txt") + "\n")
    .toBe(numbered((n) => (n === 3 ? "three" : String(n))));
  await diffShown(page, 5_000);
  await expect(hunkButtons(page)).toHaveCount(1);
});

test("a hunk staged from the editor's context menu with the mouse, listed only in a hunk", async () => {
  const { path: dir, git } = repoWithTwoHunks();
  const page = await launch(dir);
  await row(page, "unstaged").click();
  await diffShown(page);
  const modified = page.locator("#diffViewer .editor.modified");
  const item = page.getByRole("menuitem", { name: "Stage Hunk" });

  // Outside every hunk (line 10), the menu has no hunk to offer.
  await modified.locator(".view-line", { hasText: /^10$/ }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Copy" })).toBeVisible();
  await expect(item).toHaveCount(0);

  // On the first hunk's changed line, it does.
  await modified.locator(".view-line", { hasText: "three" }).click({ button: "right" });
  // Pressed as a person presses it, the button held a moment: Monaco's menu
  // takes an item's mouseup only from 100 ms after it draws the menu
  // (`runOnceToEnableMouseUp` in its menu.js, so the click that opened a
  // menu cannot also run an item), and a click Playwright sends the moment
  // the item shows can be sooner. Measured: such a click is dropped and the
  // menu stays open; one at 112 ms or later runs the item, the target under
  // the pointer being the item itself (#406's status record).
  await item.click({ delay: 150 });

  await expect
    .poll(() => git("show", ":0:numbers.txt") + "\n")
    .toBe(numbered((n) => (n === 3 ? "three" : String(n))));
  await diffShown(page, 5_000);
  await expect(hunkButtons(page)).toHaveCount(1);
});

test("a hunk is staged on no line once the file changed on disk after its diff was shown", async () => {
  const { path: dir, git } = repoWithTwoHunks();
  const page = await launch(dir);
  await row(page, "unstaged").click();
  await diffShown(page);
  await expect(hunkButtons(page)).toHaveCount(2);

  // A line more at the top: every hunk shown is now two lines off. Only the
  // working tree changes, so no lock of the app's index is met.
  writeFileSync(path.join(dir, "numbers.txt"), "zero\n" + EDITED);
  await hunkButtons(page).nth(1).click();
  await diffShown(page, 5_000);

  const viewer = page.locator("#diffViewer");
  await expect(viewer.locator(".diffViewerSaid")).toContainText(
    "The file changed since this diff was shown"
  );
  expect(git("diff", "--cached", "--name-only")).toBe("");
  // The diff as it is now, its hunks to stage afresh.
  await expect(viewer.locator(".editor.modified .view-lines")).toContainText("zero");
  await expect(hunkButtons(page)).toHaveCount(2);

  await app!.close();
  app = null;
  const logged = readFileSync(path.join(scratch, "userData", "logs", "main.log"), "utf8");
  expect(logged).not.toContain("ERROR:");
});
