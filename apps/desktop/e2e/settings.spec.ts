import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { _electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";

import { addAheadRemote, type FixtureRepo, isolatedGitEnv, makeFixtureRepo } from "./fixtureRepo";
import { focusedTabPage } from "./tabPages";

// The settings window (#397): opened from the menu's Settings…, writing
// through HostConfig.update, and the main process doing what VS Code does on
// a configuration change. Read through the pages, Electron's own API and the
// app's log (ADR-0032).

/** The app as `electron .` runs it: package.json's `main`, built into out/. */
const APP_DIR = path.resolve(__dirname, "..");
/** In Node, the `electron` package is the path to its binary. */
const ELECTRON = require("electron") as unknown as string;

let scratch: string;
let env: NodeJS.ProcessEnv;
let app: ElectronApplication | null = null;
let cleanUp: string[] = [];

/** Start the app on `args`, in this test's user data folder and with git kept
 *  off the developer's own configuration (ADR-0032). The same folder for
 *  every launch in a test, so a later one is a restart. */
async function launch(...args: string[]): Promise<ElectronApplication> {
  app = await _electron.launch({
    executablePath: ELECTRON,
    args: ["--lang=en-US", APP_DIR, `--user-data-dir=${path.join(scratch, "userData")}`, ...args],
    env: env as Record<string, string>
  });
  return app;
}

/** Close the app, once it has written its log out, and read the log. */
async function closeAndReadLog(): Promise<string> {
  await app?.close();
  app = null;
  return readFileSync(path.join(scratch, "userData", "logs", "main.log"), "utf8");
}

/** A fixture repository for this test, removed after it. */
function fixtureRepo(): FixtureRepo {
  const repo = makeFixtureRepo(env);
  cleanUp.push(repo.path);
  return repo;
}

/** Open the settings from the application menu's Settings… entry, found by
 *  its id as #390's E2E finds its own (ADR-0032); its accelerator is the
 *  template's, tested in appMenu.test.ts. */
async function openSettings(electronApp: ElectronApplication): Promise<Page> {
  const opened = electronApp.waitForEvent("window");
  expect(
    await electronApp.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById("ging.settings");
      item?.click();
      return item ? { enabled: item.enabled, accelerator: item.accelerator } : null;
    })
  ).toEqual({ enabled: true, accelerator: "CmdOrCtrl+," });
  const settings = await opened;
  await expect(settings.locator("html")).toHaveAttribute("data-ging-page", "settings");
  return settings;
}

/** A setting's row on the settings page, by its key. */
const row = (settings: Page, key: string) => settings.locator(`[id="${key}"]`);

test.beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "ging-e2e-"));
  env = isolatedGitEnv(path.join(scratch, "home"));
  cleanUp = [];
});

test.afterEach(async () => {
  await app?.close();
  app = null;
  for (const dir of [scratch, ...cleanUp]) rmSync(dir, { recursive: true, force: true });
});

test("a change to the auto-fetch interval takes effect without a restart", async () => {
  // The shortest interval the setting allows is a minute, and the fetch is
  // to be seen within it.
  test.setTimeout(150_000);
  const repo = fixtureRepo();
  const remote = addAheadRemote(repo, env);
  cleanUp.push(remote.path);
  const remoteMain = () =>
    execFileSync("git", ["rev-parse", "refs/remotes/origin/main"], { cwd: repo.path, env })
      .toString()
      .trim();
  expect(remoteMain()).not.toBe(remote.aheadCommit);

  const electronApp = await launch("--repo", repo.path);
  const graph = await focusedTabPage(electronApp);
  await expect(graph.locator("#commitTable tr.commit").first()).toBeVisible();
  const settings = await openSettings(electronApp);

  await row(settings, "ging-git-view.autoFetch.enabled").locator("input[type=checkbox]").check();
  const interval = row(settings, "ging-git-view.autoFetch.intervalMinutes").locator("input");
  await interval.fill("1");
  await interval.press("Tab");
  // Each saved, as the page shows once the host has answered.
  await expect(interval).toHaveValue("1");
  await expect(settings.locator(".settingError:visible")).toHaveCount(0);

  // Nothing restarted: the same pages — the window's, the Tab's and the
  // settings' — and a fetch within the new minute.
  await expect.poll(remoteMain, { timeout: 75_000, intervals: [1_000] }).toBe(remote.aheadCommit);
  expect(electronApp.windows()).toHaveLength(3);

  const logged = await closeAndReadLog();
  expect(logged).toContain("settings: ging-git-view.autoFetch.enabled saved");
  expect(logged).toContain("settings: ging-git-view.autoFetch.intervalMinutes saved");
  expect(logged).not.toContain("ERROR:");
});

test("a theme chosen by hand is kept after a restart", async () => {
  const repo = fixtureRepo();
  let electronApp = await launch("--repo", repo.path);
  let graph = await focusedTabPage(electronApp);
  let settings = await openSettings(electronApp);

  await settings.locator("#ging-theme select").selectOption("light");
  await expect(graph.locator("body")).toContainClass("vscode-light");
  await expect(settings.locator("body")).toContainClass("vscode-light");

  await closeAndReadLog();
  electronApp = await launch("--repo", repo.path);
  graph = await focusedTabPage(electronApp);

  // The choice itself, not the system's theme happening to be light.
  expect(await electronApp.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("light");
  await expect(graph.locator("#commitTable tr.commit").first()).toBeVisible();
  await expect(graph.locator("body")).toContainClass("vscode-light");
  expect(
    await graph.evaluate(() =>
      document.documentElement.style.getPropertyValue("--vscode-editor-background")
    )
  ).toBe("#ffffff");
  settings = await openSettings(electronApp);
  await expect(settings.locator("body")).toContainClass("vscode-light");
  await expect(settings.locator("#ging-theme select")).toHaveValue("light");
  expect(await closeAndReadLog()).not.toContain("ERROR:");
});
