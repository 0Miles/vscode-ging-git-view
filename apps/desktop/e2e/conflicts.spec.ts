import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { type ElectronApplication, expect, type Page, test } from "@playwright/test";

import { type FixtureRepo, isolatedGitEnv, makeFixtureRepo } from "./fixtureRepo";
import { APP_DIR, launchApp } from "./launch";
import { focusedTabPage } from "./tabPages";

// A merge stopped on a conflict, worked from the desktop app (#410): the
// conflicted file handed to the merge tool the user configured for git, marked
// resolved, and the merge continued — from the working tree panel and from the
// graph's own conflict banner. Real git under the real main process. The
// "merge tool" is a command in the fixture repository's config: it takes the
// other side's version, and no program with a window ever starts.

/** `git mergetool` is a shell script of git's: it takes seconds, on Windows,
 *  before the tool so much as starts. */
const MERGE_TOOL_RUN = { timeout: 20_000 };

let scratch: string;
let env: NodeJS.ProcessEnv;
let app: ElectronApplication | null = null;
let repo: FixtureRepo | null = null;

test.beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "ging-e2e-"));
  env = isolatedGitEnv(path.join(scratch, "home"));
});

test.afterEach(async () => {
  await app?.close();
  app = null;
  for (const dir of [scratch, repo?.path]) {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
  repo = null;
});

/** git in the fixture repository, as the test runs it. */
const gitIn =
  (dir: string) =>
  (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();

/**
 * The fixture's `feature` merged into `main`, stopped on the conflict both
 * make in file.txt — before the app starts, so no read of the app's races the
 * test's writes. `withTool` configures the repository's merge tool.
 */
function conflictedMerge(withTool: boolean): FixtureRepo {
  const fixture = makeFixtureRepo(env);
  const git = gitIn(fixture.path);
  // Who the app's git commits the merge as.
  git("config", "user.name", "Alice");
  git("config", "user.email", "alice@example.com");
  if (withTool) {
    git("config", "merge.tool", "theirs");
    git("config", "mergetool.theirs.cmd", 'cp "$REMOTE" "$MERGED"');
    git("config", "mergetool.theirs.trustExitCode", "true");
  }
  const merge = spawnSync("git", ["merge", "feature"], { cwd: fixture.path, env });
  expect(merge.status, "the merge stops on its conflict").not.toBe(0);
  expect(git("diff", "--name-only", "--diff-filter=U")).toBe("file.txt");
  return fixture;
}

async function launch(fixture: FixtureRepo): Promise<Page> {
  app = await launchApp(
    [
      "--lang=en-US",
      APP_DIR,
      `--user-data-dir=${path.join(scratch, "userData")}`,
      "--repo",
      fixture.path
    ],
    env
  );
  const page = await focusedTabPage(app);
  await expect(page.locator("#commitTable tr.commit")).toHaveCount(fixture.commits.length);
  return page;
}

/** The graph's Open Source Control View, on its uncommitted changes row. */
async function openPanel(page: Page) {
  const panel = page.locator("#workingTree");
  await page.locator("#commitTable tr.unsavedChanges").click({ button: "right" });
  await page.locator("#contextMenu").getByText("Open Source Control View").click();
  await expect(panel).toBeVisible();
  return panel;
}

/** What the system's message boxes were asked to say: stood in for in the
 *  main process (ADR-0032), each answered with its first button. */
function standInForMessageBoxes(electronApp: ElectronApplication) {
  return electronApp.evaluate(({ dialog }) => {
    const seen: { type: string; message: string }[] = [];
    (globalThis as Record<string, unknown>).seenBoxes = seen;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { type: string; message: string };
      seen.push({ type: options.type, message: options.message });
      return { response: 0, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
}
const seenBoxes = (electronApp: ElectronApplication) =>
  electronApp.evaluate(
    () => (globalThis as Record<string, unknown>).seenBoxes as { type: string; message: string }[]
  );

async function noErrorInTheLog() {
  await app!.close();
  app = null;
  const logged = readFileSync(path.join(scratch, "userData", "logs", "main.log"), "utf8");
  expect(logged).not.toContain("ERROR:");
}

test("a conflict resolved with the configured merge tool from the working tree panel, then continued from it, leaves the merge commit in the graph", async () => {
  repo = conflictedMerge(true);
  const git = gitIn(repo.path);
  const page = await launch(repo);
  const panel = await openPanel(page);

  const conflicted = panel.locator('.wtFile[data-area="conflicted"]');
  const staged = panel.locator('.wtFile[data-area="staged"]');
  const operation = panel.locator(".wtOperation");
  const continueButton = operation.getByRole("button", { name: "Continue" });
  await expect(conflicted).toHaveCount(1);
  await expect(conflicted.locator(".wtName")).toHaveText("file.txt");
  await expect(operation.locator(".wtOperationTitle")).toHaveText("Merge in progress");
  // A conflict left: nothing to continue yet.
  await expect(continueButton).toHaveAttribute("aria-disabled", "true");

  await conflicted.hover();
  await conflicted.getByRole("button", { name: "Open in Merge Tool" }).click();

  // The tool took the feature's side, and git staged it once it closed.
  await expect(conflicted).toHaveCount(0, MERGE_TOOL_RUN);
  await expect(staged.locator(".wtName")).toHaveText("file.txt");
  expect(readFileSync(path.join(repo.path, "file.txt"), "utf8")).toBe("Feature commit\n");
  expect(git("diff", "--name-only", "--diff-filter=U")).toBe("");
  expect(existsSync(path.join(repo.path, ".git", "MERGE_HEAD"))).toBe(true);

  await expect(continueButton).not.toHaveAttribute("aria-disabled");
  await continueButton.click();

  // The merge commit, on top of the graph, as HEAD, with both parents.
  const rows = page.locator("#commitTable tr.commit");
  await expect(rows).toHaveCount(repo.commits.length + 1);
  expect(await rows.first().getAttribute("data-hash")).toBe(git("rev-parse", "HEAD"));
  expect(git("log", "-1", "--format=%P").split(" ")).toHaveLength(2);
  expect(existsSync(path.join(repo.path, ".git", "MERGE_HEAD"))).toBe(false);
  await expect(operation).toHaveCount(0);
  await expect(page.locator("#conflictBanner.active")).toHaveCount(0);
  await expect(panel.locator("[role=alert]")).toBeEmpty();
  await expect(page.locator("#dialog.active")).toHaveCount(0);

  await noErrorInTheLog();
});

test("with no merge tool configured, the graph's conflict banner says how to set one and runs no tool", async () => {
  repo = conflictedMerge(false);
  const git = gitIn(repo.path);
  const page = await launch(repo);
  await standInForMessageBoxes(app!);

  // The conflict banner's file name: `Opener.openMergeEditor`.
  const banner = page.locator("#conflictBanner.active");
  await expect(banner).toBeVisible();
  await banner.locator(".conflictFile", { hasText: "file.txt" }).click();

  await expect
    .poll(() => seenBoxes(app!))
    .toEqual([
      {
        type: "error",
        message: expect.stringContaining('"git config --global merge.tool <tool>"')
      }
    ]);
  // Nothing ran: git was not left to guess a tool, which would have started
  // one and left its backup.
  expect(git("diff", "--name-only", "--diff-filter=U")).toBe("file.txt");
  expect(existsSync(path.join(repo.path, "file.txt.orig"))).toBe(false);
  await expect(page.locator("#dialog.active")).toHaveCount(0);

  await noErrorInTheLog();
});

test("marking a file resolved while its conflict markers remain asks first", async () => {
  repo = conflictedMerge(false);
  const git = gitIn(repo.path);
  const page = await launch(repo);
  const panel = await openPanel(page);
  const conflicted = panel.locator('.wtFile[data-area="conflicted"]');
  const staged = panel.locator('.wtFile[data-area="staged"]');
  const overlay = page.locator("#hostPrompt");
  const markResolved = async () => {
    await conflicted.hover();
    await conflicted.getByRole("button", { name: "Mark Resolved" }).click();
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText(
      "file.txt still has conflict markers in it. Mark it resolved anyway?"
    );
  };

  // Declined: still in conflict.
  await markResolved();
  await overlay.getByRole("button", { name: "Cancel" }).click();
  await expect(overlay).toBeHidden();
  await expect(conflicted).toHaveCount(1);
  expect(git("diff", "--name-only", "--diff-filter=U")).toBe("file.txt");

  // Told to: staged as it is, markers and all.
  await markResolved();
  await overlay.getByRole("button", { name: "Mark Resolved" }).click();
  await expect(conflicted).toHaveCount(0);
  await expect(staged.locator(".wtName")).toHaveText("file.txt");
  expect(git("diff", "--name-only", "--diff-filter=U")).toBe("");
  expect(git("show", ":file.txt")).toContain("<<<<<<<");
  // The merge goes on: continuing it is a step of its own.
  expect(existsSync(path.join(repo.path, ".git", "MERGE_HEAD"))).toBe(true);
  await expect(panel.locator(".wtOperation")).toHaveCount(1);

  await noErrorInTheLog();
});
