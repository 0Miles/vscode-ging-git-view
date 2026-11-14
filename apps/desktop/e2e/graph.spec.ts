import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

/**
 * Close the app and read its whole log. Its own file rather than its stdout:
 * what it logs while starting is written before Playwright has the process to
 * listen to. Read only once the app has quit, which waits for the log to be
 * written out: before that, a line may still be on its way to the file, and a
 * check that some line is absent would pass for the wrong reason.
 */
async function closeAndReadLog(): Promise<string> {
  await app?.close();
  app = null;
  return readFileSync(path.join(scratch, "userData", "logs", "main.log"), "utf8");
}

/** The arguments a launch of this app gives Electron, after its own switches. */
const appArgs = (...args: string[]) => [
  // English whatever the machine's locale, so the page's words can be read.
  "--lang=en-US",
  APP_DIR,
  `--user-data-dir=${path.join(scratch, "userData")}`,
  ...args
];

/** Start the app on `args`, in a user data folder of its own (the
 *  single-instance lock's scope) and with git kept off the developer's own
 *  configuration (ADR-0032). */
async function launch(...args: string[]): Promise<ElectronApplication> {
  app = await _electron.launch({
    executablePath: ELECTRON,
    args: appArgs(...args),
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
    await expect(rows).toContainText(repo.commits.map((commit) => commit.subject));
    expect(await rows.evaluateAll((trs) => trs.map((tr) => tr.getAttribute("data-hash")))).toEqual(
      repo.commits.map((commit) => commit.hash)
    );
    // Drawn, not only listed: one vertex per commit in the graph's SVG, and the
    // ring that marks HEAD's.
    await expect(page.locator("#commitGraph circle:not(.currentHalo)")).toHaveCount(
      repo.commits.length
    );
    await expect(page.locator("#commitGraph circle.currentHalo")).toHaveCount(1);
    await expect(page.locator("#repoTitleName")).toHaveText(path.basename(repo.path));

    const logged = await closeAndReadLog();
    expect(logged).toContain("launch: opening");
    expect(logged).not.toMatch(WEBVIEW_FAILURE);
    // Nor anything else going wrong on the way: no line of the log is an error.
    expect(logged).not.toContain("ERROR:");
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
  const logged = await closeAndReadLog();
  expect(logged).toContain(`launch: cannot open ${missing}`);
  expect(logged).not.toMatch(WEBVIEW_FAILURE);
});

test("a folder that is not a repository shows why too", async () => {
  const folder = path.join(scratch, "plain-folder");
  mkdirSync(folder);
  const page = await (await launch("--repo", folder)).firstWindow();

  await expect(page.locator("p")).toHaveText(`Cannot open ${folder}: it is not a Git repository.`);
  await expect(page.locator("#commitTable")).toHaveCount(0);
  expect(await closeAndReadLog()).not.toMatch(WEBVIEW_FAILURE);
});

test("a later launch naming a path that is no repository leaves the graph open, and says why", async () => {
  const repo = makeFixtureRepo(env);
  try {
    const electronApp = await launch("--repo", repo.path);
    const page = await electronApp.firstWindow();
    const rows = page.locator("#commitTable tr.commit");
    await expect(rows).toHaveCount(repo.commits.length);
    // The system's dialog, answered in its place (ADR-0032): every box goes
    // through the app's NativeDialogs, which looks Electron's up when called,
    // so replacing it here answers for them all.
    await electronApp.evaluate(({ dialog }) => {
      const asked: unknown[] = [];
      (globalThis as Record<string, unknown>).askedBoxes = asked;
      dialog.showMessageBox = (async (...args: unknown[]) => {
        asked.push(args.at(-1));
        return { response: 0, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    });

    const missing = path.join(scratch, "not-a-repo");
    const sandbox = process.platform === "linux" ? ["--no-sandbox"] : [];
    const second = spawn(ELECTRON, [...sandbox, ...appArgs("--repo", missing)], {
      env,
      stdio: "ignore"
    });
    expect(await new Promise((resolve) => second.on("exit", resolve))).toBe(0);

    await expect
      .poll(() => electronApp.evaluate(() => (globalThis as Record<string, unknown>).askedBoxes))
      .toEqual([
        expect.objectContaining({
          type: "error",
          detail: `Cannot open ${missing}: it is not a Git repository.`
        })
      ]);
    await expect(rows).toHaveCount(repo.commits.length);
    expect(await closeAndReadLog()).not.toMatch(WEBVIEW_FAILURE);
  } finally {
    await app?.close();
    app = null;
    rmSync(repo.path, { recursive: true, force: true });
  }
});
