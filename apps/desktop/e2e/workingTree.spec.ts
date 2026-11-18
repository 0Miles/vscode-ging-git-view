import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { _electron, type ElectronApplication, expect, test } from "@playwright/test";

import { addAheadRemote, type FixtureRepo, isolatedGitEnv, makeFixtureRepo } from "./fixtureRepo";
import { focusedTabPage } from "./tabPages";

// The working tree panel (#403), the tracer bullet of phase D: a file changed,
// staged whole and committed from the panel beside the graph, and the commit
// drawn in the graph; and the last commit amended and signed off there (#407).
// Real git under the real main process, read through the page, the repository
// and the app's log (ADR-0032).

/** The app as `electron .` runs it: package.json's `main`, built into out/. */
const APP_DIR = path.resolve(__dirname, "..");
/** In Node, the `electron` package is the path to its binary. */
const ELECTRON = require("electron") as unknown as string;

let scratch: string;
let env: NodeJS.ProcessEnv;
let app: ElectronApplication | null = null;
let repo: FixtureRepo | null = null;
/** The bare repository a test made `origin`, if it made one. */
let remote: string | undefined;

test.beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "ging-e2e-"));
  env = isolatedGitEnv(path.join(scratch, "home"));
});

test.afterEach(async () => {
  await app?.close();
  app = null;
  for (const dir of [scratch, repo?.path, remote]) {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
  repo = null;
  remote = undefined;
});

test("a file changed, staged whole and committed from the working tree panel shows up in the graph", async () => {
  repo = makeFixtureRepo(env);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo!.path, env, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  // The app's git commits as whom.
  git("config", "user.name", "Alice");
  git("config", "user.email", "alice@example.com");
  // One file to stage and commit, one to leave out. The panel's writes then go
  // the user's way, with no wait for the graph's reloads: those reads take no
  // index lock (#451).
  writeFileSync(path.join(repo.path, "file.txt"), "Changed in the working tree\n");
  writeFileSync(path.join(repo.path, "left out.txt"), "Not to be committed\n");

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
  const rows = page.locator("#commitTable tr.commit");
  await expect(rows).toHaveCount(repo.commits.length);

  // The graph's Open Source Control View, on its uncommitted changes row.
  const panel = page.locator("#workingTree");
  await expect(panel).toBeHidden();
  await page.locator("#commitTable tr.unsavedChanges").click({ button: "right" });
  await page.locator("#contextMenu").getByText("Open Source Control View").click();
  await expect(panel).toBeVisible();

  const unstaged = panel.locator('.wtFile[data-area="unstaged"]');
  const staged = panel.locator('.wtFile[data-area="staged"]');
  await expect(unstaged).toHaveCount(2);
  await expect(staged).toHaveCount(0);
  const changed = unstaged.filter({ has: page.locator(".wtName", { hasText: "file.txt" }) });
  await expect(changed.locator(".wtLetter")).toHaveText("M");
  // Nothing staged: nothing to commit yet.
  const commitButton = panel.locator(".wtCommitButton");
  await expect(commitButton).toBeDisabled();

  // Staged whole; its button shows on the row the pointer is over.
  await changed.hover();
  await changed.getByRole("button", { name: "Stage" }).click();
  await expect(staged).toHaveCount(1);
  await expect(staged.locator(".wtName")).toHaveText("file.txt");
  await expect(unstaged).toHaveCount(1);
  expect(git("diff", "--cached", "--name-only")).toBe("file.txt");
  await expect(panel.locator("[role=alert]")).toBeEmpty();

  const message = "Committed from the working tree panel";
  await panel.locator("textarea").fill(message);
  await expect(commitButton).toBeEnabled();
  await commitButton.click();

  // The new commit, on top of the graph, as HEAD.
  await expect(rows).toHaveCount(repo.commits.length + 1);
  await expect(rows.first()).toContainText(message);
  expect(await rows.first().getAttribute("data-hash")).toBe(git("rev-parse", "HEAD"));
  expect(git("log", "-1", "--format=%s")).toBe(message);
  expect(git("show", "--name-only", "--format=", "HEAD")).toBe("file.txt");
  // The panel shows what is left, and the message box is empty again.
  await expect(staged).toHaveCount(0);
  await expect(unstaged).toHaveCount(1);
  await expect(unstaged.locator(".wtName")).toHaveText("left out.txt");
  await expect(panel.locator("textarea")).toHaveValue("");
  await expect(panel.locator("[role=alert]")).toBeEmpty();
  await expect(page.locator("#dialog.active")).toHaveCount(0);

  await app.close();
  app = null;
  const logged = readFileSync(path.join(scratch, "userData", "logs", "main.log"), "utf8");
  expect(logged).not.toContain("ERROR:");
});

/**
 * How long the amend may take to show in the graph once the warning is
 * answered: the amend's own git (the pushed check, the commit), then the
 * graph's reload. Not Playwright's 5s default, which it once used by
 * omission. Measured on Windows with every core busy: HEAD moved 1.0–2.9s
 * after the click, the graph drew it 3.8–8.5s after (10 runs), and each run
 * did draw it — a slow reload, not a lost one. About twice the worst; the
 * same reading as the actions walk's ANSWER_BUDGET_MS (#472, #473).
 */
const AMEND_DRAWN_BUDGET_MS = 20_000;

// Amend and sign-off (#407): the last commit, already on the remote, reworded
// and signed off from the panel; the warning about rewriting pushed history
// asked in the graph's own dialog.
test("the last commit, already pushed, amended with a sign-off from the working tree panel after the graph's warning", async () => {
  repo = makeFixtureRepo(env);
  remote = addAheadRemote(repo, env).path;
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo!.path, env, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  // The app's git commits, and signs off, as whom.
  git("config", "user.name", "Alice");
  git("config", "user.email", "alice@example.com");
  const pushed = git("rev-parse", "HEAD");
  expect(git("rev-parse", "origin/main")).toBe(pushed);
  const parent = git("rev-parse", "HEAD~1");
  // A change to a tracked file, for the graph's uncommitted row that opens
  // the panel; never staged, so the amend changes the message alone.
  writeFileSync(path.join(repo.path, "file.txt"), "Not to be committed\n");

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
  const rows = page.locator("#commitTable tr.commit");
  await expect(rows).toHaveCount(repo.commits.length);

  await page.locator("#commitTable tr.unsavedChanges").click({ button: "right" });
  await page.locator("#contextMenu").getByText("Open Source Control View").click();
  const panel = page.locator("#workingTree");
  await expect(panel.locator('.wtFile[data-area="unstaged"]')).toHaveCount(1);

  // Amend starts from the last commit's message.
  const amend = panel.getByLabel("Amend last commit");
  await amend.check();
  const box = panel.locator("textarea");
  await expect(box).toHaveValue("Third commit");
  await box.fill("Third commit, reworded");
  await panel.getByLabel("Sign off").check();
  const commitButton = panel.locator(".wtCommitButton");
  await expect(commitButton).toHaveText("Amend Commit");
  await commitButton.click();

  // Pushed: asked first, in the graph's own dialog, and nothing done yet.
  const dialog = page.locator("#dialog.active");
  await expect(dialog).toContainText("The last commit is already on origin/main.");
  expect(git("rev-parse", "HEAD")).toBe(pushed);
  await dialog.locator("#dialogAction").click();

  // The commit replaced on top of the graph: the same parent, the new
  // message, signed off by the committer. The one it replaced stays drawn,
  // where origin/main still points.
  await expect(rows.first()).toContainText("Third commit, reworded", {
    timeout: AMEND_DRAWN_BUDGET_MS
  });
  await expect(rows).toHaveCount(repo.commits.length + 1);
  await expect(page.locator(`#commitTable tr.commit[data-hash="${pushed}"]`)).toHaveCount(1);
  const amended = git("rev-parse", "HEAD");
  expect(amended).not.toBe(pushed);
  expect(await rows.first().getAttribute("data-hash")).toBe(amended);
  expect(git("rev-parse", "HEAD~1")).toBe(parent);
  expect(git("log", "-1", "--format=%B")).toBe(
    "Third commit, reworded\n\nSigned-off-by: Alice <alice@example.com>"
  );
  // Only a push moves the remote-tracking branch.
  expect(git("rev-parse", "origin/main")).toBe(pushed);
  // Back to a plain commit, the box empty; nothing staged that was not.
  await expect(amend).not.toBeChecked();
  await expect(box).toHaveValue("");
  await expect(panel.locator("[role=alert]")).toBeEmpty();
  expect(git("status", "--short")).toBe("M file.txt");

  await app.close();
  app = null;
  const logged = readFileSync(path.join(scratch, "userData", "logs", "main.log"), "utf8");
  expect(logged).not.toContain("ERROR:");
});
