import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { _electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";

import { diffShown } from "./diffViewerPage";
import {
  addAheadRemote,
  datedGit,
  type FixtureRepo,
  isolatedGitEnv,
  makeFixtureRepo
} from "./fixtureRepo";
import { focusedTabPage } from "./tabPages";

// The Branches and Remotes side views (#399), beside the graph in each Tab's
// page. Driven through the page as a user drives them; what they did is read
// off the graph, off git, and off the log (ADR-0032). The integration paths
// these hold: the tree the main process reads through core reaches the page;
// a click there filters the graph through the shared filter store; the graph's
// own Show All clears it through the dispatch's `showAllBranches` hook; a
// branch action runs in the graph and changes the repository; a remote's
// action runs core's command service, asked in the host prompt overlay; the
// Stash view (#400) lists what git lists, keeps up through its own watch of
// the stash log, and runs core's stash action, asked in the overlay too.

/** The app as `electron .` runs it: package.json's `main`, built into out/. */
const APP_DIR = path.resolve(__dirname, "..");
/** In Node, the `electron` package is the path to its binary. */
const ELECTRON = require("electron") as unknown as string;

let scratch: string;
let env: NodeJS.ProcessEnv;
let app: ElectronApplication | null = null;
let repo: FixtureRepo;

/** Close the app and read its whole log, once it is written out. */
async function closeAndReadLog(): Promise<string> {
  await app?.close();
  app = null;
  return readFileSync(path.join(scratch, "userData", "logs", "main.log"), "utf8");
}

/** The app on the fixture repository, in English, in a user data folder of
 *  its own and with git kept off the developer's configuration (ADR-0032);
 *  ready once the graph shows `rows` rows — the fixture's commits, and a row
 *  for each stash the test made. */
async function launchOnRepo(rows = repo.commits.length): Promise<Page> {
  app = await _electron.launch({
    executablePath: ELECTRON,
    args: [
      "--lang=en-US",
      APP_DIR,
      `--user-data-dir=${path.join(scratch, "userData")}`,
      "--repo",
      repo.path
    ],
    env: env as Record<string, string>
  });
  const page = await focusedTabPage(app);
  await expect(page.locator("#commitTable tr.commit")).toHaveCount(rows);
  return page;
}

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo.path, env, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();

/** The Branches view's row of `ref`. */
const branchRow = (page: Page, ref: string) => page.locator(`#branchesView [data-ref="${ref}"]`);

/** Turn on the Branches view's Show Inactive Branches. The fixture's commits
 *  are dated 2023, so every branch is inactive and hidden — all but `main`,
 *  which is checked out and so exempt. */
async function showInactive(page: Page) {
  await page.locator('#branchesView .sideViewActions [data-action="more"]').click();
  await page
    .locator("#contextMenu .contextMenuItem", { hasText: "Show Inactive Branches" })
    .click();
}

test.beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "ging-e2e-"));
  env = isolatedGitEnv(path.join(scratch, "home"));
  repo = makeFixtureRepo(env);
});

test.afterEach(async () => {
  await app?.close();
  app = null;
  rmSync(scratch, { recursive: true, force: true });
  rmSync(repo.path, { recursive: true, force: true });
  rmSync(`${repo.path}-remote.git`, { recursive: true, force: true });
});

test("the Branches view filters the graph by the branch clicked, and the graph's Show All clears it", async () => {
  const page = await launchOnRepo();
  const rows = page.locator("#commitTable tr.commit");

  // The local branches, under no group: the repository has no remote. The
  // inactive one shows once asked for, its age beside it.
  const labels = page.locator("#branchesView .sideViewRow .sideViewLabel");
  await expect(labels).toHaveText(["main"]);
  await showInactive(page);
  await expect(labels).toHaveText(["main", "feature"]);
  await expect(branchRow(page, "feature")).toContainText(/\dy$/);
  await expect(branchRow(page, "main")).toContainText("current");

  await branchRow(page, "feature").click();
  // `feature` and what it was branched from; not `main`'s third commit.
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText("Feature commit");
  await expect(branchRow(page, "feature")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#branchFilterChip")).toBeVisible();

  // The graph's own Show All: the dispatch's hook is the side view's now.
  await page.locator("#branchFilterClear").click();
  await expect(rows).toHaveCount(repo.commits.length);
  await expect(page.locator("#branchesView .sideViewRow.selected")).toHaveCount(0);

  const logged = await closeAndReadLog();
  expect(logged).not.toMatch(/ERROR:|"reportError"/);
});

test("a branch action from the Branches view runs in the graph, and none of the head-guarded ones on the checked-out branch", async () => {
  const page = await launchOnRepo();
  await showInactive(page);

  await branchRow(page, "main").click({ button: "right" });
  const items = page.locator("#contextMenu .contextMenuItem");
  await expect(items.first()).toBeVisible();
  // `main` is checked out: no Checkout, Delete, Merge, Rebase or Fast Forward.
  await expect(items.filter({ hasText: /^(Checkout|Delete|Merge|Rebase|Fast)/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await branchRow(page, "feature").click({ button: "right" });
  await items.filter({ hasText: /^Checkout Branch$/ }).click();

  await expect.poll(() => git("rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
  // The view follows: the repository changed under the graph's own action.
  await expect(branchRow(page, "feature")).toContainText("current");

  const logged = await closeAndReadLog();
  expect(logged).not.toMatch(/ERROR:|"reportError"/);
});

test("the Remotes view lists the remotes, and renames one through core's command, asked in the page", async () => {
  const remote = addAheadRemote(repo, env);
  const page = await launchOnRepo();

  // Closed at first, as VS Code's is.
  await page.locator("#remotesView .sideViewTitle").click();
  const origin = page.locator('#remotesView [data-remote="origin"]');
  await expect(origin).toContainText(remote.path);
  // With a remote, the branches come in two groups.
  await expect(page.locator("#branchesView .sideViewRow.group .sideViewLabel")).toHaveText([
    "Remote",
    "Local"
  ]);

  await origin.click({ button: "right" });
  await page.locator("#contextMenu .contextMenuItem", { hasText: "Rename Remote" }).click();
  const overlay = page.locator("#hostPrompt");
  await expect(overlay).toBeVisible();
  await page.locator("#hostPromptInput").fill("upstream");
  await page.keyboard.press("Enter");
  await expect(overlay).toBeHidden();

  await expect.poll(() => git("remote")).toBe("upstream");
  await expect(page.locator('#remotesView [data-remote="upstream"]')).toBeVisible();

  const logged = await closeAndReadLog();
  expect(logged).not.toMatch(/ERROR:|"reportError"/);
});

test("the Stash view lists every stash as git does, follows one pushed outside the app, and pops one through core, asked in the page", async () => {
  // As Alice, at fixed times after the fixture's commits: a stash is a commit.
  const stashGit = datedGit(repo.path, env, 1_800_000_000);
  writeFileSync(path.join(repo.path, "file.txt"), "work in progress\n");
  stashGit("stash", "push", "-m", "wip");
  // One row more in the graph: the stash's own.
  const page = await launchOnRepo(repo.commits.length + 1);

  const stashRows = page.locator("#stashView .sideViewRow.stash");
  await expect(stashRows).toHaveCount(1);
  await expect(stashRows.first()).toContainText("On main: wip");
  await expect(stashRows.first()).toContainText("stash@{0}");

  // Pushed outside the app: the view watches the stash log itself (#333).
  writeFileSync(path.join(repo.path, "other.txt"), "later\n");
  stashGit("stash", "push", "-u", "-m", "later");
  await expect(stashRows).toHaveCount(2);
  await expect(stashRows.nth(0)).toContainText("On main: later");
  await expect(stashRows.nth(1)).toContainText("stash@{1}");
  // The graph's own watcher catches up too, and its reload closes any menu
  // open in the page (`hideReloadOwnedOverlays`): a menu raised before that
  // would be closed under the click.
  await expect(page.locator("#commitTable tr.commit")).toHaveCount(repo.commits.length + 2);

  // Expanded, a stash lists the files it changed, read in the main process.
  await stashRows.nth(0).click();
  const files = page.locator("#stashView .sideViewRow.stashFile");
  await expect(files).toHaveCount(1);
  await expect(files.first()).toContainText("other.txt");
  await expect(files.first().locator(".sideViewFileBadge")).toHaveText("U");

  // Pop the older one: core's action, asked in the host prompt overlay with
  // VS Code's two answers.
  await stashRows.nth(1).click({ button: "right" });
  await page.locator("#contextMenu .contextMenuItem", { hasText: "Pop Stash" }).click();
  const overlay = page.locator("#hostPrompt");
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText("Pop stash stash@{1}?");
  await expect(overlay.getByRole("button", { name: "Pop & Reinstate Index" })).toBeVisible();
  await overlay.getByRole("button", { name: "Pop", exact: true }).click();
  await expect(overlay).toBeHidden();

  await expect.poll(() => git("stash", "list", "--format=%s")).toBe("On main: later");
  expect(readFileSync(path.join(repo.path, "file.txt"), "utf8")).toBe("work in progress\n");
  await expect(stashRows).toHaveCount(1);
  await expect(stashRows.first()).toContainText("stash@{0}");

  // A file of the stash left opens its diff in the app's diff viewer (#404),
  // through the same `Opener.openCommitDiff` the graph's files use.
  await expect(files).toHaveCount(1);
  await files.first().click();
  await diffShown(page);
  await expect(page.locator("#diffViewer .diffViewerTitle")).toContainText("other.txt");

  const logged = await closeAndReadLog();
  expect(logged).not.toMatch(/ERROR:|"reportError"/);
});
