import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { type ElectronApplication, expect, type Page, test } from "@playwright/test";

import { isolatedGitEnv, makeFixtureRepo } from "./fixtureRepo";
import { APP_DIR, ELECTRON, launchApp } from "./launch";
import {
  answerFolderDialog,
  answerMessageBoxes,
  clickMenu,
  folderDialogs,
  menuEnabled,
  messageBoxes
} from "./mainProcess";
import { startStallingRemote, type StallingRemote } from "./stallingRemote";
import { focusedTabPage, stripTabs, windowPage } from "./tabPages";
import { startUnauthorizedRemote, type UnauthorizedRemote } from "./unauthorizedRemote";

// Clone Repository (#395), end to end: from the Welcome page's button or the
// menu, the URL typed in the Welcome page's host prompt overlay, the folder
// answered in place of the system's dialog (ADR-0032), core's clone run by
// the main process, its progress over the Welcome page, and the repository
// opened in a Tab. The network is local only: a `file://` bare repository,
// the 401 server of #392 for credentials asked through askpass, and a server
// that never answers for a clone to cancel.

const CLONE_REPOSITORY = "ging.cloneRepository";

let scratch: string;
let env: NodeJS.ProcessEnv;
let app: ElectronApplication | null = null;
let cleanUp: string[] = [];
let servers: { close(): Promise<void> }[] = [];

async function launch(): Promise<ElectronApplication> {
  app = await launchApp(
    ["--lang=en-US", APP_DIR, `--user-data-dir=${path.join(scratch, "userData")}`],
    env
  );
  return app;
}

/** Launch the app again while it runs, naming `repo`: the second instance
 *  hands its command line to the first and exits (#386). */
async function launchAgainWith(repo: string): Promise<void> {
  const sandbox = process.platform === "linux" ? ["--no-sandbox"] : [];
  const second = spawn(
    ELECTRON,
    [
      ...sandbox,
      "--lang=en-US",
      APP_DIR,
      `--user-data-dir=${path.join(scratch, "userData")}`,
      "--repo",
      repo
    ],
    { env, stdio: "ignore" }
  );
  expect(await new Promise((resolve) => second.on("exit", resolve))).toBe(0);
}

/** Close the app, once it has written its log out, and read the log. */
async function closeAndReadLog(): Promise<string> {
  await app?.close();
  app = null;
  return readFileSync(path.join(scratch, "userData", "logs", "main.log"), "utf8");
}

/** Answer the Welcome page's URL prompt with `url`. */
async function typeUrl(window: Page, url: string): Promise<void> {
  const input = window.locator("#hostPromptInput");
  await expect(window.locator("#hostPrompt")).toBeVisible();
  await expect(input).toHaveAttribute("placeholder", "https://example.com/owner/repository.git");
  await expect(input).toBeFocused();
  await window.keyboard.type(url);
  await window.keyboard.press("Enter");
}

test.beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "ging-e2e-"));
  // No system config, an empty global one, and never the terminal: no
  // credential helper answers in the user's place, so git asks (ADR-0032).
  env = isolatedGitEnv(path.join(scratch, "home"));
  cleanUp = [];
  servers = [];
});

test.afterEach(async () => {
  await app?.close();
  app = null;
  await Promise.all(servers.map((server) => server.close()));
  [scratch, ...cleanUp].forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

test("Clone Repository clones a file:// remote into the folder chosen and opens it in a Tab", async () => {
  const fixture = makeFixtureRepo(env);
  cleanUp.push(fixture.path);
  const remote = path.join(scratch, "project.git");
  execFileSync("git", ["clone", "--bare", "--template=", fixture.path, remote], {
    env,
    stdio: "pipe"
  });
  const parent = path.join(scratch, "clones");
  mkdirSync(parent);
  const url = pathToFileURL(remote).href;

  const electronApp = await launch();
  const window = await windowPage(electronApp);
  await answerFolderDialog(electronApp, parent);
  await window.getByRole("button", { name: "Clone Repository..." }).click();
  await typeUrl(window, url);

  // The repository, in a folder named after it, in a Tab of its own.
  const page = await focusedTabPage(electronApp);
  await expect(page.locator("#commitTable tr.commit")).toHaveCount(fixture.commits.length);
  expect((await stripTabs(window)).map(({ title }) => title)).toEqual(["project"]);
  const folder = path.join(parent, "project");
  const cloned = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: folder, env })
    .toString()
    .trim();
  expect(await folderDialogs(electronApp)).toEqual([
    { properties: ["openDirectory", "createDirectory"], buttonLabel: "Clone Here" }
  ]);
  // Opened as Open Folder opens one: first in Open Recent.
  await expect
    .poll(() =>
      electronApp.evaluate(({ Menu }) =>
        Menu.getApplicationMenu()
          ?.getMenuItemById("ging.openRecent")
          ?.submenu?.items.map((item) => item.id)
      )
    )
    .toEqual([`ging.openRecent:${cloned}`]);
  // A Tab now covers the Welcome page the clone is shown on.
  expect(await menuEnabled(electronApp, CLONE_REPOSITORY)).toBe(false);

  const logged = await closeAndReadLog();
  expect(logged).toContain(`clone: ${url} into ${folder}`);
  expect(logged).toContain(`clone: cloned ${cloned}`);
  expect(logged).not.toContain("ERROR:");
});

test("a remote that asks for credentials asks on the Welcome page, and a clone it turns away leaves no folder", async () => {
  const remote: UnauthorizedRemote = await startUnauthorizedRemote();
  servers.push(remote);
  const host = new URL(remote.url).host;
  const parent = path.join(scratch, "clones");
  mkdirSync(parent);

  const electronApp = await launch();
  const window = await windowPage(electronApp);
  await answerFolderDialog(electronApp, parent);
  await answerMessageBoxes(electronApp);
  await window.getByRole("button", { name: "Clone Repository..." }).click();
  await typeUrl(window, remote.url);

  // The clone's progress is up, and git's askpass asks over it, on the
  // Welcome page: there is no Tab to ask in.
  const panel = window.locator("#clonePanel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".cloneTitle")).toHaveText(`Cloning ${remote.url}`);
  const input = window.locator("#hostPromptInput");
  await expect(window.locator("#hostPromptTitle")).toHaveText(`GING: http://${host}`);
  await expect(input).toHaveAttribute("placeholder", "Username");
  await window.keyboard.type("alice");
  await window.keyboard.press("Enter");
  await expect(input).toHaveAttribute("placeholder", "Password");
  await expect(input).toHaveAttribute("type", "password");
  await window.keyboard.type("s3cret");
  await window.keyboard.press("Enter");

  // Turned away again, git gives up: said in a box over the window, in the
  // app's words before git's own, which are git's business.
  await expect
    .poll(() => messageBoxes(electronApp))
    .toEqual([
      expect.objectContaining({
        type: "error",
        message: expect.stringMatching(/^Unable to Clone Repository: \S/)
      })
    ]);
  await expect(panel).toBeHidden();
  expect(existsSync(path.join(parent, "repo"))).toBe(false);
  await expect(window.locator("#tabStrip")).toBeHidden();
  const retries = remote.requests.filter(
    (request) => request.url.includes("/info/refs") && request.authorization !== undefined
  );
  expect(retries.length).toBeGreaterThanOrEqual(1);
  expect(new Set(retries.map((request) => request.authorization))).toEqual(
    new Set([`Basic ${Buffer.from("alice:s3cret").toString("base64")}`])
  );

  const logged = await closeAndReadLog();
  expect(logged).toContain("clone: did not clone");
  expect(logged).not.toContain("ERROR:");
});

test("Cancel stops git, every process of it, and removes the folder it made; nothing opens over the clone meanwhile", async () => {
  const remote: StallingRemote = await startStallingRemote();
  servers.push(remote);
  const fixture = makeFixtureRepo(env);
  cleanUp.push(fixture.path);
  const parent = path.join(scratch, "clones");
  mkdirSync(parent);
  const folder = path.join(parent, "repo");

  const electronApp = await launch();
  const window = await windowPage(electronApp);
  await answerFolderDialog(electronApp, parent);
  // From the menu this time: with no Tab, its entry is enabled.
  expect(await menuEnabled(electronApp, CLONE_REPOSITORY)).toBe(true);
  await clickMenu(electronApp, CLONE_REPOSITORY);
  await typeUrl(window, remote.url);

  // git has reached the remote, made the folder, and waits on an answer
  // that never comes; one clone at a time meanwhile.
  const panel = window.locator("#clonePanel");
  await expect(panel).toBeVisible();
  await expect.poll(() => remote.requests()).toBeGreaterThan(0);
  expect(existsSync(folder)).toBe(true);
  await expect.poll(() => menuEnabled(electronApp, CLONE_REPOSITORY)).toBe(false);
  // Nothing that would open a Tab over the clone's panel is offered...
  expect(
    await Promise.all(
      ["ging.openFolder", "ging.initRepository"].map((id) => menuEnabled(electronApp, id))
    )
  ).toEqual([false, false]);
  // ...and a later launch naming a repository waits for the clone.
  await launchAgainWith(fixture.path);
  await expect(window.locator("#tabStrip")).toBeHidden();
  await expect(panel).toBeVisible();

  await panel.getByRole("button", { name: "Cancel" }).click();

  await expect(panel).toBeHidden();
  await expect.poll(() => existsSync(folder)).toBe(false);
  // Nothing of git's is left holding the remote's connection.
  await expect.poll(() => remote.connections()).toBe(0);
  // What the launch named opens once the clone is done.
  await expect
    .poll(async () => (await stripTabs(window)).map(({ title }) => title))
    .toEqual([path.basename(fixture.path)]);

  const logged = await closeAndReadLog();
  expect(logged).toContain("launch: a clone is under way, opening what was named once it is done");
  expect(logged).toContain("clone: cancelling");
  expect(logged).toContain("clone: cancelled");
  expect(logged).not.toContain("ERROR:");
});
