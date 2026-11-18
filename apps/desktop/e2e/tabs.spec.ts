import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";

import {
  _electron,
  type ElectronApplication,
  expect,
  type Locator,
  type Page,
  test
} from "@playwright/test";

import { TAB_STRIP_HEIGHT } from "@ging/webview/desktop/window/protocol";

import { type FixtureRepo, isolatedGitEnv, makeFixtureRepo } from "./fixtureRepo";
import { clickMenu } from "./mainProcess";
import { focusedTabPage, stripTabs, tabPage, windowPage } from "./tabPages";

// The desktop window's Tabs (#393): a repository per Tab, at most one Tab per
// repository, the list kept across restarts, and each Tab's prompts asked in
// its own page. Read through the pages, Electron's own API and the app's log
// (ADR-0032).

/** The app as `electron .` runs it: package.json's `main`, built into out/. */
const APP_DIR = path.resolve(__dirname, "..");
/** In Node, the `electron` package is the path to its binary. */
const ELECTRON = require("electron") as unknown as string;
const FETCH_REMOTE = "ging.fetchRemote";

let scratch: string;
let env: NodeJS.ProcessEnv;
let app: ElectronApplication | null = null;
let cleanUp: string[] = [];

/** The arguments a launch of this app gives Electron, after its own switches:
 *  English, and this test's user data folder, so a later launch is a restart
 *  or a second instance of the same app. */
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
  // Playwright adds --no-sandbox to the launch it makes on Linux; this one
  // needs it the same way (ADR-0032).
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

/** A fixture repository for this test, removed after it. */
function fixtureRepo(): FixtureRepo {
  const repo = makeFixtureRepo(env);
  cleanUp.push(repo.path);
  return repo;
}

/** `repo`'s path as git spells it — forward slashes on Windows too — which
 *  is how the app knows every repository (`repoToOpen`). */
function spelled(repo: FixtureRepo): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo.path, env })
    .toString()
    .trim();
}

/** Every message box the app shows, answered in its place (ADR-0032). */
async function answerMessageBoxes(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({
      response: 0,
      checkboxChecked: false
    })) as typeof dialog.showMessageBox;
  });
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

test("two repositories open in two Tabs, and opening the first again focuses its Tab", async () => {
  const [first, second] = [fixtureRepo(), fixtureRepo()];
  const electronApp = await launch("--repo", first.path);
  const window = await windowPage(electronApp);
  const firstPage = await focusedTabPage(electronApp);
  await expect(firstPage.locator("#repoTitleName")).toHaveText(path.basename(first.path));

  await launchAgain("--repo", second.path);
  const secondPage = await focusedTabPage(electronApp, 2);
  await expect(secondPage.locator("#repoTitleName")).toHaveText(path.basename(second.path));
  await expect(secondPage.locator("#commitTable tr.commit")).toHaveCount(second.commits.length);
  const [firstTab, secondTab] = await stripTabs(window);
  expect([firstTab, secondTab]).toEqual([
    { id: firstTab.id, title: path.basename(first.path), focused: false },
    { id: secondTab.id, title: path.basename(second.path), focused: true }
  ]);

  // The first again, named by a folder inside it: no third Tab, its own in front.
  const inside = path.join(first.path, "sub");
  mkdirSync(inside);
  await launchAgain("--repo", inside);
  await expect
    .poll(() => stripTabs(window))
    .toEqual([
      { ...firstTab, focused: true },
      { ...secondTab, focused: false }
    ]);
  expect(await focusedTabPage(electronApp, 2)).toBe(firstPage);
  // Its view alone in the window, below the strip; the other one out of it.
  // (Not read from `document.visibilityState`: under Playwright, a page whose
  // view is out of the window still answers "visible".)
  const inWindow = () =>
    electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].contentView.children.map((view) => ({
        url: (view as Electron.WebContentsView).webContents.getURL(),
        top: view.getBounds().y
      }))
    );
  expect(await inWindow()).toEqual([{ url: firstPage.url(), top: TAB_STRIP_HEIGHT }]);
  expect(secondPage.url()).not.toBe(firstPage.url());

  const logged = await closeAndReadLog();
  expect(logged).not.toContain("ERROR:");
});

test("the Tabs come back after a restart, in order, the focused one in front", async () => {
  const [first, second] = [fixtureRepo(), fixtureRepo()];
  let electronApp = await launch("--repo", first.path);
  await focusedTabPage(electronApp);
  await launchAgain("--repo", second.path);
  let window = await windowPage(electronApp);
  await expect(window.locator("#tabStrip .tab")).toHaveCount(2);

  // Brought forward from the strip, as a user would.
  await window.locator("#tabStrip .tab", { hasText: path.basename(first.path) }).click();
  await expect(window.locator("#tabStrip .tab.focused")).toHaveText(path.basename(first.path));
  await closeAndReadLog();

  electronApp = await launch();
  window = await windowPage(electronApp);
  await expect
    .poll(async () => (await stripTabs(window)).map(({ title, focused }) => ({ title, focused })))
    .toEqual([
      { title: path.basename(first.path), focused: true },
      { title: path.basename(second.path), focused: false }
    ]);
  const page = await focusedTabPage(electronApp, 2);
  await expect(page.locator("#commitTable tr.commit")).toHaveCount(first.commits.length);
  const logged = await closeAndReadLog();
  expect(logged).toContain(`tabs: restoring ${spelled(first)}`);
  expect(logged).not.toContain("ERROR:");
});

test("a Tab whose folder has gone comes back saying so, until it is closed", async () => {
  const [kept, gone] = [fixtureRepo(), fixtureRepo()];
  let electronApp = await launch("--repo", kept.path);
  await focusedTabPage(electronApp);
  await launchAgain("--repo", gone.path);
  await focusedTabPage(electronApp, 2);
  await closeAndReadLog();
  const goneSpelled = spelled(gone);
  rmSync(gone.path, { recursive: true, force: true });

  electronApp = await launch();
  let window = await windowPage(electronApp);
  await expect(window.locator("#tabStrip .tab")).toHaveCount(2);
  const goneTab = window.locator("#tabStrip .tab", { hasText: path.basename(gone.path) });
  await goneTab.click();
  const page = await focusedTabPage(electronApp, 2);
  await expect(page.locator("p")).toHaveText(
    `Cannot open ${goneSpelled}: it is not a Git repository.`
  );
  await goneTab.locator(".tabClose").click();
  await expect(window.locator("#tabStrip .tab")).toHaveCount(1);
  expect(await closeAndReadLog()).toContain(`tabs: cannot restore ${goneSpelled}`);

  electronApp = await launch();
  window = await windowPage(electronApp);
  expect((await stripTabs(window)).map(({ title }) => title)).toEqual([path.basename(kept.path)]);
});

test("closing the last Tab shows the Welcome page, with nothing to run the graph's commands on", async () => {
  const repo = fixtureRepo();
  const electronApp = await launch("--repo", repo.path);
  const window = await windowPage(electronApp);
  await focusedTabPage(electronApp);
  expect(
    await electronApp.evaluate(
      ({ Menu }, id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.enabled,
      FETCH_REMOTE
    )
  ).toBe(true);

  await window.locator("#tabStrip .tab .tabClose").click();

  await expect(window.locator("#tabStrip")).toBeHidden();
  await expect(window.locator("#welcome")).toBeVisible();
  await expect.poll(() => electronApp.windows().length).toBe(1);
  expect(
    await electronApp.evaluate(
      ({ Menu }, id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.enabled,
      FETCH_REMOTE
    )
  ).toBe(false);
  expect(await closeAndReadLog()).not.toContain("ERROR:");
});

/** A git server on this machine that asks for credentials and takes none:
 *  every request is answered 401 (ADR-0032). It keeps the credentials each
 *  request came with, decoded. */
async function serverAskingForCredentials() {
  const received: string[] = [];
  /** The connections git has open to it: a git waiting on its prompt keeps
   *  one, and lets it go once it is done. */
  const connections = new Set<Socket>();
  const server = http.createServer((request, response) => {
    const auth = request.headers.authorization;
    if (auth?.startsWith("Basic ")) {
      received.push(Buffer.from(auth.slice("Basic ".length), "base64").toString());
    }
    response.writeHead(401, { "WWW-Authenticate": 'Basic realm="ging-e2e"' });
    response.end();
  });
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/repo.git`,
    /** How the askpass prompt names it: `GING: <host>`, the user name in
     *  the host when git asks for the password. */
    asking: new RegExp(`^GING: http://(\\w+@)?127\\.0\\.0\\.1:${port}`),
    received,
    /** How many connections git still has open. */
    openConnections: () => connections.size,
    close: () =>
      new Promise<void>((resolve) => {
        // A workaround, not what the app should leave behind: a test that
        // fails while git is still on the network leaves that git running,
        // since closing a Tab or the app does not stop the git it started
        // (#450). Without this, the server never closes and the test hangs.
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

/** Start a fetch in Tab `tab` from the menu, and wait for git's question for
 *  a username in its page. */
async function fetchAsking(
  electronApp: ElectronApplication,
  tab: Locator,
  page: Page,
  asking: RegExp
): Promise<void> {
  await tab.click();
  await expect(tab).toContainClass("focused");
  expect(await clickMenu(electronApp, FETCH_REMOTE)).toBe(true);
  await expect(credentialPrompt(page).message).toHaveText(asking);
}

/** The credential prompt shown in `page`: what it names, and its field. */
function credentialPrompt(page: Page) {
  return {
    message: page.locator("#hostPrompt .hostPromptMessage"),
    field: page.locator("#hostPromptInput")
  };
}

/** Answer the prompt in `page` asking for `what` of the server `asking`
 *  names, with `text`. */
async function answer(
  page: Page,
  asking: RegExp,
  what: "Username" | "Password",
  text: string
): Promise<void> {
  const { message, field } = credentialPrompt(page);
  await expect(message).toHaveText(asking);
  await expect(field).toHaveAttribute("placeholder", new RegExp(what));
  await field.fill(text);
  await field.press("Enter");
}

test("two Tabs fetching from servers that ask for credentials each ask in their own page", async () => {
  const servers = [await serverAskingForCredentials(), await serverAskingForCredentials()];
  try {
    const repos = [fixtureRepo(), fixtureRepo()];
    repos.forEach((repo, i) =>
      execFileSync("git", ["remote", "add", "origin", servers[i].url], { cwd: repo.path, env })
    );
    const electronApp = await launch("--repo", repos[0].path);
    await answerMessageBoxes(electronApp);
    const window = await windowPage(electronApp);
    const firstPage = await focusedTabPage(electronApp);
    await expect(firstPage.locator("#commitTable tr.commit")).toHaveCount(repos[0].commits.length);
    await launchAgain("--repo", repos[1].path);
    const secondPage = await focusedTabPage(electronApp, 2);
    await expect(secondPage.locator("#commitTable tr.commit")).toHaveCount(repos[1].commits.length);
    const [firstTab, secondTab] = await window.locator("#tabStrip .tab").all();

    // The menu's fetch runs in the focused Tab: the first, then the second,
    // each fetch left waiting on git's question for a username.
    await fetchAsking(electronApp, firstTab, firstPage, servers[0].asking);
    await fetchAsking(electronApp, secondTab, secondPage, servers[1].asking);

    // Each asked in its own page only — one prompt there, its own server's —
    // and only the Tab behind is marked in the strip as asking: the one in
    // front shows its prompt itself.
    await expect(credentialPrompt(firstPage).message).toHaveCount(1);
    await expect(credentialPrompt(firstPage).message).toHaveText(servers[0].asking);
    await expect(firstTab.locator(".tabAsking")).toHaveCount(1);
    await expect(secondTab.locator(".tabAsking")).toHaveCount(0);

    // Answered in each page, and each answer reaches its own Tab's git.
    await answer(secondPage, servers[1].asking, "Username", "bob");
    await answer(secondPage, servers[1].asking, "Password", "secret-b");
    await firstTab.click();
    await expect(firstTab.locator(".tabAsking")).toHaveCount(0);
    await answer(firstPage, servers[0].asking, "Username", "alice");
    await answer(firstPage, servers[0].asking, "Password", "secret-a");
    await expect.poll(() => servers[0].received).toEqual(["alice:secret-a"]);
    await expect.poll(() => servers[1].received).toEqual(["bob:secret-b"]);
    await expect(window.locator("#tabStrip .tabAsking")).toHaveCount(0);
  } finally {
    await Promise.all(servers.map((server) => server.close()));
    await app?.close();
    app = null;
  }
});

/** A fixture repository whose `origin` is `server`. */
function repoFetchingFrom(server: { url: string }): FixtureRepo {
  const repo = fixtureRepo();
  execFileSync("git", ["remote", "add", "origin", server.url], { cwd: repo.path, env });
  return repo;
}

test("closing a Tab while its git waits on a prompt lets that git go", async () => {
  const server = await serverAskingForCredentials();
  try {
    const repo = repoFetchingFrom(server);
    const electronApp = await launch("--repo", repo.path);
    await answerMessageBoxes(electronApp);
    const window = await windowPage(electronApp);
    const page = await focusedTabPage(electronApp);
    await expect(page.locator("#commitTable tr.commit")).toHaveCount(repo.commits.length);
    const tab = window.locator("#tabStrip .tab");
    await fetchAsking(electronApp, tab, page, server.asking);
    expect(server.openConnections()).toBeGreaterThan(0);

    await tab.locator(".tabClose").click();

    // The prompt answered as dismissed: git is done, and so is its connection.
    await expect(window.locator("#tabStrip")).toBeHidden();
    await expect.poll(server.openConnections, { timeout: 15_000 }).toBe(0);
    expect(await closeAndReadLog()).not.toContain("ERROR:");
  } finally {
    await app?.close();
    app = null;
    await server.close();
  }
});

test("quitting while a Tab's git waits on a prompt quits, and lets that git go", async () => {
  const server = await serverAskingForCredentials();
  try {
    const repos = [repoFetchingFrom(server), fixtureRepo()];
    const electronApp = await launch("--repo", repos[0].path);
    await answerMessageBoxes(electronApp);
    const window = await windowPage(electronApp);
    const page = await focusedTabPage(electronApp);
    await expect(page.locator("#commitTable tr.commit")).toHaveCount(repos[0].commits.length);
    // A second Tab, so the one asking is not the last to be disposed of.
    await launchAgain("--repo", repos[1].path);
    await focusedTabPage(electronApp, 2);
    await fetchAsking(electronApp, window.locator("#tabStrip .tab").first(), page, server.asking);

    // Closing the app waits for its process to exit.
    const logged = await closeAndReadLog();
    await expect.poll(server.openConnections, { timeout: 15_000 }).toBe(0);
    expect(logged).not.toContain("ERROR:");

    // Both Tabs are still what the next session opens.
    const reopened = await windowPage(await launch());
    await expect(reopened.locator("#tabStrip .tab")).toHaveCount(2);
  } finally {
    await app?.close();
    app = null;
    await server.close();
  }
});

test("a Tab's page asking for another Tab's repository stays on its own", async () => {
  const [first, second] = [fixtureRepo(), fixtureRepo()];
  const electronApp = await launch("--repo", first.path);
  const window = await windowPage(electronApp);
  const firstPage = await focusedTabPage(electronApp);
  await launchAgain("--repo", second.path);
  await focusedTabPage(electronApp, 2);
  await window.locator("#tabStrip .tab").first().click();

  // Shown its own repository alone: no repo dropdown to pick another from.
  await expect(firstPage.locator("#repoTitleName")).toHaveText(path.basename(first.path));
  await expect(firstPage.locator("#repoTitle")).not.toContainClass("multipleRepos");
  // And a page that asks all the same, as the graph's own selectRepo would.
  await firstPage.evaluate((repo) => {
    (globalThis as unknown as { acquireVsCodeApi(): { postMessage(m: unknown): void } })
      .acquireVsCodeApi()
      .postMessage({ command: "selectRepo", repo });
  }, spelled(second));
  await firstPage.locator("#refreshBtn").click();
  await expect(firstPage.locator("#commitTable tr.commit")).toHaveCount(first.commits.length);

  const logged = await closeAndReadLog();
  expect(logged).toContain(
    `tabs: the Tab on ${spelled(first)} stays on it, not ${spelled(second)}`
  );
  expect(logged).not.toContain("ERROR:");
  // Each Tab still on its own repository after a restart.
  const reopened = await windowPage(await launch());
  await expect
    .poll(async () => (await stripTabs(reopened)).map(({ title }) => title))
    .toEqual([path.basename(first.path), path.basename(second.path)]);
});

test("a Tab's page reloaded keeps its Tab and its graph", async () => {
  const repo = fixtureRepo();
  const electronApp = await launch("--repo", repo.path);
  const page = await focusedTabPage(electronApp);
  await expect(page.locator("#commitTable tr.commit")).toHaveCount(repo.commits.length);

  await page.reload();

  await expect(page.locator("#commitTable tr.commit")).toHaveCount(repo.commits.length);
  expect(await tabPage(electronApp, Number(new URL(page.url()).searchParams.get("id")))).toBe(page);
  expect(await closeAndReadLog()).not.toContain("ERROR:");
});
