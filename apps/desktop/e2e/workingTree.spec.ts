import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { _electron, type ElectronApplication, expect, test } from "@playwright/test";

import { type FixtureRepo, isolatedGitEnv, makeFixtureRepo } from "./fixtureRepo";
import { focusedTabPage } from "./tabPages";

// The working tree panel (#403), the tracer bullet of phase D: a file changed,
// staged whole and committed from the panel beside the graph, and the commit
// drawn in the graph. Real git under the real main process, read through the
// page, the repository and the app's log (ADR-0032).

/** The app as `electron .` runs it: package.json's `main`, built into out/. */
const APP_DIR = path.resolve(__dirname, "..");
/** In Node, the `electron` package is the path to its binary. */
const ELECTRON = require("electron") as unknown as string;

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
