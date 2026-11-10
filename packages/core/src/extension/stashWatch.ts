import * as path from "node:path";

import type { WatchPath } from "@ging/core/backend/queries/gitDirs";

/** The stash's reflog, under the common dir: `git stash list` reads it, and
 *  every push, drop, pop and clear rewrites or removes it. */
const STASH_LOG = ["logs", "refs", "stash"];

/**
 * The one non-recursive watch that leads to `<commonDir>/logs/refs/stash`: the
 * deepest of its folders that exists, watched for the next name on the way.
 * Until `logs/refs` exists — a fresh `git init` has neither folder — the watch
 * sits higher up and waits for the next folder to appear. Null when the common
 * dir itself is gone.
 */
export function stashLogWatchTarget(
  commonDir: string,
  isDirectory: (dir: string) => boolean
): WatchPath | null {
  if (!isDirectory(commonDir)) return null;
  let base = commonDir;
  for (const name of STASH_LOG.slice(0, -1)) {
    const next = path.join(base, name);
    if (!isDirectory(next)) return { base, glob: name };
    base = next;
  }
  return { base, glob: STASH_LOG.at(-1)! };
}

/** Something to let go of: a watch, a watcher. */
export type Disposable = { dispose(): void };

/**
 * Watch the stash log of the repository whose common dir is `commonDir`, from
 * wherever `stashLogWatchTarget` says to, and report every event there as a
 * change. An event is also when the watch moves: the target is worked out
 * again, and a new one replaces the old — deeper once a folder on the way has
 * appeared, higher up if one has gone. A folder's appearance is reported too:
 * git creates the stash log along with its folders, possibly before the deeper
 * watch is up to see it.
 */
export function createStashLogWatch(deps: {
  commonDir: string;
  isDirectory: (dir: string) => boolean;
  /** Watch `target.glob` directly inside `target.base`, not recursively,
   *  calling `onEvent` whenever it is created, changed or deleted. */
  watch: (target: WatchPath, onEvent: () => void) => Disposable;
  onChange: () => void;
}): Disposable {
  let current: { target: WatchPath; watch: Disposable } | null = null;
  let disposed = false;

  const attach = () => {
    const target = stashLogWatchTarget(deps.commonDir, deps.isDirectory);
    if (
      current !== null &&
      target !== null &&
      current.target.base === target.base &&
      current.target.glob === target.glob
    ) {
      return;
    }
    current?.watch.dispose();
    current = target === null ? null : { target, watch: deps.watch(target, onEvent) };
  };

  function onEvent() {
    if (disposed) return;
    attach();
    deps.onChange();
  }

  attach();
  return {
    dispose() {
      disposed = true;
      current?.watch.dispose();
      current = null;
    }
  };
}

/** How long the Stash side-view waits for its stash log to go quiet before it
 *  re-reads the list: the graph's own watcher's debounce (`RepoFileWatcher`). */
export const STASH_REFRESH_DEBOUNCE_MS = 750;

/**
 * When the Stash side-view re-reads its list, and what it watches to know: the
 * stash log of its repository (the current repository), and only while the
 * view is visible. It is the view's own watch — the graph's watcher lives and
 * dies with the graph panel — so the view keeps up with the graph closed.
 *
 * - Becoming visible re-reads straight away: nothing watched while hidden.
 *   Once the watch is up it counts as a change too, since the list was read
 *   before anything watched the stash log.
 * - A new repository is re-read straight away when visible, and waits for the
 *   view to be shown otherwise.
 * - A change in the stash log is re-read once it has been quiet for
 *   `debounceMs`.
 * - Finding where the stash log lives takes a git run, so the watch starts
 *   asynchronously; one whose repository or visibility changed meanwhile is
 *   never started. A repository whose common dir can't be found is not
 *   watched until the view is next shown.
 */
export function createStashViewWatch(deps: {
  /** The common dir of `repo` (`findGitDirs`); null when git can't say. */
  findCommonDir: (repo: string) => Promise<string | null>;
  /** Watch the stash log under `commonDir` (`createStashLogWatch`). */
  watchStashLog: (commonDir: string, onChange: () => void) => Disposable;
  /** Re-read the list now. */
  refresh: () => void;
  debounceMs?: number;
}) {
  const debounceMs = deps.debounceMs ?? STASH_REFRESH_DEBOUNCE_MS;
  let repo: string | null = null;
  let visible = false;
  let watch: Disposable | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped whenever what should be watched changes, so a lookup that was
   *  started for something else is dropped when it arrives. */
  let generation = 0;

  const stop = () => {
    generation++;
    watch?.dispose();
    watch = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const onChange = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      deps.refresh();
    }, debounceMs);
  };

  const start = () => {
    if (repo === null) return;
    const started = generation;
    void deps.findCommonDir(repo).then(
      (commonDir) => {
        if (started !== generation || commonDir === null) return;
        watch = deps.watchStashLog(commonDir, onChange);
        // The list was read before anything watched it; a stash may have
        // landed meanwhile.
        onChange();
      },
      () => {}
    );
  };

  return {
    /** The view now lists `repo`'s stashes. */
    setRepo(next: string | null) {
      if (next === repo) return;
      repo = next;
      if (!visible) return;
      stop();
      deps.refresh();
      start();
    },
    setVisible(next: boolean) {
      if (next === visible) return;
      visible = next;
      stop();
      if (!visible) return;
      deps.refresh();
      start();
    },
    dispose() {
      visible = false;
      stop();
    }
  };
}
