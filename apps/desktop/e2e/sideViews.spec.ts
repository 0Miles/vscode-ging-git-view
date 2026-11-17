import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { _electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";

import { addAheadRemote, type FixtureRepo, isolatedGitEnv, makeFixtureRepo } from "./fixtureRepo";
import { focusedTabPage } from "./tabPages";

// The Branches and Remotes side views (#399), beside the graph in each Tab's
// page. Driven through the page as a user drives them; what they did is read
// off the graph, off git, and off the log (ADR-0032). The integration paths
// these hold: the tree the main process reads through core reaches the page;
// a click there filters the graph through the shared filter store; the graph's
// own Show All clears it through the dispatch's `showAllBranches` hook; a
// branch action runs in the graph and changes the repository; a remote's
// action runs core's command service, asked in the host prompt overlay.

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
 *  its own and with git kept off the developer's configuration (ADR-0032). */
async function launchOnRepo(): Promise<Page> {
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
  await expect(page.locator("#commitTable tr.commit")).toHaveCount(repo.commits.length);
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
