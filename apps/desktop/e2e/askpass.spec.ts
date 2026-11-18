import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { type ElectronApplication, expect, test } from "@playwright/test";

import { type FixtureRepo, isolatedGitEnv, makeFixtureRepo } from "./fixtureRepo";
import { APP_DIR, launchApp } from "./launch";
import { focusedTabPage } from "./tabPages";
import { startUnauthorizedRemote, type UnauthorizedRemote } from "./unauthorizedRemote";

// askpass through Electron, end to end (#392): git, spawned by the main
// process, runs the app's GIT_ASKPASS helper, which is the app's own binary
// run as Node (`ELECTRON_RUN_AS_NODE` with `process.execPath`). The helper asks
// the main process's askpass server, which routes the question to the
// instance's `Prompts.input`, asked in the page's host prompt overlay. The
// answer goes back the same way to git, which sends it to the remote. The
// Electron run here is the one in node_modules, whose fuses are all on: this
// catches a helper that cannot run, not a RunAsNode fuse turned off, until
// phase E points `executablePath` at the packaged app (ADR-0032).

/** What the page's failure report leaves in the log (graph.spec.ts). */
const WEBVIEW_FAILURE = /ERROR: webview |"reportError"/;

let scratch: string;
let env: NodeJS.ProcessEnv;
let app: ElectronApplication | null = null;
/** The test's 401 remote and fixture repository, gone after it whatever happened. */
let remote: UnauthorizedRemote | null = null;
let repoPath: string | null = null;

async function launch(...args: string[]): Promise<ElectronApplication> {
  app = await launchApp(
    // English whatever the machine's locale, so the page's words can be read.
    ["--lang=en-US", APP_DIR, `--user-data-dir=${path.join(scratch, "userData")}`, ...args],
    env
  );
  return app;
}

/** Close the app and read its whole log (see graph.spec.ts for why the file). */
async function closeAndReadLog(): Promise<string> {
  await app?.close();
  app = null;
  return readFileSync(path.join(scratch, "userData", "logs", "main.log"), "utf8");
}

test.beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "ging-e2e-"));
  // No system config, an empty global one, and never the terminal: no
  // credential helper answers in the user's place, so git asks (ADR-0032).
  env = isolatedGitEnv(path.join(scratch, "home"));
});

test.afterEach(async () => {
  await app?.close();
  app = null;
  await remote?.close();
  remote = null;
  if (repoPath !== null) rmSync(repoPath, { recursive: true, force: true });
  repoPath = null;
  rmSync(scratch, { recursive: true, force: true });
});

test("a 401 asks the page for a username, then a masked password, and git tries them", async () => {
  remote = await startUnauthorizedRemote();
  const { requests } = remote;
  const repo: FixtureRepo = makeFixtureRepo(env);
  repoPath = repo.path;
  execFileSync("git", ["remote", "add", "origin", remote.url], { cwd: repo.path, env });
  const host = new URL(remote.url).host;

  // The graph is in the Tab the repository opened in (#393), not the window's page.
  const page = await focusedTabPage(await launch("--repo", repo.path));
  await expect(page.locator("#commitTable tr.commit")).toHaveCount(repo.commits.length);

  // The graph's own Fetch, as a user clicks it: its progress dialog is up
  // while git waits on the credentials.
  await page.locator("#fetchBtn").click();
  const progress = page.locator("#dialog #actionRunning");
  const overlay = page.locator("#hostPrompt");
  const title = page.locator("#hostPromptTitle");
  const input = page.locator("#hostPromptInput");

  // git asks for the username first, of the remote's URL. The helper hands
  // over git's prompt (`Username for '<url>': `) as the request's first
  // word and the URL inside the quotes.
  await expect(overlay).toBeVisible();
  await expect(title).toHaveText(`GING: http://${host}`);
  await expect(input).toHaveAttribute("placeholder", "Username");
  await expect(input).toHaveAttribute("type", "text");
  await expect(input).toBeFocused();
  // Over the progress dialog, not in its place (ADR-0031).
  await expect(progress).toBeAttached();
  await page.keyboard.type("alice");
  await page.keyboard.press("Enter");

  // Then the password, of the URL now carrying that username; this one alone
  // is masked.
  await expect(input).toHaveAttribute("placeholder", "Password");
  await expect(title).toHaveText(`GING: http://alice@${host}`);
  await expect(input).toHaveAttribute("type", "password");
  await expect(input).toBeFocused();
  await page.keyboard.type("s3cret");
  await page.keyboard.press("Enter");
  await expect(overlay).toBeHidden();

  // Turned away again, git gives up: the fetch ends in the graph's error box.
  // git's own words are its business, not this test's.
  const dialog = page.locator("#dialog");
  await expect(dialog).toContainText("Unable to fetch");
  await expect(dialog.locator(".errorReason")).toBeVisible();
  await expect(progress).toHaveCount(0);

  // The remote saw git retry with credentials, and every time they were the
  // ones typed in the page. How many retries is git's: 2.40.1 makes one, but
  // nothing here is about that count, so another git version may differ.
  const retries = requests.filter(
    (request) => request.url.includes("/info/refs") && request.authorization !== undefined
  );
  expect(retries.length).toBeGreaterThanOrEqual(1);
  expect(new Set(retries.map((request) => request.authorization))).toEqual(
    new Set([`Basic ${Buffer.from("alice:s3cret").toString("base64")}`])
  );

  expect(await closeAndReadLog()).not.toMatch(WEBVIEW_FAILURE);
});
