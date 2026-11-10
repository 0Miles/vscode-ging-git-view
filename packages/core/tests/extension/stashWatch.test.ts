import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { WatchPath } from "@ging/core/backend/queries/gitDirs";
import {
  createStashLogWatch,
  createStashViewWatch,
  STASH_REFRESH_DEBOUNCE_MS,
  stashLogWatchTarget
} from "@ging/core/extension/stashWatch";

const COMMON = path.join(path.sep, "repo", ".git");
const LOGS = path.join(COMMON, "logs");
const LOG_REFS = path.join(LOGS, "refs");

/** `isDirectory` over exactly these folders. */
const folders =
  (...dirs: string[]) =>
  (p: string) =>
    dirs.includes(p);

describe("stashLogWatchTarget", () => {
  it("watches logs/refs for the stash log once every folder on the way exists", () => {
    expect(stashLogWatchTarget(COMMON, folders(COMMON, LOGS, LOG_REFS))).toEqual({
      base: LOG_REFS,
      glob: "stash"
    });
  });

  it("waits in the common dir for logs after a fresh git init, which has no logs yet", () => {
    expect(stashLogWatchTarget(COMMON, folders(COMMON))).toEqual({ base: COMMON, glob: "logs" });
  });

  it("waits in logs for refs when only HEAD's reflog exists so far", () => {
    expect(stashLogWatchTarget(COMMON, folders(COMMON, LOGS))).toEqual({
      base: LOGS,
      glob: "refs"
    });
  });

  it("treats a file where a folder belongs as a folder still to come", () => {
    // `isDirectory` is false for a file named `logs`; the watch waits for it to
    // be replaced rather than descending into it.
    expect(stashLogWatchTarget(COMMON, folders(COMMON, LOG_REFS))).toEqual({
      base: COMMON,
      glob: "logs"
    });
  });

  it("watches nothing once the common dir itself is gone", () => {
    expect(stashLogWatchTarget(COMMON, folders())).toBeNull();
  });
});

/** A file system whose folders the test creates, and file-system watches the
 *  test fires: records which watches are live and how many changes were
 *  reported. */
function fakeFileSystem(...initial: string[]) {
  const dirs = new Set(initial);
  const live: { target: WatchPath; fire: () => void }[] = [];
  let changes = 0;
  const watch = createStashLogWatch({
    commonDir: COMMON,
    isDirectory: (p) => dirs.has(p),
    watch: (target, onEvent) => {
      const entry = { target, fire: onEvent };
      live.push(entry);
      return { dispose: () => live.splice(live.indexOf(entry), 1) };
    },
    onChange: () => changes++
  });
  return {
    watch,
    mkdir: (...ps: string[]) => ps.forEach((p) => dirs.add(p)),
    rmdir: (p: string) => dirs.delete(p),
    watched: () => live.map((w) => w.target),
    /** Fire the (only) live watch, as its folder reporting its entry. */
    fire: () => live[0].fire(),
    /** The (only) live watch's event handler, to call later. */
    handler: () => live[0].fire,
    changes: () => changes
  };
}

describe("createStashLogWatch", () => {
  it("re-attaches one folder deeper at a time as git creates them, reporting each step", () => {
    const fsys = fakeFileSystem(COMMON);
    expect(fsys.watched()).toEqual([{ base: COMMON, glob: "logs" }]);

    fsys.mkdir(LOGS);
    fsys.fire();
    expect(fsys.watched()).toEqual([{ base: LOGS, glob: "refs" }]);

    fsys.mkdir(LOG_REFS);
    fsys.fire();
    expect(fsys.watched()).toEqual([{ base: LOG_REFS, glob: "stash" }]);
    // A folder's appearance is also reported: the stash log may have been
    // written in it before the deeper watch was up.
    expect(fsys.changes()).toBe(2);
  });

  it("jumps straight to the deepest folder when git made several at once", () => {
    const fsys = fakeFileSystem(COMMON);
    fsys.mkdir(LOGS, LOG_REFS);
    fsys.fire();
    expect(fsys.watched()).toEqual([{ base: LOG_REFS, glob: "stash" }]);
  });

  it("keeps the same watch on the stash log across pushes and a clear, reporting each", () => {
    const fsys = fakeFileSystem(COMMON, LOGS, LOG_REFS);
    fsys.fire(); // git stash push: the log is created
    fsys.fire(); // git stash clear: the log is deleted
    expect(fsys.watched()).toEqual([{ base: LOG_REFS, glob: "stash" }]);
    expect(fsys.changes()).toBe(2);
  });

  it("moves back up when a folder on the way is removed", () => {
    const fsys = fakeFileSystem(COMMON, LOGS, LOG_REFS);
    fsys.rmdir(LOG_REFS);
    fsys.fire();
    expect(fsys.watched()).toEqual([{ base: LOGS, glob: "refs" }]);
  });

  it("watches nothing when the common dir is missing", () => {
    expect(fakeFileSystem().watched()).toEqual([]);
  });

  it("lets go of its watch and reports nothing more once disposed", () => {
    const fsys = fakeFileSystem(COMMON, LOGS, LOG_REFS);
    const lateEvent = fsys.handler();
    fsys.watch.dispose();
    expect(fsys.watched()).toEqual([]);
    // An event already on its way when the watch went still arrives.
    lateEvent();
    expect(fsys.watched()).toEqual([]);
    expect(fsys.changes()).toBe(0);
  });
});

/** A Stash side-view's watch over fakes: common dirs resolve when the test
 *  says, and the test fires changes in the live watch. */
function fakeView() {
  const pending: { repo: string; resolve: (dir: string | null) => Promise<void> }[] = [];
  const live = new Map<string, () => void>();
  let refreshes = 0;
  const view = createStashViewWatch({
    findCommonDir: (repo) =>
      new Promise((resolve) => {
        pending.push({
          repo,
          resolve: async (dir) => {
            resolve(dir);
            await settle();
          }
        });
      }),
    watchStashLog: (commonDir, onChange) => {
      live.set(commonDir, onChange);
      return { dispose: () => live.delete(commonDir) };
    },
    refresh: () => refreshes++
  });
  return {
    view,
    pending,
    /** Resolve the oldest outstanding common-dir lookup. */
    resolveNext: (dir: string | null) => pending.shift()!.resolve(dir),
    watched: () => [...live.keys()],
    fire: (commonDir: string) => live.get(commonDir)!(),
    refreshes: () => refreshes
  };
}

/** Let resolved lookups run their continuations. Microtasks only, so it works
 *  under fake timers. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** A visible view on `/repo`, watching `/repo/.git`, refreshed once. */
async function watchingView() {
  const t = fakeView();
  t.view.setRepo("/repo");
  t.view.setVisible(true);
  await t.resolveNext("/repo/.git");
  return t;
}

describe("createStashViewWatch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes once and starts watching the repository when the view becomes visible", async () => {
    const t = fakeView();
    t.view.setRepo("/repo");
    expect(t.refreshes()).toBe(0);
    expect(t.pending).toEqual([]);

    t.view.setVisible(true);
    expect(t.refreshes()).toBe(1);
    expect(t.pending.map((p) => p.repo)).toEqual(["/repo"]);
    await t.resolveNext("/repo/.git");
    expect(t.watched()).toEqual(["/repo/.git"]);
  });

  it("stops watching while hidden, and refreshes again when shown", async () => {
    const t = await watchingView();
    t.view.setVisible(false);
    expect(t.watched()).toEqual([]);

    t.view.setVisible(true);
    expect(t.refreshes()).toBe(2);
    await t.resolveNext("/repo/.git");
    expect(t.watched()).toEqual(["/repo/.git"]);
  });

  it("refreshes once the stash log has been quiet for the debounce", async () => {
    vi.useFakeTimers();
    const t = await watchingView();
    t.fire("/repo/.git");
    vi.advanceTimersByTime(STASH_REFRESH_DEBOUNCE_MS - 1);
    t.fire("/repo/.git");
    vi.advanceTimersByTime(STASH_REFRESH_DEBOUNCE_MS - 1);
    expect(t.refreshes()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(t.refreshes()).toBe(2);
  });

  it("drops a pending refresh when hidden", async () => {
    vi.useFakeTimers();
    const t = await watchingView();
    t.fire("/repo/.git");
    t.view.setVisible(false);
    vi.advanceTimersByTime(STASH_REFRESH_DEBOUNCE_MS);
    expect(t.refreshes()).toBe(1);
  });

  it("follows a new repository while visible: refreshes and moves the watch", async () => {
    const t = await watchingView();
    t.view.setRepo("/other");
    expect(t.refreshes()).toBe(2);
    expect(t.watched()).toEqual([]);
    await t.resolveNext("/other/.git");
    expect(t.watched()).toEqual(["/other/.git"]);
  });

  it("waits until shown to read a repository chosen while hidden", async () => {
    const t = await watchingView();
    t.view.setVisible(false);
    t.view.setRepo("/other");
    expect(t.refreshes()).toBe(1);
    expect(t.pending).toEqual([]);
    t.view.setVisible(true);
    expect(t.refreshes()).toBe(2);
    expect(t.pending.map((p) => p.repo)).toEqual(["/other"]);
  });

  it("never starts a watch for a repository it moved off while finding its git dir", async () => {
    const t = fakeView();
    t.view.setRepo("/repo");
    t.view.setVisible(true);
    t.view.setRepo("/other");
    await t.resolveNext("/repo/.git");
    expect(t.watched()).toEqual([]);
    await t.resolveNext("/other/.git");
    expect(t.watched()).toEqual(["/other/.git"]);
  });

  it("never starts a watch for a view hidden while finding its git dir", async () => {
    const t = fakeView();
    t.view.setRepo("/repo");
    t.view.setVisible(true);
    t.view.setVisible(false);
    await t.resolveNext("/repo/.git");
    expect(t.watched()).toEqual([]);
  });

  it("with no repository, refreshes (to show the no-repository text) and watches nothing", () => {
    const t = fakeView();
    t.view.setVisible(true);
    expect(t.refreshes()).toBe(1);
    expect(t.pending).toEqual([]);
  });

  it("watches nothing when git can't say where the repository's git dir is", async () => {
    const t = fakeView();
    t.view.setRepo("/gone");
    t.view.setVisible(true);
    await t.resolveNext(null);
    expect(t.watched()).toEqual([]);
  });

  it("lets go of everything on dispose", async () => {
    vi.useFakeTimers();
    const t = await watchingView();
    t.fire("/repo/.git");
    t.view.dispose();
    expect(t.watched()).toEqual([]);
    vi.advanceTimersByTime(STASH_REFRESH_DEBOUNCE_MS);
    expect(t.refreshes()).toBe(1);
  });
});
