import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { _electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";

import { type FixtureRepo, isolatedGitEnv, makeFixtureRepo } from "./fixtureRepo";
import {
  clickMenu,
  menuEnabled,
  putTerminalOnPath,
  standInTerminals,
  terminalsStarted
} from "./mainProcess";
import { focusedTabPage, windowPage } from "./tabPages";

// The application menu, the desktop host's entry to core's command services
// (#396). Each entry is triggered as the E2E can — `getMenuItemById(id).click()`
// in the main process, which hands the click no window and does not check
// `enabled`, so `enabled` is read beside it — and what it did is read where
// the product shows it: the focused Tab's page, the Welcome page, a window of
// its own, a system dialog answered in its place (ADR-0032). Accelerators are
// the template's, held by appMenu.test.ts.

const APP_DIR = path.resolve(__dirname, "..");
/** In Node, the `electron` package is the path to its binary. */
const ELECTRON = require("electron") as unknown as string;

/** The graph's entries: none has anything to run on without a graph. */
const GRAPH_ENTRIES = [
  "ging.fetch",
  "ging.fetchRemote",
  "ging.manageRemotes",
  "ging.toggleRemoteVisibility",
  "ging.viewReflog",
  "ging.showStatistics",
  "ging.openTerminal"
];

let scratch: string;
let env: NodeJS.ProcessEnv;
let app: ElectronApplication | null = null;
let cleanUp: string[] = [];

/** English, and this test's user data folder, after Electron's own switches. */
const appArgs = (...args: string[]) => [
  "--lang=en-US",
  APP_DIR,
  `--user-data-dir=${path.join(scratch, "userData")}`,
  ...args
];

async function launch(...args: string[]): Promise<ElectronApplication> {
  app = await _electron.launch({
    executablePath: ELECTRON,
    args: appArgs(...args),
    env: env as Record<string, string>
  });
  return app;
}

/** Launch the app again while it runs: the second instance hands its command
 *  line to the first, which opens it in a Tab, and exits (#386). */
async function launchAgain(...args: string[]): Promise<void> {
  const sandbox = process.platform === "linux" ? ["--no-sandbox"] : [];
  const second = spawn(ELECTRON, [...sandbox, ...appArgs(...args)], { env, stdio: "ignore" });
  expect(await new Promise((resolve) => second.on("exit", resolve))).toBe(0);
}

function fixtureRepo(): FixtureRepo {
  const repo = makeFixtureRepo(env);
  cleanUp.push(repo.path);
  return repo;
}

/** Every message box the app shows is dismissed — its cancel button, or its
 *  only one — and kept, as the app put it, for `askedBoxes` to read
 *  (ADR-0032). Dismissed, so Version Information's Copy leaves the machine's
 *  clipboard alone. */
async function answerMessageBoxes(electronApp: ElectronApplication) {
  await electronApp.evaluate(({ dialog }) => {
    const asked: unknown[] = [];
    (globalThis as Record<string, unknown>).askedBoxes = asked;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { cancelId?: number };
      asked.push(options);
      return { response: options.cancelId ?? 0, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
  return () =>
    electronApp.evaluate(
      () => (globalThis as Record<string, unknown>).askedBoxes as { message: string }[]
    );
}

/** Close the app and read its whole log (see graph.spec.ts for why the file). */
async function closeAndReadLog(): Promise<string> {
  await app?.close();
  app = null;
  return readFileSync(path.join(scratch, "userData", "logs", "main.log"), "utf8");
}

/** The page at `url`, once there is one. */
async function pageAtUrl(electronApp: ElectronApplication, url: string): Promise<Page> {
  const find = () => electronApp.windows().find((page) => page.url() === url);
  await expect.poll(() => find() !== undefined).toBe(true);
  return find()!;
}

test.beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "ging-e2e-"));
  env = isolatedGitEnv(path.join(scratch, "home"));
  cleanUp = [];
});

test.afterEach(async () => {
  await app?.close();
  app = null;
  [scratch, ...cleanUp].forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

test("View Reflog runs on the focused Tab and asks in its page, not in the other Tab's", async () => {
  const [first, second] = [fixtureRepo(), fixtureRepo()];
  const electronApp = await launch("--repo", first.path);
  const window = await windowPage(electronApp);
  const firstPage = await focusedTabPage(electronApp);
  await launchAgain("--repo", second.path);
  const secondPage = await focusedTabPage(electronApp, 2);
  await expect(secondPage.locator("#commitTable tr.commit")).toHaveCount(second.commits.length);

  // Back to the first: the menu's target is the Tab in front when clicked.
  // A click on the strip only asks: the strip marks the Tab focused once the
  // main process has made it so (#393), which is what the menu reads.
  await window.locator("#tabStrip .tab", { hasText: path.basename(first.path) }).click();
  await expect(window.locator("#tabStrip .tab.focused .tabTitle")).toHaveText(
    path.basename(first.path)
  );
  expect(await focusedTabPage(electronApp, 2)).toBe(firstPage);
  expect(await clickMenu(electronApp, "ging.viewReflog")).toBe(true);

  const overlay = firstPage.locator("#hostPrompt");
  await expect(overlay).toBeVisible();
  await expect(overlay.locator(".hostPromptItem").first()).toContainText("Third commit");
  await expect(secondPage.locator("#hostPrompt")).toHaveCount(0);
  await firstPage.keyboard.press("Escape");
  await expect(overlay).toBeHidden();

  expect(await closeAndReadLog()).not.toMatch(/ERROR:|"reportError"/);
});

test("Show Statistics opens a window of its own on the focused Tab's figures", async () => {
  const repo = fixtureRepo();
  const electronApp = await launch("--repo", repo.path);
  await focusedTabPage(electronApp);

  expect(await clickMenu(electronApp, "ging.showStatistics")).toBe(true);

  const stats = await pageAtUrl(electronApp, "ging://app/statistics");
  await expect(stats.locator(".row .name")).toHaveText(["Alice"]);
  await expect(stats.locator(".row .count")).toHaveText([`${repo.commits.length} (100.0%)`]);
  await expect
    .poll(() =>
      electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((win) => win.getTitle())
      )
    )
    .toContain(`Repository Statistics - ${path.basename(repo.path)}`);
  // In the app's theme: the variables are on the page, as on every other.
  expect(
    await stats.evaluate(() =>
      document.documentElement.style.getPropertyValue("--vscode-charts-blue")
    )
  ).not.toBe("");

  expect(await closeAndReadLog()).not.toMatch(/ERROR:/);
});

test("Open in Terminal starts the system's terminal in the focused Tab's repository", async () => {
  const repo = fixtureRepo();
  // On Linux the app looks its terminal up on the PATH's absolute folders, and
  // a CI machine may have none: one put first there. It is never run — the
  // spawn is stood in for, below.
  if (process.platform === "linux") putTerminalOnPath(env, scratch);

  const electronApp = await launch("--repo", repo.path);
  await focusedTabPage(electronApp);
  // No terminal opens (ADR-0032).
  await standInTerminals(electronApp);

  expect(await clickMenu(electronApp, "ging.openTerminal")).toBe(true);

  await expect
    .poll(() => terminalsStarted(electronApp))
    .toEqual([{ cwd: realpathSync.native(repo.path) }]);
  expect(await closeAndReadLog()).not.toMatch(/ERROR:/);
});

test("with no Tab, the graph's entries are not offered, and Set Git User Details asks on the Welcome page", async () => {
  const electronApp = await launch();
  const window = await windowPage(electronApp);
  await expect(window.locator("#welcome")).toBeVisible();
  const askedBoxes = await answerMessageBoxes(electronApp);

  const offered = await Promise.all(GRAPH_ENTRIES.map((id) => menuEnabled(electronApp, id)));
  expect(offered).toEqual(GRAPH_ENTRIES.map(() => false));
  expect(await clickMenu(electronApp, "ging.setGitUserDetails")).toBe(true);

  // No repository, so for every one: the global identity, in the isolated home.
  const input = window.locator("#hostPromptInput");
  await expect(input).toBeFocused();
  await input.fill("Carol");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await input.fill("carol@example.com");
  await input.press("Enter");
  const rows = window.locator("#hostPrompt .hostPromptItem");
  await expect(rows).toHaveText(["All Repositories (global)"]);
  await window.keyboard.press("Enter");
  await expect(window.locator("#hostPrompt")).toBeHidden();

  await expect
    .poll(() => askedBoxes())
    .toEqual([expect.objectContaining({ message: "Git user details updated." })]);
  const globalConfig = readFileSync(path.join(scratch, "home", ".gitconfig"), "utf8");
  expect(globalConfig).toContain("name = Carol");
  expect(globalConfig).toContain("email = carol@example.com");
  expect(await closeAndReadLog()).not.toMatch(/ERROR:/);
});

test("with a Tab whose folder has gone in front, nothing that asks is offered, and Version Information still answers", async () => {
  const repo = fixtureRepo();
  let electronApp = await launch("--repo", repo.path);
  await focusedTabPage(electronApp);
  await closeAndReadLog();
  rmSync(repo.path, { recursive: true, force: true });

  // Brought back saying why it shows no graph: no instance to run a command,
  // no listener to ask on, and the Welcome page under it out of sight.
  electronApp = await launch();
  const page = await focusedTabPage(electronApp);
  await expect(page.locator("p")).toContainText("not a Git repository");
  const askedBoxes = await answerMessageBoxes(electronApp);

  const offered = await Promise.all(
    [...GRAPH_ENTRIES, "ging.setGitUserDetails", "ging.managePullRequestProviders"].map((id) =>
      menuEnabled(electronApp, id)
    )
  );
  expect(offered.every((value) => value === false)).toBe(true);
  // A system dialog needs no page.
  expect(await clickMenu(electronApp, "ging.versionInfo")).toBe(true);
  await expect
    .poll(async () => (await askedBoxes()).map((box) => box.message))
    .toEqual([
      expect.stringMatching(/^GING: .+\nElectron: .+\nChromium: .+\nOS: .+\ngit version /)
    ]);
  expect(await closeAndReadLog()).not.toMatch(/ERROR:/);
});

test("Version Information lists GING's, Electron's and git's versions in a system dialog", async () => {
  const electronApp = await launch();
  await windowPage(electronApp);
  const askedBoxes = await answerMessageBoxes(electronApp);

  expect(await clickMenu(electronApp, "ging.versionInfo")).toBe(true);

  await expect
    .poll(async () => (await askedBoxes()).map((box) => box.message))
    .toEqual([
      expect.stringMatching(/^GING: .+\nElectron: .+\nChromium: .+\nOS: .+\ngit version /)
    ]);
  expect(await closeAndReadLog()).not.toMatch(/ERROR:/);
});
