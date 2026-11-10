import * as fs from "node:fs";
import * as path from "node:path";

import type { GitCommandHandler } from "@ging/core/backend/gitClient";
import { findGitDirs, type WatchPath } from "@ging/core/backend/queries/gitDirs";
import { REPO_CHANGE_DEBOUNCE_MS } from "@ging/core/backend/utils/repoWatchPaths";

/** The stash's reflog, under the common dir: `git stash list` reads it, and
 *  every push, drop, pop and clear rewrites or removes it. */
const STASH_LOG = ["logs", "refs", "stash"];

/**
 * The one non-recursive watch that leads to `<commonDir>/logs/refs/stash`: the
 * deepest of its folders that exists, waiting for the next name on the way (a
 * fresh `git init` has no `logs` yet). Null when the common dir itself is gone.
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

/** Watch `target.glob` directly inside `target.base`, not recursively, calling
 *  `onEvent` whenever it is created, changed or deleted. */
export type WatchOne = (target: WatchPath, onEvent: () => void) => Disposable;

const watchKey = (target: WatchPath | null) =>
  target === null ? null : target.base + "\0" + target.glob;

/**
 * Watch the stash log under `commonDir`, moving the watch on every event as
 * folders on the way appear or go. Every event is reported, a folder's too:
 * git may write the log before the deeper watch is up.
 */
export function createStashLogWatch(deps: {
  commonDir: string;
  isDirectory: (dir: string) => boolean;
  watch: WatchOne;
  onChange: () => void;
}): Disposable {
  let current: { key: string; watch: Disposable } | null = null;
  let disposed = false;

  const attach = () => {
    const target = stashLogWatchTarget(deps.commonDir, deps.isDirectory);
    const key = watchKey(target);
    if (current !== null && current.key === key) return;
    current?.watch.dispose();
    current = target === null ? null : { key: key!, watch: deps.watch(target, onEvent) };
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

/** How the Stash side-view runs git. */
export type StashViewGit = {
  gitPath: () => string;
  gitEnv?: () => NodeJS.ProcessEnv;
  onCommand?: GitCommandHandler;
};

const isDirectoryOnDisk = (dir: string): boolean => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

/**
 * When the Stash side-view re-reads its list. It watches its repository's stash
 * log itself, only while visible, because the graph's watcher lives and dies
 * with the graph panel. Showing it, or a new repository while shown, re-reads
 * at once and again once the watch is up (a stash may land before it is);
 * stash-log events re-read after they go quiet.
 */
export function createStashViewWatch(deps: {
  git: StashViewGit;
  watch: WatchOne;
  /** Re-read the list now. */
  refresh: () => void;
  /** Where `repo`'s common dir is; null when git can't say. Defaults to
   *  asking git (`findGitDirs`). */
  findCommonDir?: (repo: string) => Promise<string | null>;
  isDirectory?: (dir: string) => boolean;
  debounceMs?: number;
}) {
  const debounceMs = deps.debounceMs ?? REPO_CHANGE_DEBOUNCE_MS;
  const isDirectory = deps.isDirectory ?? isDirectoryOnDisk;
  const findCommonDir =
    deps.findCommonDir ??
    (async (repo: string) =>
      (
        await findGitDirs({
          gitPath: deps.git.gitPath(),
          repoPath: repo,
          gitEnv: deps.git.gitEnv?.(),
          onCommand: deps.git.onCommand
        })
      )?.commonDir ?? null);
  // A repository's common dir doesn't move, so it is asked for once.
  const commonDirs = new Map<string, string>();
  let repo: string | null = null;
  let visible = false;
  let watch: Disposable | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped whenever what should be watched changes, so a lookup started for
   *  something else is dropped when it arrives. */
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

  const commonDirOf = async (of: string): Promise<string | null> => {
    const known = commonDirs.get(of);
    if (known !== undefined) return known;
    const found = await findCommonDir(of);
    if (found !== null) commonDirs.set(of, found);
    return found;
  };

  /** Drop what was watched; when shown on a repository, re-read and watch it. */
  const restart = () => {
    stop();
    if (!visible || repo === null) return;
    deps.refresh();
    const started = generation;
    void commonDirOf(repo).then(
      (commonDir) => {
        if (started !== generation || commonDir === null) return;
        watch = createStashLogWatch({ commonDir, isDirectory, watch: deps.watch, onChange });
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
      if (visible) restart();
    },
    setVisible(next: boolean) {
      if (next === visible) return;
      visible = next;
      restart();
    },
    dispose() {
      visible = false;
      stop();
    }
  };
}
