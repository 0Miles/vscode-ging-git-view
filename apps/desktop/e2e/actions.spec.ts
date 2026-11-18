import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { _electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";

import type { RequestMessage, ResponseMessage } from "@ging/shared/types";

import { diffShown, FIRST_DIFF_BUDGET, keepTraceIfFailed, startTrace } from "./diffViewerPage";
import { addAheadRemote, type FixtureRepo, isolatedGitEnv, makeFixtureRepo } from "./fixtureRepo";
import { focusedTabPage, windowPage } from "./tabPages";

// Every kind of message the graph's dispatch handles, sent from the page as the
// webview sends them, on a fixture repository (#391). Each one finishes —
// answered, or seen doing what it does — no handler throws, and the webview
// reports no failure the whole way. Read through the page, Electron's own API
// and the app's log (ADR-0032).
//
// Nothing outside the app happens: the system's dialogs, the browser, the
// file's program, the clipboard and the terminal are stood in for in the main
// process, the way graph.spec.ts answers its dialog, and every remote is a
// local folder or never contacted.

/** The app as `electron .` runs it: package.json's `main`, built into out/. */
const APP_DIR = path.resolve(__dirname, "..");
/** In Node, the `electron` package is the path to its binary. */
const ELECTRON = require("electron") as unknown as string;

type Command = RequestMessage["command"];
type Request<C extends Command> = Extract<RequestMessage, { command: C }>;

/**
 * Every command the dispatch handles, but one. Written out so that a command
 * added to `RequestMessage` fails to compile here until the walk sends it.
 * `reportError` is the one not sent: it is the webview reporting a failure,
 * and the walk's verdict is that there was none.
 */
const EVERY_COMMAND: Record<Exclude<Command, "reportError">, true> = {
  addTag: true,
  checkoutBranch: true,
  checkoutAndPullBranch: true,
  checkoutCommit: true,
  cherrypickCommit: true,
  createBranch: true,
  dropCommit: true,
  resetFileToRevision: true,
  applyStash: true,
  popStash: true,
  dropStash: true,
  renameStash: true,
  fastForwardBranch: true,
  resetUncommittedChanges: true,
  cleanUntrackedFiles: true,
  continueOperation: true,
  abortOperation: true,
  markResolved: true,
  deleteBranch: true,
  deleteRemoteBranch: true,
  deleteTag: true,
  fetchIntoLocalBranch: true,
  mergeBranch: true,
  moveBranch: true,
  mergeCommit: true,
  pullBranch: true,
  pushBranch: true,
  pushTag: true,
  rebaseOn: true,
  rebaseOnto: true,
  rebaseInteractive: true,
  renameBranch: true,
  resetToCommit: true,
  revertCommit: true,
  deleteBranches: true,
  pushBranches: true,
  fastForwardBranches: true,
  commitDetails: true,
  operationState: true,
  compareCommits: true,
  predictConflicts: true,
  branchRedundancy: true,
  redundancyCommitDetails: true,
  loadBranches: true,
  loadRemotes: true,
  branchSearch: true,
  commitLogDepth: true,
  tagDetails: true,
  loadCommits: true,
  fetchAvatar: true,
  selectRepo: true,
  loadRepos: true,
  saveRepoState: true,
  copyToClipboard: true,
  viewDiff: true,
  openFile: true,
  viewFileAtRevision: true,
  viewDiffWithWorking: true,
  openTerminal: true,
  openMergeEditor: true,
  openExternalUrl: true,
  openScmView: true,
  clearBranchFilter: true,
  fetch: true,
  createArchive: true,
  exportPatch: true,
  saveDialogMemory: true,
  createPullRequest: true,
  branchCleanupScan: true,
  branchCleanupScanCancel: true,
  branchCleanupOpen: true,
  locateCommitNotInGraph: true,
  delegatedRan: true
};

/** What the main process was asked to do outside itself, in order. */
type Seen =
  | { kind: "box"; type: string; message: string; buttons: string[] }
  | { kind: "save"; defaultPath: string; answered: string }
  | { kind: "openPath"; file: string }
  | { kind: "showItemInFolder"; file: string }
  | { kind: "openExternal"; url: string }
  | { kind: "clipboard"; text: string }
  | { kind: "terminal"; command: string; args: string[]; cwd: string };

let scratch: string;
let env: NodeJS.ProcessEnv;
let app: ElectronApplication | null = null;
let cleanUp: string[] = [];

test.beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "ging-e2e-"));
  env = isolatedGitEnv(path.join(scratch, "home"));
  cleanUp = [];
});

test.afterEach(async () => {
  if (app !== null) await keepTraceIfFailed(app, test.info());
  await app?.close();
  app = null;
  for (const dir of [scratch, ...cleanUp]) rmSync(dir, { recursive: true, force: true });
});

const EMAIL = "alice@example.com";

/** A user data folder whose avatar cache already holds `EMAIL`'s, as an
 *  earlier session would have left it: `fetchAvatar` answers from it and
 *  asks no avatar service. */
function userDataWithAvatar(): string {
  const userData = path.join(scratch, "userData");
  const avatars = path.join(userData, "globalStorage", "avatars");
  mkdirSync(avatars, { recursive: true });
  writeFileSync(path.join(avatars, "alice.png"), "PNGDATA");
  const avatar = { image: "alice.png", timestamp: Date.now(), identicon: false };
  writeFileSync(
    path.join(userData, "state.json"),
    JSON.stringify({ "global:avatarCache": { [EMAIL]: avatar } })
  );
  return userData;
}

/**
 * Stand in for everything the app would do outside itself (ADR-0032). Each of
 * these is looked up when called — `NativeDialogs`, the desktop `OsShell`,
 * the desktop `Clipboard` — so replacing it here answers for every caller. A
 * terminal is the one detached process the app starts; git's are not, and
 * still run.
 */
function standIn(electronApp: ElectronApplication, saveDir: string) {
  return electronApp.evaluate(({ clipboard, dialog, shell }, dir) => {
    const seen: unknown[] = [];
    (globalThis as Record<string, unknown>).seenOutside = seen;
    const node = process.mainModule!.require.bind(process.mainModule);
    const nodePath = node("node:path") as typeof import("node:path");

    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { type: string; message: string; buttons?: string[] };
      seen.push({
        kind: "box",
        type: options.type,
        message: options.message,
        buttons: options.buttons ?? []
      });
      // The first button: the action a notice offers, OK on one that offers none.
      return { response: 0, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
    dialog.showSaveDialog = (async (...args: unknown[]) => {
      const options = args.at(-1) as { defaultPath: string };
      const answered = nodePath.join(dir, nodePath.basename(options.defaultPath));
      seen.push({ kind: "save", defaultPath: options.defaultPath, answered });
      return { canceled: false, filePath: answered };
    }) as typeof dialog.showSaveDialog;
    shell.openPath = async (file) => {
      seen.push({ kind: "openPath", file });
      return "";
    };
    shell.showItemInFolder = (file) => {
      seen.push({ kind: "showItemInFolder", file });
    };
    shell.openExternal = async (url) => {
      seen.push({ kind: "openExternal", url });
    };
    clipboard.writeText = (async (text: string) => {
      seen.push({ kind: "clipboard", text });
    }) as unknown as typeof clipboard.writeText;

    const childProcess = node("node:child_process") as typeof import("node:child_process");
    const { EventEmitter } = node("node:events") as typeof import("node:events");
    const spawn = childProcess.spawn;
    childProcess.spawn = ((command: string, args: string[], options?: { detached?: boolean }) => {
      if (options?.detached !== true) return spawn(command, args, options ?? {});
      seen.push({
        kind: "terminal",
        command,
        args,
        cwd: (options as { cwd: string }).cwd
      });
      const child = Object.assign(new EventEmitter(), { unref: () => {} });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }) as typeof childProcess.spawn;
  }, saveDir);
}

/** What the main process was asked to do outside itself so far. */
const seenOutside = (electronApp: ElectronApplication) =>
  electronApp.evaluate(
    () => (globalThis as Record<string, unknown>).seenOutside as Seen[]
  ) as Promise<Seen[]>;

/** Listen, in the page, to what the host posts to it, as the graph does. */
function listen(page: Page) {
  return page.evaluate(() => {
    const answers: unknown[] = [];
    (globalThis as Record<string, unknown>).hostAnswers = answers;
    window.addEventListener("message", (event) => answers.push(event.data));
  });
}

const answersSoFar = (page: Page) =>
  page.evaluate(
    () => (globalThis as Record<string, unknown>).hostAnswers as ResponseMessage[]
  ) as Promise<ResponseMessage[]>;

/** One message of the walk: built when it is its turn — what it names may only
 *  exist by then — and how to tell it has finished. */
type Step = {
  command: Command;
  request: () => RequestMessage;
  /** The answer that says it finished, for a command answered. */
  answer?: (msg: ResponseMessage) => boolean;
  /** What else it must have done, read once it finished; for a command that
   *  answers nothing, how to tell it finished at all. */
  check?: (answer: ResponseMessage | undefined, outside: Seen[]) => void | Promise<void>;
  /** How long its answer and its check may take, past the usual
   *  (`ANSWER_BUDGET_MS` for the answer, 10s for the check): only for what a
   *  page does slowly the first time (`FIRST_DIFF_BUDGET`). */
  budget?: number;
};

/**
 * How long the walk waits for a step's answer. Chosen for the costliest step,
 * not Playwright's 5s default, which the walk once used by omission (#472).
 * `branchCleanupScan` runs its git one command after another (the cleanup
 * facts, the default branch's date, a `merge-tree` per branch, kept in turn
 * for its progress and its cancel), and a git spawn costs 100–250ms on
 * Windows. Before #475 the scan also read the facts a second time, which
 * took it past 5s in 1 of 10 walks (1.9–5.0s). Measured since, on Windows with
 * every core busy and the machine shared with other test runs, 3 walks:
 * `branchCleanupScan` 2.0–4.1s, `branchCleanupOpen` 0.9–2.0s,
 * `branchRedundancy` about 2.0s. About four times the worst of them. CI runs
 * the walk on ubuntu only, where it has stayed under the default.
 */
const ANSWER_BUDGET_MS = 16_000;

function step<C extends Command>(
  command: C,
  request: () => Omit<Request<C>, "command">,
  options: Omit<Step, "command" | "request"> = {}
): Step {
  return { command, request: () => ({ command, ...request() }) as RequestMessage, ...options };
}

/** Answered with a response of `command`. */
const answered =
  (command: ResponseMessage["command"], extra: (msg: ResponseMessage) => boolean = () => true) =>
  (msg: ResponseMessage) =>
    msg.command === command && extra(msg);

type ActionCommand = Extract<RequestMessage, { status?: never; repo: string }>["command"];
type BatchCommand = "deleteBranches" | "pushBranches" | "fastForwardBranches";

/** The steps of git's actions on `repo`, each told apart by its answer. */
function actionsOn(repo: string) {
  return {
    /** An action's answer, and that git did it. */
    action: <C extends ActionCommand>(
      command: C,
      request: () => Omit<Request<C>, "command" | "repo">
    ): Step =>
      step(command, () => ({ repo, ...request() }) as Omit<Request<C>, "command">, {
        answer: answered(command as ResponseMessage["command"]),
        check: (answer) => expect(answer, command).toMatchObject({ status: null })
      }),
    /** A batch action's answer, and that git did it for every ref. */
    batch: <C extends BatchCommand>(
      command: C,
      request: () => Omit<Request<C>, "command" | "repo">
    ): Step =>
      step(command, () => ({ repo, ...request() }) as Omit<Request<C>, "command">, {
        answer: answered(command),
        check: (answer) => {
          const results = (answer as { results: { status: string | null }[] }).results;
          expect(results.length, command).toBeGreaterThan(0);
          for (const result of results) expect(result, command).toMatchObject({ status: null });
        }
      })
  };
}

// A file clicked in the Commit Details View opens its diff: diffViewer.spec.ts
// (#404), which replaced the stub's test here (#391).

test("the graph's page leaves the app only through the opener", async () => {
  const fixture = makeFixtureRepo(env);
  cleanUp.push(fixture.path);
  app = await _electron.launch({
    executablePath: ELECTRON,
    args: [
      "--lang=en-US",
      APP_DIR,
      `--user-data-dir=${path.join(scratch, "userData")}`,
      "--repo",
      fixture.path
    ],
    env: env as Record<string, string>
  });
  const electronApp = app;
  await startTrace(electronApp);
  const page = await focusedTabPage(electronApp);
  const rows = page.locator("#commitTable tr.commit");
  await expect(rows).toHaveCount(fixture.commits.length);
  await standIn(electronApp, scratch);

  const pagesBefore = electronApp.windows().length;
  // A new window and a navigation away, each to the web and elsewhere, from
  // the Tab's page and from the window's own: one guard keeps them all.
  await (
    await windowPage(electronApp)
  ).evaluate(() => {
    window.open("https://example.com/from-the-strip");
  });
  await page.evaluate(() => {
    window.open("https://example.com/opened");
    window.open("file:///C:/Windows/System32/calc.exe");
  });
  await page.evaluate(() => {
    const away = document.createElement("a");
    away.href = "https://example.com/followed";
    document.body.append(away);
    away.click();
  });
  await page.evaluate(() => {
    window.location.href = "file:///etc/passwd";
  });

  // The web addresses went to the browser, as parsed; nothing else went
  // anywhere, and the graph is still the page shown, with no page added.
  await expect
    .poll(() => seenOutside(electronApp))
    .toEqual([
      { kind: "openExternal", url: "https://example.com/from-the-strip" },
      { kind: "openExternal", url: "https://example.com/opened" },
      { kind: "openExternal", url: "https://example.com/followed" }
    ]);
  // Read straight off the page: Playwright's locators would wait on the
  // navigation it saw start, which the app cancelled and never finishes.
  expect(
    await page.evaluate(() => document.querySelectorAll("#commitTable tr.commit").length)
  ).toBe(fixture.commits.length);
  expect(await page.evaluate(() => location.href)).toMatch(/^ging:\/\/app\//);
  expect(electronApp.windows()).toHaveLength(pagesBefore);
  await electronApp.close();
  app = null;
  // The `file:` ones may never reach the app's guards — Chromium refuses a
  // local file to a page that is not one — so only their effect is checked.
  expect(readFileSync(path.join(scratch, "userData", "logs", "main.log"), "utf8")).not.toContain(
    "ERROR:"
  );
});

test("every message the dispatch handles finishes, and the webview reports no failure", async () => {
  // About seventy messages, most of them running git, one after another.
  test.setTimeout(240_000);
  const fixture: FixtureRepo = makeFixtureRepo(env);
  cleanUp.push(fixture.path);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: fixture.path, env, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  const [c3, f1, c2, c1] = fixture.commits.map((commit) => commit.hash);

  // The app's git commits too (merge, cherry-pick, revert, tag): as whom.
  git("config", "user.name", "Alice");
  git("config", "user.email", EMAIL);
  // `origin`: a local bare remote, one commit ahead on main.
  const remote = addAheadRemote(fixture, env);
  cleanUp.push(remote.path);
  git("branch", "--set-upstream-to=origin/main", "main");
  // Two remotes with a forge's address, only for the pull request URL: never
  // fetched (`skipFetchAll`) nor pushed to.
  for (const [name, url] of [
    ["hub", "https://github.com/acme/repo.git"],
    ["forge", "https://git.example.test/team/repo.git"]
  ]) {
    git("remote", "add", name, url);
    git("config", `remote.${name}.skipFetchAll`, "true");
  }
  // Branches off the first commit, each adding a file of its own, so merging,
  // cherry-picking or rebasing one never conflicts.
  const branchOff = (name: string, file: string) => {
    git("checkout", "--quiet", "-b", name, c1);
    writeFileSync(path.join(fixture.path, file), `${name}\n`);
    git("add", file);
    git("commit", "--quiet", "-m", `${name} commit`);
    return git("rev-parse", "HEAD");
  };
  branchOff("side", "side.txt");
  const pick = branchOff("pick", "pick.txt");
  const more = branchOff("more", "more.txt");
  git("checkout", "--quiet", "main");
  /** A stash of a change to file.txt, and its hash. */
  const stash = (content: string) => {
    writeFileSync(path.join(fixture.path, "file.txt"), `${content}\n`);
    git("stash", "push", "--quiet", "-m", content);
    return git("rev-parse", "stash@{0}");
  };
  // The second is on top: applied and popped first, then the first renamed
  // and dropped.
  stash("renamed later");
  const applied = stash("applied then popped");
  const head = () => git("rev-parse", "HEAD");
  // A script, untracked, for "Open File" to refuse to run.
  writeFileSync(path.join(fixture.path, "run.bat"), "@echo off\r\n");
  // On Linux the app looks its terminal up on the PATH's absolute folders: one
  // put first there, so the walk does not depend on what the machine has
  // installed. It is never run — the spawn is stood in for.
  const bin = path.join(scratch, "bin");
  const fakeTerminal = path.join(bin, "x-terminal-emulator");
  if (process.platform === "linux") {
    mkdirSync(bin);
    writeFileSync(fakeTerminal, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    env.PATH = `${bin}:${env.PATH ?? ""}`;
  }

  userDataWithAvatar();
  const saveDir = path.join(scratch, "saved");
  mkdirSync(saveDir);
  app = await _electron.launch({
    executablePath: ELECTRON,
    args: [
      "--lang=en-US",
      APP_DIR,
      `--user-data-dir=${path.join(scratch, "userData")}`,
      "--repo",
      fixture.path
    ],
    env: env as Record<string, string>
  });
  const electronApp = app;
  await startTrace(electronApp);
  const page = await focusedTabPage(electronApp);
  await expect(page.locator("#commitTable tr.commit").first()).toBeVisible();
  await standIn(electronApp, saveDir);
  await listen(page);
  /** The repository as the graph names it in what it sends. */
  const repo = await page.evaluate(
    () => (globalThis as { viewState?: { lastActiveRepo: string } }).viewState!.lastActiveRepo
  );
  const repoState = await page.evaluate(
    (r) => (globalThis as { viewState?: { repos: Record<string, unknown> } }).viewState!.repos[r],
    repo
  );
  const { action, batch } = actionsOn(repo);
  /** A file of the fixture as the opener names it: its real path. */
  const inRepo = (name: string) => realpathSync.native(path.join(fixture.path, name));
  /** The terminal the app starts in `cwd`: always a program named by its
   *  absolute path, never one the repository could hold (#391). */
  const terminal = (cwd: string) => {
    const name = `GING: ${path.basename(repo)}`;
    if (process.platform === "win32") {
      // The app's ComSpec: the variable however this shell spells it — Git
      // Bash hands down `COMSPEC` — as the app's own `process.env` reads it.
      const comSpec = Object.entries(env).find(([key]) => key.toLowerCase() === "comspec")?.[1];
      expect(comSpec, "ComSpec in the app's environment").toBeDefined();
      const cmd = comSpec!;
      expect(path.isAbsolute(cmd)).toBe(true);
      return {
        kind: "terminal",
        command: cmd,
        args: ["/d", "/c", "start", `"${name}"`, `"${cmd}"`],
        cwd
      };
    }
    if (process.platform === "darwin") {
      return { kind: "terminal", command: "/usr/bin/open", args: ["-a", "Terminal", cwd], cwd };
    }
    return { kind: "terminal", command: fakeTerminal, args: [], cwd };
  };
  /** No box saying something failed in the graph's own page. */
  const noErrorDialog = () => expect(page.locator("#dialog.active")).toHaveCount(0);
  /** A diff — or a file read-only (#405), in the same viewer, in one editor
   *  and no diff — shown over the graph: nothing outside the app, no error
   *  box; then closed. */
  const diffOpened = async (outside: Seen[], title: RegExp, kind: "diff" | "file" = "diff") => {
    expect(outside).toEqual([]);
    await noErrorDialog();
    // Its editor made: the first diff loads the editor's code first.
    await diffShown(page);
    const viewer = page.locator("#diffViewer");
    await expect(viewer.locator(".diffViewerTitle")).toHaveText(title);
    if (kind === "diff") {
      await expect(viewer.locator(".monaco-diff-editor")).toBeVisible();
    } else {
      await expect(viewer.locator(".monaco-editor")).toBeVisible();
      await expect(viewer.locator(".monaco-diff-editor")).toHaveCount(0);
    }
    await viewer.locator(".diffViewerClose").click();
    await expect(viewer).toBeHidden();
  };
  const success = (command: ResponseMessage["command"]) =>
    answered(command, (msg) => "success" in msg);
  const succeeded = (answer: ResponseMessage | undefined) =>
    expect(answer).toMatchObject({ success: true });
  let rebasedMore = "";

  const walk: Step[] = [
    // What the graph reads, and the host's own state.
    step("selectRepo", () => ({ repo })),
    step("loadRepos", () => ({ check: true }), { answer: answered("loadRepos") }),
    step("loadBranches", () => ({ hard: true, token: -1 }), {
      answer: answered("loadBranches", (msg) => "token" in msg && msg.token === -1),
      check: (answer) =>
        expect(answer).toMatchObject({ isRepo: true, head: "main", branches: expect.any(Array) })
    }),
    step(
      "loadCommits",
      () => ({ repo, branchNames: [""], maxCommits: 100, hard: false, token: -1 }),
      {
        answer: answered("loadCommits", (msg) => "token" in msg && msg.token === -1),
        check: (answer) =>
          expect((answer as { commits: unknown[] }).commits.length).toBeGreaterThan(0)
      }
    ),
    step("loadRemotes", () => ({}), {
      answer: answered("loadRemotes"),
      check: (answer) =>
        expect(answer).toMatchObject({ remotes: expect.arrayContaining(["origin"]) })
    }),
    step("operationState", () => ({ repo }), {
      answer: answered("operationState"),
      check: (answer) => expect(answer).toMatchObject({ operation: null, conflictedFiles: [] })
    }),
    step("branchSearch", () => ({ repo, branchNames: [""], token: -1 }), {
      answer: answered("branchSearch", (msg) => "token" in msg && msg.token === -1),
      check: (answer) => expect(answer).toMatchObject({ status: null })
    }),
    step("commitLogDepth", () => ({ repo, hash: c1, branchNames: [""], token: -1 }), {
      answer: answered("commitLogDepth", (msg) => "token" in msg && msg.token === -1),
      check: (answer) =>
        expect(answer).toMatchObject({ status: null, logDepth: expect.any(Number) })
    }),
    step("commitDetails", () => ({ repo, commitHash: c3 }), {
      answer: answered("commitDetails"),
      check: (answer) =>
        expect(answer).toMatchObject({ commitDetails: expect.objectContaining({ hash: c3 }) })
    }),
    step("compareCommits", () => ({ repo, fromHash: c1, toHash: c3 }), {
      answer: answered("compareCommits"),
      check: (answer) => expect(answer).toMatchObject({ fileChanges: expect.any(Array) })
    }),
    step("branchRedundancy", () => ({ repo, branch: "feature", token: -1 }), {
      answer: answered("branchRedundancy")
    }),
    step("redundancyCommitDetails", () => ({ repo, commitHash: f1 }), {
      answer: answered("redundancyCommitDetails"),
      check: (answer) => expect(answer).toMatchObject({ commitDetails: expect.anything() })
    }),
    step("predictConflicts", () => ({ repo, ours: "main", theirs: "side", token: -1 }), {
      answer: answered("predictConflicts"),
      check: (answer) => expect(answer).toMatchObject({ ok: true, conflictFiles: [] })
    }),
    step("branchCleanupOpen", () => ({ repo, fetch: false, token: -1 }), {
      answer: answered("branchCleanupOpen")
    }),
    step("branchCleanupScan", () => ({ repo, token: -1 }), {
      answer: answered("branchCleanupScan")
    }),
    step("branchCleanupScanCancel", () => ({})),
    step("fetchAvatar", () => ({ repo, email: EMAIL, commits: [c1] }), {
      answer: answered("fetchAvatar"),
      check: (answer) => expect(answer).toMatchObject({ email: EMAIL })
    }),
    step("saveRepoState", () => ({ repo, state: repoState as never })),
    step("saveDialogMemory", () => ({ dialogKey: "e2e", values: { e2e: "checked" } })),
    step("delegatedRan", () => ({ seq: 1 })),
    step("copyToClipboard", () => ({ type: "Commit Hash", data: c3 }), {
      answer: answered("copyToClipboard"),
      check: (answer, outside) => {
        expect(answer).toMatchObject({ success: true });
        expect(outside).toEqual([{ kind: "clipboard", text: c3 }]);
      }
    }),

    // What the desktop Opener opens through the system.
    step("openFile", () => ({ repo, filePath: "file.txt" }), {
      answer: success("openFile"),
      check: (answer, outside) => {
        succeeded(answer);
        expect(outside).toEqual([{ kind: "openPath", file: inRepo("file.txt") }]);
      }
    }),
    // A script the system would run: shown in its folder, never opened.
    step("openFile", () => ({ repo, filePath: "run.bat" }), {
      answer: success("openFile"),
      check: (answer, outside) => {
        succeeded(answer);
        expect(outside).toEqual([{ kind: "showItemInFolder", file: inRepo("run.bat") }]);
      }
    }),
    // Not a web address: refused, and nothing opened. Its refusal is done by
    // the time the next message is handled, so the next step's check that it
    // alone opened something covers this one too.
    step("openExternalUrl", () => ({ url: pathToFileURL(inRepo("run.bat")).href })),
    step("openExternalUrl", () => ({ url: "https://example.com/issues/1" }), {
      check: (_answer, outside) =>
        expect(outside).toEqual([{ kind: "openExternal", url: "https://example.com/issues/1" }])
    }),
    step("openTerminal", () => ({ repo }), {
      check: (_answer, outside) => expect(outside).toEqual([terminal(path.normalize(repo))])
    }),

    // The diffs, in the diff viewer over the graph (#404): nothing outside
    // the app, and no error box. Closed again, so it covers no later step.
    // The first on the page loads the editor's code, which blocks the page
    // and the walk's reads of it: hence its budget.
    step("viewDiffWithWorking", () => ({ repo, commitHash: c3, filePath: "file.txt" }), {
      answer: success("viewDiffWithWorking"),
      check: async (answer, outside) => {
        succeeded(answer);
        await diffOpened(outside, /^file\.txt \(.+ ↔ Working Tree\)$/);
      },
      budget: FIRST_DIFF_BUDGET
    }),
    step(
      "viewDiff",
      () => ({
        repo,
        commitHash: c3,
        oldFilePath: "file.txt",
        newFilePath: "file.txt",
        type: "M" as const
      }),
      {
        answer: success("viewDiff"),
        check: async (answer, outside) => {
          succeeded(answer);
          await diffOpened(outside, /^file\.txt \(.+\^ ↔ .+\)$/);
        }
      }
    ),
    // No longer a stub (#405): the file read-only, in the same viewer.
    step("viewFileAtRevision", () => ({ repo, commitHash: c3, filePath: "file.txt" }), {
      answer: success("viewFileAtRevision"),
      check: async (answer, outside) => {
        succeeded(answer);
        await diffOpened(outside, /^file\.txt \([0-9a-f]{8}\)$/, "file");
      }
    }),
    // No longer a stub (#410): the file would go to the user's merge tool,
    // but it is in no conflict, which is said; no tool runs. The merge tool
    // itself is conflicts.spec.ts's.
    step("openMergeEditor", () => ({ repo, filePath: "file.txt" }), {
      check: async (_answer, outside) => {
        expect(outside).toEqual([
          {
            kind: "box",
            type: "info",
            message: "file.txt has no conflict to resolve.",
            buttons: []
          }
        ]);
        await noErrorDialog();
      }
    }),
    // No longer a stub (#403): the working tree panel beside the graph opens,
    // and reads the working tree; nothing is said, nothing opens outside.
    step("openScmView", () => ({}), {
      answer: (msg) => (msg.command as string) === "workingTreeStatus",
      check: async (answer, outside) => {
        expect(answer).toMatchObject({ request: "workingTreeLoad", error: null });
        expect(outside).toEqual([]);
        await expect(page.locator("#workingTree")).toBeVisible();
        await noErrorDialog();
      }
    }),
    step("createPullRequest", () => ({ repo, branchName: "side", remote: "hub" }), {
      check: (_answer, outside) =>
        expect(outside).toEqual([
          {
            kind: "openExternal",
            url: expect.stringMatching(/^https:\/\/github\.com\/acme\/repo\/.*side/)
          }
        ])
    }),
    // No provider for the forge's host: the error offers to configure one —
    // answered by its first button — and configuring it is core's Manage Pull
    // Request Providers (#398), which asks which forge in this page. Left
    // unanswered: nothing is written, and nothing else is said.
    step("createPullRequest", () => ({ repo, branchName: "side", remote: "forge" }), {
      check: async (_answer, outside) => {
        expect(outside).toEqual([
          {
            kind: "box",
            type: "error",
            message: "No pull request provider is configured for git.example.test.",
            buttons: ["Configure a Provider...", "Cancel"]
          }
        ]);
        const overlay = page.locator("#hostPrompt");
        await expect(overlay).toBeVisible();
        await expect(overlay.locator(".hostPromptItem").first()).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(overlay).toBeHidden();
        await noErrorDialog();
      }
    }),
    step("clearBranchFilter", () => ({ repo }), { answer: answered("branchFilterCleared") }),
    step("locateCommitNotInGraph", () => ({ hash: c1 }), {
      check: (_answer, outside) =>
        expect(outside).toEqual([
          expect.objectContaining({
            kind: "box",
            type: "info",
            message: expect.stringContaining(c1.slice(0, 7))
          })
        ])
    }),

    // What writes: files out of the repository, then the repository itself.
    step("fetch", () => ({ repo }), {
      answer: answered("fetch"),
      check: (answer) => expect(answer).toMatchObject({ status: null })
    }),
    step("createArchive", () => ({ repo, ref: "main" }), {
      answer: success("createArchive"),
      check: (answer, outside) => {
        succeeded(answer);
        expect(outside).toEqual([expect.objectContaining({ kind: "save" })]);
        expect(existsSync(path.join(saveDir, "main.zip"))).toBe(true);
      }
    }),
    step("exportPatch", () => ({ repo, commitHash: c3 }), {
      answer: success("exportPatch"),
      check: (answer, outside) => {
        succeeded(answer);
        const [saved] = outside as { answered: string }[];
        expect(existsSync(saved.answered)).toBe(true);
      }
    }),
    action("addTag", () => ({
      tagName: "v1.0",
      commitHash: c2,
      lightweight: false,
      message: "Release",
      pushToRemote: null,
      force: false
    })),
    step("tagDetails", () => ({ repo, tagName: "v1.0" }), {
      answer: answered("tagDetails"),
      check: (answer) => expect(answer).toMatchObject({ details: expect.anything() })
    }),
    action("pushTag", () => ({ tagName: "v1.0", remotes: ["origin"] })),
    action("deleteTag", () => ({ tagName: "v1.0", deleteOnRemote: "origin" })),
    action("createBranch", () => ({
      commitHash: c1,
      branchName: "topic",
      checkout: false,
      force: false
    })),
    action("renameBranch", () => ({ oldName: "topic", newName: "topic-renamed" })),
    action("moveBranch", () => ({ branchName: "topic-renamed", commitHash: c2 })),
    action("pushBranch", () => ({
      branchName: "topic-renamed",
      remotes: ["origin"],
      forceMode: "normal" as const
    })),
    action("deleteRemoteBranch", () => ({ branchName: "topic-renamed", remote: "origin" })),
    action("deleteBranch", () => ({
      branchName: "topic-renamed",
      forceDelete: false,
      deleteOnRemotes: false
    })),
    batch("pushBranches", () => ({
      branchNames: ["side"],
      remotes: ["origin"],
      forceMode: "normal" as const
    })),
    action("fetchIntoLocalBranch", () => ({
      remote: "origin",
      remoteBranch: "side",
      localBranch: "side-copy",
      force: false
    })),
    // Not merged into main yet, so only a forced delete takes it.
    batch("deleteBranches", () => ({
      refs: ["side-copy"],
      forceDelete: true,
      deleteOnRemotes: false
    })),
    // main is behind origin/main: moved while another branch is checked out.
    action("checkoutBranch", () => ({ branchName: "feature", remoteBranch: null, force: false })),
    action("fastForwardBranch", () => ({ branchName: "main" })),
    batch("fastForwardBranches", () => ({ branchNames: ["main"] })),
    action("checkoutCommit", () => ({ commitHash: c1 })),
    action("checkoutAndPullBranch", () => ({
      branchName: "main",
      remote: "origin",
      branchOnRemote: "main"
    })),
    action("pullBranch", () => ({ branchName: "main", remote: "origin" })),
    action("mergeBranch", () => ({
      branchName: "side",
      createNewCommit: true,
      squash: false,
      noCommit: false
    })),
    action("cherrypickCommit", () => ({
      commitHash: pick,
      parentIndex: 0,
      noCommit: false,
      recordOrigin: false
    })),
    action("revertCommit", () => ({ commitHash: head(), parentIndex: 0 })),
    action("dropCommit", () => ({ commitHash: head() })),
    action("mergeCommit", () => ({
      commitHash: more,
      createNewCommit: true,
      squash: false,
      noCommit: false
    })),
    action("resetToCommit", () => ({
      commitHash: git("rev-parse", "HEAD~1"),
      resetMode: "hard" as const
    })),
    action("resetFileToRevision", () => ({ commitHash: c1, filePath: "file.txt" })),
    action("markResolved", () => ({ filePath: "file.txt" })),
    action("resetUncommittedChanges", () => ({})),
    step(
      "cleanUntrackedFiles",
      () => {
        writeFileSync(path.join(fixture.path, "untracked.txt"), "x\n");
        return { repo };
      },
      {
        answer: answered("cleanUntrackedFiles"),
        check: (answer) => {
          expect(answer).toMatchObject({ status: null });
          expect(existsSync(path.join(fixture.path, "untracked.txt"))).toBe(false);
        }
      }
    ),
    action("applyStash", () => ({
      selector: "stash@{0}",
      expectedHash: applied,
      reinstateIndex: false
    })),
    action("resetUncommittedChanges", () => ({})),
    action("popStash", () => ({
      selector: "stash@{0}",
      expectedHash: applied,
      reinstateIndex: false
    })),
    action("resetUncommittedChanges", () => ({})),
    action("renameStash", () => ({
      selector: "stash@{0}",
      expectedHash: git("rev-parse", "stash@{0}"),
      message: "renamed"
    })),
    action("dropStash", () => ({
      selector: "stash@{0}",
      expectedHash: git("rev-parse", "stash@{0}")
    })),
    action("checkoutBranch", () => ({ branchName: "more", remoteBranch: null, force: false })),
    action("rebaseOn", () => ({ obj: "main" })),
    action("rebaseOnto", () => ({ newBase: "main", upstream: "main", tip: "more" })),
    action("rebaseInteractive", () => {
      rebasedMore = head();
      return {
        newBase: "main",
        upstream: "main",
        tip: null,
        todo: `pick ${rebasedMore} more commit\n`
      };
    }),
    action("continueOperation", () => ({})),
    action("abortOperation", () => ({}))
  ];

  const sent = new Set<Command>();
  /** Send one message of the walk, and wait until it has finished. */
  const run = async ({ command, request, answer, check, budget }: Step) => {
    const asked = request();
    const answersBefore = (await answersSoFar(page)).length;
    const outsideBefore = (await seenOutside(electronApp)).length;
    await page.evaluate((message) => {
      (globalThis as unknown as { acquireVsCodeApi(): { postMessage(m: unknown): void } })
        .acquireVsCodeApi()
        .postMessage(message);
    }, asked);
    sent.add(command);

    let got: ResponseMessage | undefined;
    if (answer !== undefined) {
      await expect
        .poll(
          async () => {
            got = (await answersSoFar(page)).find((msg, at) => at >= answersBefore && answer(msg));
            return got !== undefined;
          },
          { message: `an answer to ${command}`, timeout: budget ?? ANSWER_BUDGET_MS }
        )
        .toBe(true);
    }
    if (check !== undefined) {
      // What it did outside the app may land after its answer, or be all it
      // does: retried until it holds.
      await expect(async () =>
        check(got, (await seenOutside(electronApp)).slice(outsideBefore))
      ).toPass({ timeout: budget ?? 10_000 });
    }
  };
  // One after another: each changes what the next one acts on.
  for (const s of walk) await run(s); // eslint-disable-line no-await-in-loop

  // Every command, sent; the rebase replayed what its todo said, on main.
  expect([...sent].toSorted()).toEqual(Object.keys(EVERY_COMMAND).toSorted());
  expect(git("log", "-1", "--format=%s")).toBe("more commit");
  expect(git("merge-base", "--is-ancestor", "main", rebasedMore)).toBe("");
  // The one error box is the pull request's, for the forge with no provider:
  // nothing else failed in a way the user was told of.
  const outside = await seenOutside(electronApp);
  expect(outside.filter((seen) => seen.kind === "box" && seen.type === "error")).toHaveLength(1);

  // No handler threw — a throw reaching the main process is logged as an
  // error — and the webview reported no failure, which is logged too. A
  // command answering nothing has finished by the time the app is closed: the
  // page's messages reach the dispatch in order, and those handlers wait on
  // nothing.
  await electronApp.close();
  app = null;
  const logged = readFileSync(path.join(scratch, "userData", "logs", "main.log"), "utf8");
  expect(logged).not.toMatch(/"reportError"|ERROR: webview /);
  expect(logged).not.toContain("ERROR:");
});
