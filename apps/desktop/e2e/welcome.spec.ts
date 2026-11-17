import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { _electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";

import { type FixtureRepo, isolatedGitEnv, makeFixtureRepo } from "./fixtureRepo";
import { focusedTabPage, stripTabs, windowPage } from "./tabPages";

// The Welcome page's Open Folder and Initialize Repository, the menu's, and
// the recently opened list (#394). The system's folder dialog cannot be
// clicked, so it is answered in its place through the seam the main process
// looks it up by (ADR-0032); the rest is read from the pages and the log.

/** The app as `electron .` runs it: package.json's `main`, built into out/. */
const APP_DIR = path.resolve(__dirname, "..");
/** In Node, the `electron` package is the path to its binary. */
const ELECTRON = require("electron") as unknown as string;
const OPEN_FOLDER = "ging.openFolder";
const OPEN_RECENT = "ging.openRecent";
const INIT_REPOSITORY = "ging.initRepository";

/** The menu entry `id`, clicked as the menu Electron built would click it,
 *  and whether it was enabled (a direct click does not check). */
function clickMenu(electronApp: ElectronApplication, id: string): Promise<boolean | null> {
  return electronApp.evaluate(({ Menu }, wanted) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(wanted);
    item?.click();
    return item ? item.enabled : null;
  }, id);
}

let scratch: string;
let env: NodeJS.ProcessEnv;
let app: ElectronApplication | null = null;
let cleanUp: string[] = [];

/** English, and this test's user data folder: a later launch is a restart or
 *  a second instance of the same app. */
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
 *  line to the first and exits (#386). */
async function launchAgain(...args: string[]): Promise<void> {
  const sandbox = process.platform === "linux" ? ["--no-sandbox"] : [];
  const second = spawn(ELECTRON, [...sandbox, ...appArgs(...args)], { env, stdio: "ignore" });
  expect(await new Promise((resolve) => second.on("exit", resolve))).toBe(0);
}

/** Close the app, once it has written its log out, and read the log. */
async function closeAndReadLog(): Promise<string> {
  await app?.close();
  app = null;
  return readFileSync(path.join(scratch, "userData", "logs", "main.log"), "utf8");
}

function fixtureRepo(): FixtureRepo {
  const repo = makeFixtureRepo(env);
  cleanUp.push(repo.path);
  return repo;
}

/** `folder`'s repository as git spells it, which is how the app knows it. */
function spelled(folder: string): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: folder, env })
    .toString()
    .trim();
}

/** The folder dialog answered with `folder` from now on, each time it is
 *  asked; what it was asked with is kept, to be read by `folderDialogs`. */
async function answerFolderDialog(electronApp: ElectronApplication, folder: string): Promise<void> {
  await electronApp.evaluate(({ dialog }, answer) => {
    const asked: unknown[] = [];
    (globalThis as Record<string, unknown>).askedFolders = asked;
    dialog.showOpenDialog = (async (...args: unknown[]) => {
      asked.push(args.at(-1));
      return { canceled: false, filePaths: [answer] };
    }) as typeof dialog.showOpenDialog;
  }, folder);
}

const folderDialogs = (electronApp: ElectronApplication) =>
  electronApp.evaluate(() => (globalThis as Record<string, unknown>).askedFolders as unknown[]);

/** Every message box answered with its first button, and kept to be read. */
async function answerMessageBoxes(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ dialog }) => {
    const asked: unknown[] = [];
    (globalThis as Record<string, unknown>).askedBoxes = asked;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      asked.push(args.at(-1));
      return { response: 0, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
}

const messageBoxes = (electronApp: ElectronApplication) =>
  electronApp.evaluate(() => (globalThis as Record<string, unknown>).askedBoxes as unknown[]);

/** The recent list as the Welcome page shows it. */
function recentList(window: Page) {
  return window.locator("#welcome .recentRepo").evaluateAll((rows) =>
    rows.map((row) => ({
      name: row.querySelector(".recentName")?.textContent ?? "",
      path: row.querySelector(".recentPath")?.textContent ?? "",
      missing: row.querySelector(".recentMissing")?.textContent ?? null
    }))
  );
}

/** Close every Tab from the strip, as a user would: the Welcome page shows. */
async function closeAllTabs(window: Page): Promise<void> {
  const close = window.locator("#tabStrip .tab .tabClose");
  const count = await close.count();
  if (count === 0) {
    await expect(window.locator("#welcome .welcomeActions")).toBeVisible();
    return;
  }
  await close.first().click();
  await expect(close).toHaveCount(count - 1);
  await closeAllTabs(window);
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

test("Open Folder opens the folder's repository in a Tab, from the Welcome page and from the menu", async () => {
  const [first, second] = [fixtureRepo(), fixtureRepo()];
  const electronApp = await launch();
  const window = await windowPage(electronApp);
  await expect(window.locator("#tabStrip")).toBeHidden();

  // A folder inside the repository: its repository opens.
  const inside = path.join(first.path, "sub");
  mkdirSync(inside);
  await answerFolderDialog(electronApp, inside);
  await window.getByRole("button", { name: "Open Folder..." }).click();
  const firstPage = await focusedTabPage(electronApp);
  await expect(firstPage.locator("#commitTable tr.commit")).toHaveCount(first.commits.length);
  expect(await folderDialogs(electronApp)).toEqual([
    { properties: ["openDirectory", "createDirectory"], buttonLabel: "Open" }
  ]);

  // With a Tab covering the Welcome page, the menu's entry is the way (#396).
  await answerFolderDialog(electronApp, second.path);
  expect(await clickMenu(electronApp, OPEN_FOLDER)).toBe(true);
  const secondPage = await focusedTabPage(electronApp, 2);
  await expect(secondPage.locator("#commitTable tr.commit")).toHaveCount(second.commits.length);
  expect((await stripTabs(window)).map(({ title, focused }) => ({ title, focused }))).toEqual([
    { title: path.basename(first.path), focused: false },
    { title: path.basename(second.path), focused: true }
  ]);

  // Open Recent lists both, the last opened first; its entry for the first
  // brings that one's Tab forward.
  const [firstPath, secondPath] = [spelled(first.path), spelled(second.path)];
  await expect
    .poll(() =>
      electronApp.evaluate(
        ({ Menu }, id) =>
          Menu.getApplicationMenu()
            ?.getMenuItemById(id)
            ?.submenu?.items.map((item) => item.id),
        OPEN_RECENT
      )
    )
    .toEqual([`${OPEN_RECENT}:${secondPath}`, `${OPEN_RECENT}:${firstPath}`]);
  expect(await clickMenu(electronApp, `${OPEN_RECENT}:${firstPath}`)).toBe(true);
  await expect
    .poll(async () => (await stripTabs(window)).map(({ focused }) => focused))
    .toEqual([true, false]);

  const logged = await closeAndReadLog();
  expect(logged).toContain(`open folder: opening ${spelled(first.path)}`);
  expect(logged).toContain(`open folder: opening ${spelled(second.path)}`);
  expect(logged).not.toContain("ERROR:");
});

test("the recent list keeps what was opened across a restart, the last first, and marks a folder that has gone", async () => {
  const [kept, gone] = [fixtureRepo(), fixtureRepo()];
  const [keptPath, gonePath] = [spelled(kept.path), spelled(gone.path)];
  // Both named on a command line: that is opening them too.
  let electronApp = await launch("--repo", gone.path);
  await focusedTabPage(electronApp);
  await launchAgain("--repo", kept.path);
  let window = await windowPage(electronApp);
  await focusedTabPage(electronApp, 2);
  await closeAllTabs(window);
  await expect
    .poll(() => recentList(window))
    .toEqual([
      { name: path.basename(kept.path), path: keptPath, missing: null },
      { name: path.basename(gone.path), path: gonePath, missing: null }
    ]);
  await closeAndReadLog();
  rmSync(gone.path, { recursive: true, force: true });

  // After a restart: still listed, the one whose folder has gone said to be.
  electronApp = await launch();
  window = await windowPage(electronApp);
  await expect
    .poll(() => recentList(window))
    .toEqual([
      { name: path.basename(kept.path), path: keptPath, missing: null },
      { name: path.basename(gone.path), path: gonePath, missing: "Not found" }
    ]);
  await expect(window.locator(".recentRepo.missing")).toHaveCount(1);

  // Opening it says why it cannot, and leaves it listed; taking it off the
  // list is the user's.
  await answerMessageBoxes(electronApp);
  await window.locator(".recentOpen", { hasText: path.basename(gone.path) }).click();
  await expect
    .poll(() => messageBoxes(electronApp))
    .toEqual([
      expect.objectContaining({
        type: "error",
        detail: `Cannot open ${gonePath}: the folder is not there. Its disk may not be connected.`
      })
    ]);
  await expect(window.locator("#tabStrip")).toBeHidden();
  await expect(window.locator(".recentRepo")).toHaveCount(2);
  await window
    .locator(".recentRepo", { hasText: path.basename(gone.path) })
    .locator(".recentForget")
    .click();
  await expect.poll(() => recentList(window)).toHaveLength(1);

  // The other opens from the list.
  await window.locator(".recentOpen", { hasText: path.basename(kept.path) }).click();
  const page = await focusedTabPage(electronApp);
  await expect(page.locator("#commitTable tr.commit")).toHaveCount(kept.commits.length);
  await closeAllTabs(window);
  const logged = await closeAndReadLog();
  expect(logged).toContain(`recent: cannot open ${gonePath} (missing)`);
  expect(logged).toContain(`recent: forgetting ${gonePath}`);
  expect(logged).not.toContain("ERROR:");

  // What was taken off the list stays off it.
  window = await windowPage(await launch());
  await expect
    .poll(() => recentList(window))
    .toEqual([{ name: path.basename(kept.path), path: keptPath, missing: null }]);
});

test("Initialize Repository makes a repository in the folder chosen and opens it", async () => {
  const folder = path.join(scratch, "new-project");
  mkdirSync(folder);
  const electronApp = await launch();
  const window = await windowPage(electronApp);
  await answerFolderDialog(electronApp, folder);

  await window.getByRole("button", { name: "Initialize Repository..." }).click();

  await expect
    .poll(async () => (await stripTabs(window)).map(({ title }) => title))
    .toEqual(["new-project"]);
  expect(await folderDialogs(electronApp)).toEqual([
    { properties: ["openDirectory", "createDirectory"], buttonLabel: "Initialize" }
  ]);
  expect(existsSync(path.join(folder, ".git"))).toBe(true);
  const page = await focusedTabPage(electronApp);
  await expect(page.locator("#repoTitleName")).toHaveText("new-project");
  // A repository with no commit yet: nothing to list, nothing gone wrong.
  await expect(page.locator("#commitTable tr.commit")).toHaveCount(0);

  // With that Tab open, from the menu's entry (#396): a folder not there yet.
  const another = path.join(scratch, "another-project");
  await answerFolderDialog(electronApp, another);
  expect(await clickMenu(electronApp, INIT_REPOSITORY)).toBe(true);
  await expect
    .poll(async () => (await stripTabs(window)).map(({ title }) => title))
    .toEqual(["new-project", "another-project"]);

  const logged = await closeAndReadLog();
  expect(logged).toContain(`init: made a repository in ${spelled(folder)}`);
  expect(logged).toContain(`init: made a repository in ${spelled(another)}`);
  expect(logged).not.toContain("ERROR:");
});

test("Open Folder on a folder that is no repository offers to initialize it", async () => {
  const folder = path.join(scratch, "plain-folder");
  mkdirSync(folder);
  const electronApp = await launch();
  const window = await windowPage(electronApp);
  await answerFolderDialog(electronApp, folder);
  // The first button: Initialize Repository.
  await answerMessageBoxes(electronApp);

  await window.getByRole("button", { name: "Open Folder..." }).click();

  await expect
    .poll(async () => (await stripTabs(window)).map(({ title }) => title))
    .toEqual(["plain-folder"]);
  expect(await messageBoxes(electronApp)).toEqual([
    expect.objectContaining({
      message: `Cannot open ${folder}: it is not a Git repository.`,
      buttons: ["Initialize Repository", "Cancel"]
    })
  ]);
  const logged = await closeAndReadLog();
  expect(logged).toContain(`open folder: cannot open ${folder} (notRepository)`);
  expect(logged).toContain(`init: made a repository in ${spelled(folder)}`);
  expect(logged).not.toContain("ERROR:");
});
