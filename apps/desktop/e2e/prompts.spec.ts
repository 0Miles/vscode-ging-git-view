import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { _electron, type ElectronApplication, expect, test } from "@playwright/test";

import { type FixtureRepo, isolatedGitEnv, makeFixtureRepo } from "./fixtureRepo";
import { focusedTabPage, windowPage } from "./tabPages";

// A question of core's command services, asked through the desktop `Prompts`
// (#390): the application menu runs `fetchRemote` in the main process, its
// `Prompts.pick` reaches the instance's page as a host prompt, the overlay
// shows it, and the row chosen there comes back to the command, which fetches
// that remote and no other.

const APP_DIR = path.resolve(__dirname, "..");
/** In Node, the `electron` package is the path to its binary. */
const ELECTRON = require("electron") as unknown as string;
const FETCH_REMOTE = "ging.fetchRemote";

let scratch: string;
let env: NodeJS.ProcessEnv;
let app: ElectronApplication | null = null;

async function launch(...args: string[]): Promise<ElectronApplication> {
  app = await _electron.launch({
    executablePath: ELECTRON,
    // English whatever the machine's locale, so the page's words can be read.
    args: ["--lang=en-US", APP_DIR, `--user-data-dir=${path.join(scratch, "userData")}`, ...args],
    env: env as Record<string, string>
  });
  return app;
}

/** The menu entry `id`, as the main process holds it. */
function menuEntry(electronApp: ElectronApplication, id: string) {
  return electronApp.evaluate(({ Menu }, wanted) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(wanted);
    return item ? { label: item.label, enabled: item.enabled } : null;
  }, id);
}

/** Close the app and read its whole log (see graph.spec.ts for why the file). */
async function closeAndReadLog(): Promise<string> {
  await app?.close();
  app = null;
  return readFileSync(path.join(scratch, "userData", "logs", "main.log"), "utf8");
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

test("a pick of core's fetchRemote is asked in the page, and fetches the remote chosen there", async () => {
  const repo: FixtureRepo = makeFixtureRepo(env);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo.path, env, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  // Two remotes, so the command has to ask which; both local bare repositories,
  // so the fetch needs no network (ADR-0032).
  for (const remote of ["origin", "upstream"]) {
    const bare = path.join(scratch, `${remote}.git`);
    git("clone", "--bare", "--quiet", repo.path, bare);
    git("remote", "add", remote, bare);
  }
  try {
    const electronApp = await launch("--repo", repo.path);
    const page = await focusedTabPage(electronApp);
    await expect(page.locator("#commitTable tr.commit")).toHaveCount(repo.commits.length);

    // Offered while a graph is shown; clicked as a user would, through the
    // menu Electron built (a direct click does not check `enabled`).
    expect(await menuEntry(electronApp, FETCH_REMOTE)).toEqual({
      label: "Fetch a Specific Remote...",
      enabled: true
    });
    await electronApp.evaluate(({ Menu }, id) => {
      Menu.getApplicationMenu()?.getMenuItemById(id)?.click();
    }, FETCH_REMOTE);

    const overlay = page.locator("#hostPrompt");
    await expect(overlay).toBeVisible();
    const rows = overlay.locator(".hostPromptItem");
    await expect(rows).toHaveText(["origin", "upstream"]);
    await expect(page.getByPlaceholder("Select a remote to fetch")).toBeFocused();
    await page.keyboard.type("up");
    await expect(rows.filter({ visible: true })).toHaveText(["upstream"]);
    await page.keyboard.press("Enter");
    await expect(overlay).toBeHidden();

    // Fetched: the remote picked, and only it.
    const tracking = (remote: string) =>
      git("for-each-ref", "--format=%(refname)", `refs/remotes/${remote}`);
    await expect.poll(() => tracking("upstream")).toContain("refs/remotes/upstream/main");
    expect(tracking("origin")).toBe("");

    const logged = await closeAndReadLog();
    expect(logged).not.toMatch(/ERROR:|"reportError"/);
  } finally {
    await app?.close();
    app = null;
    rmSync(repo.path, { recursive: true, force: true });
  }
});

test("the menu's graph entries are not offered on a page with no graph", async () => {
  const electronApp = await launch("--repo", path.join(scratch, "not-a-repo"));
  const page = await windowPage(electronApp);
  await expect(page.locator("p")).toContainText("not a Git repository");

  expect(await menuEntry(electronApp, FETCH_REMOTE)).toMatchObject({ enabled: false });
});
