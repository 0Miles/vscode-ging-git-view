import * as assert from "node:assert";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import * as vscode from "vscode";

import { REPO_CHANGE_DEBOUNCE_MS } from "@ging/core/backend/utils/repoWatchPaths";
import { loadStashFiles, loadStashList } from "@ging/core/extension/stashList";
import { createStashViewWatch } from "@ging/core/extension/stashWatch";
import { config } from "@ging/vscode/config";
import { findGraphTabs } from "@ging/vscode/extension/graphPanelWindow";
import {
  STASH_ACTIONS,
  type StashAction,
  stashActionCommand
} from "@ging/vscode/extension/stashActions";
import { watchPaths } from "@ging/vscode/extension/watchPaths";

import { makeRepo, rev, rmrf } from "@ging/core/tests/helpers";

/** Run git in `cwd` as a committer every test repo can use, whether or not
 *  it was made by `makeRepo` (a bare `git init` has no identity). */
function git(args: string[], cwd: string): void {
  cp.execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@t.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdio: "pipe" }
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long a watch gets to come up after the view is shown: a git run to find
 *  the common dir, then VS Code's watcher. */
const WATCH_UP_MS = 1500;

/** How long a change may take to reach the list: the debounce, plus room for
 *  the file watcher's own latency and the git run that re-reads. */
const REACH_MS = REPO_CHANGE_DEBOUNCE_MS + 4000;

// The Stash side-view's own watch over real repositories, with the graph panel
// closed: the view is refreshed by `createStashViewWatch` over `watchPaths`
// alone — the wiring `createStashView` uses — and never by the graph's
// `RepoFileWatcher`, which only exists while a graph panel does. Each refresh
// re-reads the stash list the way the view does, and each scenario waits for
// that list to show what git did.
suite("Stash side-view watch (graph panel closed)", function () {
  this.timeout(30_000);

  const dirs: string[] = [];
  let dispose: (() => void) | null = null;

  // An earlier suite may have left a graph open; close it, so nothing but the
  // view's own watch is left to notice a stash.
  suiteSetup(async () => {
    await vscode.window.tabGroups.close(findGraphTabs(vscode.window.tabGroups.all));
    assert.strictEqual(findGraphTabs(vscode.window.tabGroups.all).length, 0);
  });

  teardown(() => {
    dispose?.();
    dispose = null;
    for (const dir of dirs.splice(0)) rmrf(dir);
  });

  /** A visible Stash side-view on `repo`, its watch up; `messages` is the
   *  stash list as its last refresh read it. */
  async function visibleViewOn(repo: string) {
    const state = { refreshes: 0, messages: null as string[] | null };
    const watch = createStashViewWatch({
      git: { gitPath: config.gitPath },
      watch: (target, onEvent) => watchPaths([target], onEvent),
      refresh: () => {
        state.refreshes++;
        void loadStashList(simpleGit(repo)).then((items) => {
          state.messages = items.map((item) => item.message);
        });
      }
    });
    dispose = () => watch.dispose();
    watch.setRepo(repo);
    watch.setVisible(true);
    assert.strictEqual(state.refreshes, 1, "shown: refreshed straight away");
    await sleep(WATCH_UP_MS);
    return state;
  }

  /** Wait until the view's list is `expected`, failing after `REACH_MS`. */
  async function untilListed(state: { messages: string[] | null }, expected: string[]) {
    const deadline = Date.now() + REACH_MS;
    while (Date.now() < deadline) {
      if (JSON.stringify(state.messages) === JSON.stringify(expected)) return;
      // eslint-disable-next-line no-await-in-loop -- polling: each wait precedes the next look
      await sleep(50);
    }
    assert.deepStrictEqual(state.messages, expected);
  }

  const newRepo = () => {
    const repo = makeRepo();
    dirs.push(repo);
    return repo;
  };

  test("1. the first stash push in a repository with commits", async () => {
    const repo = newRepo();
    const view = await visibleViewOn(repo);
    await untilListed(view, []);

    fs.writeFileSync(path.join(repo, "f"), "changed");
    git(["stash", "push", "-m", "first"], repo);

    await untilListed(view, ["On main: first"]);
  });

  test("2. from a fresh git init: a commit, then a stash push", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-test-"));
    dirs.push(repo);
    git(["init", "--template=", "-b", "main"], repo);
    assert.ok(!fs.existsSync(path.join(repo, ".git", "logs")), "a fresh repo has no logs yet");
    const view = await visibleViewOn(repo);
    await untilListed(view, []);

    fs.writeFileSync(path.join(repo, "f"), "x");
    git(["add", "f"], repo);
    git(["commit", "-m", "init"], repo);
    // Let the watch move down to logs/refs before the stash log appears in it.
    await sleep(WATCH_UP_MS);
    fs.writeFileSync(path.join(repo, "f"), "changed");
    git(["stash", "push", "-m", "after init"], repo);

    await untilListed(view, ["On main: after init"]);
  });

  test("3. git stash clear", async () => {
    const repo = newRepo();
    fs.writeFileSync(path.join(repo, "f"), "changed");
    git(["stash", "push", "-m", "doomed"], repo);
    const view = await visibleViewOn(repo);
    await untilListed(view, ["On main: doomed"]);

    git(["stash", "clear"], repo);

    await untilListed(view, []);
  });

  test("4. a stash push in another linked worktree", async () => {
    const repo = newRepo();
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-test-wt-"));
    dirs.push(worktree);
    fs.rmdirSync(worktree);
    git(["worktree", "add", "-b", "side", worktree], repo);
    const view = await visibleViewOn(repo);
    await untilListed(view, []);

    fs.writeFileSync(path.join(worktree, "f"), "changed");
    git(["stash", "push", "-m", "from the worktree"], worktree);

    await untilListed(view, ["On side: from the worktree"]);
  });
});

// What a click on an expanded stash's file, and Copy Stash Name, do through the
// commands the activated extension registers for the view.
suite("Stash side-view commands (integration)", function () {
  this.timeout(30_000);
  let repo: string;
  let stash: string;

  suiteSetup(async () => {
    // The commands and the diff document provider are the extension's.
    await vscode.extensions.getExtension("0miles.ging-git-view")!.activate();
    repo = makeRepo();
    fs.writeFileSync(path.join(repo, "f"), "changed");
    fs.writeFileSync(path.join(repo, "new.txt"), "untracked");
    git(["stash", "push", "--include-untracked", "-m", "both"], repo);
    stash = rev(repo, "stash@{0}");
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    rmrf(repo);
  });

  /** Open `file`'s diff as a click on it does; the two sides' text. */
  async function openDiff(file: string) {
    const files = await loadStashFiles(simpleGit(repo), repo, stash);
    const entry = files!.find((f) => f.diff.newFilePath === file)!;
    await vscode.commands.executeCommand("ging-git-view.stash.openFileDiff", entry.diff);
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(input instanceof vscode.TabInputTextDiff, "a diff editor opened");
    const textOf = async (uri: vscode.Uri) =>
      (await vscode.workspace.openTextDocument(uri)).getText();
    return { left: await textOf(input.original), right: await textOf(input.modified) };
  }

  test("a tracked file diffs the stash's base against the stash", async () => {
    assert.deepStrictEqual(await openDiff("f"), { left: "x", right: "changed" });
  });

  test("an untracked file diffs nothing against the stashed file", async () => {
    assert.deepStrictEqual(await openDiff("new.txt"), { left: "", right: "untracked" });
  });

  /** The view's item for the suite's stash, as listed at stash@{0}. */
  const listedItem = () => ({
    kind: "stash",
    repo,
    stash: { id: stash, hash: stash, selector: "stash@{0}", message: "On main: both", date: 0 }
  });

  test("Copy Stash Name copies the shown name while the stash still sits there", async () => {
    await vscode.env.clipboard.writeText("untouched");

    const outcome = await vscode.commands.executeCommand(
      "ging-git-view.stash.copyName",
      listedItem()
    );

    assert.strictEqual(outcome, "copied");
    assert.strictEqual(await vscode.env.clipboard.readText(), "stash@{0}");
  });

  // Apply, Pop, Drop and Rename ask first, through a modal and an input box
  // the extension host cannot answer, so what they do once asked is pinned by
  // their core tests (`applyOrPopListedStash`, `dropListedStash`,
  // `renameListedStash`). Here: that every stash
  // action is a registered command, and that one handed anything but a
  // listed stash asks nothing and does nothing.
  test("every stash action is registered, and ignores anything but a listed stash", async () => {
    const actions = Object.keys(STASH_ACTIONS) as StashAction[];
    const registered = new Set(await vscode.commands.getCommands(true));
    const outcomes = await Promise.all(
      actions.map((action) => {
        assert.ok(registered.has(stashActionCommand(action)), action);
        return vscode.commands.executeCommand(stashActionCommand(action), { kind: "file" });
      })
    );
    assert.deepStrictEqual(
      outcomes,
      actions.map(() => undefined)
    );
  });

  // #333: a stash whose position changed is refused, not redirected.
  test("Copy Stash Name copies nothing once the stash has moved, and refreshes", async () => {
    const item = listedItem();
    // A newer stash pushes this one down after the list was read.
    fs.writeFileSync(path.join(repo, "f"), "again");
    git(["stash", "push", "-m", "newer"], repo);
    await vscode.env.clipboard.writeText("untouched");

    const outcome = await vscode.commands.executeCommand("ging-git-view.stash.copyName", item);

    // "refused" is the branch of `copyStashName` that warns and refreshes; its
    // core test pins both calls, since the TreeView's re-read can't be read
    // back from the extension host.
    assert.strictEqual(outcome, "refused");
    assert.strictEqual(await vscode.env.clipboard.readText(), "untouched");
  });
});
