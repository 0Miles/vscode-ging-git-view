import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { type ElectronApplication, expect, type Page, test } from "@playwright/test";

import { keepTraceIfFailed, startTrace } from "./diffViewerPage";
import { datedGit, isolatedGitEnv, makeFixtureRepo } from "./fixtureRepo";
import { type GuardedRemote, startGuardedRemote } from "./guardedRemote";
import { APP_DIR, launchApp } from "./launch";
import {
  answerFolderDialog,
  clickMenu,
  menuEnabled,
  openSettings,
  putTerminalOnPath,
  settingRow,
  standInTerminals,
  terminalsStarted
} from "./mainProcess";
import { focusedTabPage, stripTabs, windowPage } from "./tabPages";

// Phase C's acceptance walk (#401, epic #291): "someone without VS Code can
// open, clone and init repositories, see the graph, perform the graph's
// actions — authenticated fetch and push among them — switch between
// repositories, change settings and the theme, and open a system terminal".
// One user, one app session, each clause a step named after it. The network
// is local only (ADR-0032): an HTTP remote on 127.0.0.1 that asks for
// credentials and lets the right ones in (guardedRemote.ts, the #392 401
// server with git's own http-backend behind it), and folders on disk. The
// system's dialogs are answered in their place; its terminal is a fake one on
// the PATH on Linux, stood in for elsewhere (mainProcess.ts).
//
// Each clause's own spec goes deeper; this one proves they hold together.
// Every one of the graph's actions is walked by actions.spec.ts.

/** What the page's failure report leaves in the log (graph.spec.ts). */
const WEBVIEW_FAILURE = /ERROR: webview |"reportError"/;
/**
 * How long a wait on git's work may take (ADR-0032's #401 addendum): a clone,
 * a push or a fetch through the guarded remote — each question git asks
 * starts the askpass helper, the app's own binary run as Node — or the
 * graph's reload after git changed the repository. Each wait is on what the
 * product shows once git is done; none is on a race. On a loaded Windows
 * machine (85% CPU, other E2E runs beside it) an askpass question took 2 s to
 * be asked, a branch created 4.2 s to be drawn, a fetch answered over 5 s to
 * be drawn, and the default 5 s ran out at a different one of them in 4 of 10
 * runs, the page answering throughout; the same as #473 found for
 * actions.spec.ts. The same steps on CI's ubuntu runner, where each prompt's
 * helper starts fast: clone 0.9 s, create and push 1.3 s, fetch 0.7 s, the
 * setting 1.0 s — against 6–11 s, 7–17 s, 6–10 s and 4–7 s on that Windows
 * machine. Each step's time is written to the output (`step`), to measure
 * this against.
 */
const GIT_WORK = { timeout: 30_000 };
const USERNAME = "alice";
const PASSWORD = "s3cret";

let scratch: string;
let env: NodeJS.ProcessEnv;
let app: ElectronApplication | null = null;
let cleanUp: string[] = [];
let remote: GuardedRemote | null = null;

/** Whether folder `dir` holds one of the programs `names`. */
const holds = (dir: string, ...names: string[]) =>
  names.some((name) => existsSync(path.join(dir, name)));

/**
 * `env` with nothing of VS Code's in it: no `VSCODE_*` variable, no askpass
 * of its (the developer's terminal may be VS Code's), and no folder on the
 * PATH holding its `code` command — but for one that holds git too, such as
 * `/usr/bin` where VS Code's package links `code`: the app needs git, and
 * none of VS Code. Where that leaves `code` reachable, it is still not run.
 */
function withoutVsCode(from: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(
    Object.entries(from).filter(
      ([name]) => !/^VSCODE_/i.test(name) && !/^(GIT|SSH)_ASKPASS$/i.test(name)
    )
  );
  const pathName = Object.keys(kept).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  const dirs = (kept[pathName] ?? "")
    .split(path.delimiter)
    .filter((dir) => !holds(dir, "code", "code.cmd", "code.exe") || holds(dir, "git", "git.exe"));
  expect(
    dirs.some((dir) => holds(dir, "git", "git.exe")),
    "git on the PATH left"
  ).toBe(true);
  kept[pathName] = dirs.join(path.delimiter);
  return kept;
}

/** `test.step`, with the time it took written to the output: what `GIT_WORK`
 *  is measured against, on CI as on a developer's machine. */
async function step(title: string, body: () => Promise<void>): Promise<void> {
  const started = Date.now();
  await test.step(title, body);
  // eslint-disable-next-line no-console -- the run's output is where CI keeps it
  console.log(`phaseC step ${((Date.now() - started) / 1000).toFixed(1)}s: ${title}`);
}

/** Answer git's two questions, asked in `page` through askpass: the username,
 *  then the password, masked. */
async function answerCredentials(page: Page): Promise<void> {
  const input = page.locator("#hostPromptInput");
  // git's whole prompt, `Username for '<url>': ` (#445).
  await expect(input).toHaveAttribute("placeholder", /^Username for '/, GIT_WORK);
  await expect(input).toBeFocused();
  await page.keyboard.type(USERNAME);
  await page.keyboard.press("Enter");
  await expect(input).toHaveAttribute("placeholder", /^Password for '/, GIT_WORK);
  await expect(input).toHaveAttribute("type", "password");
  await page.keyboard.type(PASSWORD);
  await page.keyboard.press("Enter");
  await expect(page.locator("#hostPrompt")).toBeHidden(GIT_WORK);
}

/** Click the item of the graph's context menu now open in `page` whose label
 *  starts with `label`. */
async function chooseFromMenu(page: Page, label: string): Promise<void> {
  const item = page.locator("#contextMenu .contextMenuItem").filter({
    hasText: new RegExp(`^${label}`)
  });
  await item.click();
}

test.beforeEach(() => {
  scratch = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "ging-e2e-")));
  // No system config, an empty global one, and never the terminal: no
  // credential helper answers in the user's place, so git asks (ADR-0032).
  env = withoutVsCode(isolatedGitEnv(path.join(scratch, "home")));
  cleanUp = [];
});

test.afterEach(async () => {
  if (app !== null) await keepTraceIfFailed(app, test.info());
  await app?.close();
  app = null;
  // The app's own account of a walk that failed, beside its trace.
  const log = path.join(scratch, "userData", "logs", "main.log");
  if (test.info().status !== test.info().expectedStatus && existsSync(log)) {
    copyFileSync(log, test.info().outputPath("main.log"));
  }
  await remote?.close();
  remote = null;
  [scratch, ...cleanUp].forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

test("phase C: open, clone and init repositories, act on the graph through a remote that asks for credentials, switch Tabs, change settings and theme, open a terminal", async () => {
  test.setTimeout(180_000);

  // The project on a server that asks who is there.
  const upstream = makeFixtureRepo(env);
  cleanUp.push(upstream.path);
  const served = path.join(scratch, "served");
  const servedRepo = path.join(served, "project.git");
  execFileSync("git", ["clone", "--bare", "--template=", upstream.path, servedRepo], {
    env,
    stdio: "pipe"
  });
  remote = await startGuardedRemote({
    root: served,
    repo: "project.git",
    username: USERNAME,
    password: PASSWORD,
    env
  });
  /** What the server's repository has `ref` at, or "" while it has none. */
  const servedRef = (ref: string) => {
    try {
      return execFileSync("git", ["--git-dir", servedRepo, "rev-parse", "--verify", ref], {
        env,
        stdio: "pipe"
      })
        .toString()
        .trim();
    } catch {
      return "";
    }
  };
  // Another repository already on disk, and a folder to start one in.
  const another = makeFixtureRepo(env);
  cleanUp.push(another.path);
  const newProject = path.join(scratch, "new-project");
  mkdirSync(newProject);
  const clones = path.join(scratch, "clones");
  mkdirSync(clones);
  const cloned = path.join(clones, "project");
  // On Linux the terminal is the one on the PATH, really started; elsewhere
  // the system's own is stood in for once the app runs.
  const terminalRecord =
    process.platform === "linux" ? putTerminalOnPath(env, scratch).startedIn : null;

  app = await launchApp(
    ["--lang=en-US", APP_DIR, `--user-data-dir=${path.join(scratch, "userData")}`],
    env
  );
  const electronApp = app;
  await startTrace(electronApp);
  const window = await windowPage(electronApp);
  if (terminalRecord === null) await standInTerminals(electronApp);

  await step("someone without VS Code starts the app: the Welcome page", async () => {
    await expect(window.locator("#welcome .welcomeActions")).toBeVisible();
    await expect(window.locator("#tabStrip")).toBeHidden();
  });

  let project!: Page;
  await step("clone a repository, its remote asking for credentials", async () => {
    await answerFolderDialog(electronApp, clones);
    await window.getByRole("button", { name: "Clone Repository..." }).click();
    await expect(window.locator("#hostPromptInput")).toBeFocused();
    await window.keyboard.type(remote!.url);
    await window.keyboard.press("Enter");
    // There is no Tab yet: git's askpass asks on the Welcome page.
    await expect(window.locator("#clonePanel")).toBeVisible();
    await answerCredentials(window);
    // git's own clone, then the Tab it is opened in.
    await expect(window.locator("#tabStrip .tab")).toHaveCount(1, GIT_WORK);
    project = await focusedTabPage(electronApp);
    expect((await stripTabs(window)).map(({ title }) => title)).toEqual(["project"]);
    expect(
      execFileSync("git", ["remote", "get-url", "origin"], { cwd: cloned, env }).toString().trim()
    ).toBe(remote!.url);
  });

  const rows = project.locator("#commitTable tr.commit");
  await step("see the graph", async () => {
    await expect(rows).toHaveCount(upstream.commits.length, GIT_WORK);
    await expect(rows.first()).toContainText("Third commit");
    await expect(project.locator('.gitRef[data-name="origin/feature"]')).toBeVisible();
  });

  await step("act on the graph: create a branch, push it through a remote that asks", async () => {
    await rows.filter({ hasText: "Second commit" }).click({ button: "right" });
    await chooseFromMenu(project, "Create Branch");
    await project.locator("#dialogInput0").fill("topic");
    await project.locator("#dialogAction").click();
    const topic = project.locator('.gitRef[data-name="topic"]');
    await expect(topic).toBeVisible(GIT_WORK);

    await topic.click({ button: "right" });
    await chooseFromMenu(project, "Push Branch");
    await project.locator("#dialogAction").click();
    await answerCredentials(project);
    await expect.poll(() => servedRef("refs/heads/topic"), GIT_WORK).toBe(upstream.commits[2].hash);
    await expect(project.locator("#dialog #actionRunning")).toHaveCount(0, GIT_WORK);
  });

  await step("fetch through a remote that asks", async () => {
    // Someone else pushed meanwhile.
    const git = datedGit(servedRepo, env, 1_700_100_000);
    const ahead = git("commit-tree", "main^{tree}", "-p", "main", "-m", "Remote commit");
    git("update-ref", "refs/heads/main", ahead);

    await project.locator("#fetchBtn").click();
    await answerCredentials(project);
    await expect(rows.filter({ hasText: "Remote commit" })).toHaveCount(1, GIT_WORK);
    await expect(project.locator("#dialog #actionRunning")).toHaveCount(0, GIT_WORK);
  });

  await step("open a folder's repository and init another: one Tab each", async () => {
    await answerFolderDialog(electronApp, another.path);
    expect(await clickMenu(electronApp, "ging.openFolder")).toBe(true);
    await expect
      .poll(async () => (await stripTabs(window)).map(({ title }) => title))
      .toEqual(["project", path.basename(another.path)]);

    await answerFolderDialog(electronApp, newProject);
    expect(await clickMenu(electronApp, "ging.initRepository")).toBe(true);
    await expect
      .poll(async () => (await stripTabs(window)).map(({ title }) => title))
      .toEqual(["project", path.basename(another.path), "new-project"]);
    expect(existsSync(path.join(newProject, ".git"))).toBe(true);
    const fresh = await focusedTabPage(electronApp, 3);
    await expect(fresh.locator("#repoTitleName")).toHaveText("new-project");

    // Known gap #461: with a Tab open, Clone is not offered — its progress and
    // its credential prompts are drawn on the Welcome page the Tabs cover.
    // This walk cloned first for that reason.
    test.info().annotations.push({
      type: "known gap",
      description:
        "#461: with a Tab open, Clone Repository is not offered; flip this assertion when it lands"
    });
    expect(await menuEnabled(electronApp, "ging.cloneRepository")).toBe(false);
  });

  await step("switch between repositories", async () => {
    const tabs = await stripTabs(window);
    const projectTab = tabs.find(({ title }) => title === "project")!;
    await window.locator(`#tabStrip .tab[data-tab-id="${projectTab.id}"]`).click();
    await expect
      .poll(async () => (await stripTabs(window)).find(({ focused }) => focused)?.title)
      .toBe("project");
    const focused = await focusedTabPage(electronApp, 3);
    await expect(focused.locator("#repoTitleName")).toHaveText("project");
    // Each is in Open Recent, to come back to, the last opened first, as git
    // spells its folder (clone.spec.ts).
    const spelled = (folder: string) =>
      execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: folder, env }).toString().trim();
    expect(
      await electronApp.evaluate(({ Menu }) =>
        Menu.getApplicationMenu()
          ?.getMenuItemById("ging.openRecent")
          ?.submenu?.items.map((item) => item.id)
      )
    ).toEqual(
      [newProject, another.path, cloned].map((folder) => `ging.openRecent:${spelled(folder)}`)
    );
  });

  await step("change a setting: the graph follows without a restart", async () => {
    const settings = await openSettings(electronApp);
    await settingRow(settings, "ging-git-view.show.remoteBranches")
      .locator("input[type=checkbox]")
      .uncheck();
    // What only the remote's branches lead to is gone from the graph.
    await expect(rows.filter({ hasText: "Remote commit" })).toHaveCount(0, GIT_WORK);
    await expect(rows.filter({ hasText: "Feature commit" })).toHaveCount(0);
    await expect(project.locator('.gitRef[data-name="origin/feature"]')).toHaveCount(0);

    await step("and the theme, by hand: every page follows", async () => {
      // Every page of the app's — the window's, each Tab's, the settings' —
      // in `theme`, and the choice itself held, not the system's.
      const choose = async (theme: "dark" | "light") => {
        await settings.locator("#ging-theme select").selectOption(theme);
        await Promise.all(
          electronApp
            .windows()
            .map((page) => expect(page.locator("body")).toContainClass(`vscode-${theme}`))
        );
        expect(await electronApp.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe(
          theme
        );
      };
      // Both ways, so one of them is a change whatever the system's theme is.
      await choose("dark");
      await choose("light");
      await settings.close();
    });
  });

  await step("open a system terminal in the focused Tab's repository", async () => {
    expect(await clickMenu(electronApp, "ging.openTerminal")).toBe(true);
    if (terminalRecord !== null) {
      await expect
        .poll(() => (existsSync(terminalRecord) ? readFileSync(terminalRecord, "utf8") : ""))
        .toBe(`${realpathSync.native(cloned)}\n`);
    } else {
      await expect.poll(() => terminalsStarted(electronApp)).toEqual([realpathSync.native(cloned)]);
    }
  });

  await step("nothing went wrong on the way", async () => {
    // Every credential the remote saw was the one typed; each of the clone,
    // the push and the fetch was asked for one.
    const sent = remote!.requests.flatMap(({ authorization }) =>
      authorization === undefined ? [] : [authorization]
    );
    expect(new Set(sent)).toEqual(
      new Set([`Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`])
    );
    const challenged = remote!.requests.filter(
      ({ url, authorization }) => url.includes("/info/refs") && authorization === undefined
    );
    expect(
      challenged.map(({ url }) => new URL(url, "http://x").searchParams.get("service"))
    ).toEqual(["git-upload-pack", "git-receive-pack", "git-upload-pack"]);

    await electronApp.close();
    app = null;
    const logged = readFileSync(path.join(scratch, "userData", "logs", "main.log"), "utf8");
    const spelled = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: cloned, env })
      .toString()
      .trim();
    expect(logged).toContain(`clone: cloned ${spelled}`);
    expect(logged).toContain("settings: ging-git-view.show.remoteBranches saved");
    expect(logged).not.toMatch(WEBVIEW_FAILURE);
    expect(logged).not.toContain("ERROR:");
  });
});
