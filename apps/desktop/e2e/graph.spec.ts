import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { _electron, type ElectronApplication, expect, test } from "@playwright/test";

import { type FixtureRepo, isolatedGitEnv, makeFixtureRepo } from "./fixtureRepo";

/** The app as `electron .` runs it: package.json's `main`, built into out/. */
const APP_DIR = path.resolve(__dirname, "..");
/** In Node, the `electron` package is the path to its binary. */
const ELECTRON = require("electron") as unknown as string;

/** A line the webview's failure report leaves in the log (`formatWebviewError`),
 *  or a message the page posted that reached no graph. */
const WEBVIEW_FAILURE = /ERROR: webview |"reportError"/;

let scratch: string;
let env: NodeJS.ProcessEnv;
let app: ElectronApplication | null = null;

/** The app's log so far. Its own file rather than its stdout: what it logs
 *  while starting is written before Playwright has the process to listen to. */
const log = () => {
  try {
    return readFileSync(path.join(scratch, "userData", "logs", "main.log"), "utf8");
  } catch {
    return "";
  }
};

/** Start the app on `args`, in a user data folder of its own (the
 *  single-instance lock's scope) and with git kept off the developer's own
 *  configuration (ADR-0032). */
async function launch(...args: string[]): Promise<ElectronApplication> {
  app = await _electron.launch({
    executablePath: ELECTRON,
    // English whatever the machine's locale, so the page's words can be read.
    args: ["--lang=en-US", APP_DIR, `--user-data-dir=${path.join(scratch, "userData")}`, ...args],
    env: env as Record<string, string>
  });
  return app;
}

test.beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "ging-e2e-"));
  env = isolatedGitEnv(path.join(scratch, "home"));
});

test.afterEach(async () => {
  await app?.close();
  app = null;
  rmSync(scratch, { recursive: true, force: true });
});

test("the graph draws the fixture repository opened with --repo", async () => {
  const repo: FixtureRepo = makeFixtureRepo(env);
  test.info().attach("fixture", { body: repo.path });
  try {
    const page = await (await launch("--repo", repo.path)).firstWindow();

    // Every commit, newest first, as `git log` orders them by date.
    const rows = page.locator("#commitTable tr.commit");
    await expect(rows).toHaveCount(repo.commits.length);
    for (const [i, { hash, subject }] of repo.commits.entries()) {
      await expect(rows.nth(i)).toHaveAttribute("data-hash", hash);
      await expect(rows.nth(i)).toContainText(subject);
    }
    // Drawn, not only listed: one vertex per commit in the graph's SVG, and the
    // ring that marks HEAD's.
    await expect(page.locator("#commitGraph circle:not(.currentHalo)")).toHaveCount(
      repo.commits.length
    );
    await expect(page.locator("#commitGraph circle.currentHalo")).toHaveCount(1);
    await expect(page.locator("#repoTitleName")).toHaveText(path.basename(repo.path));

    await expect.poll(log).toContain("launch: opening");
    expect(log()).not.toMatch(WEBVIEW_FAILURE);
    // Nor anything else going wrong on the way: no line of the log is an error.
    expect(log()).not.toContain("ERROR:");
  } finally {
    await app?.close();
    app = null;
    rmSync(repo.path, { recursive: true, force: true });
  }
});

test("an invalid --repo shows why, and hands the webview nothing", async () => {
  const missing = path.join(scratch, "not-a-repo");
  const page = await (await launch("--repo", missing)).firstWindow();

  await expect(page.locator("h2")).toHaveText("Unable to load GING");
  await expect(page.locator("p")).toHaveText(`Cannot open ${missing}: it is not a Git repository.`);
  await expect(page.locator("#commitTable")).toHaveCount(0);
  // The desktop entry did load, and started nothing that could fail.
  await expect(page.locator("html")).toHaveAttribute("data-ging-entry", "ging-desktop-entry");
  await expect.poll(log).toContain(`launch: cannot open ${missing}`);
  expect(log()).not.toMatch(WEBVIEW_FAILURE);
});
