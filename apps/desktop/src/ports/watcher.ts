/* The desktop `Watcher` (`@ging/core/host/ports`): the current repository's
 * folder watched with Node's own recursive `fs.watch`, filtered and debounced
 * as the VS Code host's RepoFileWatcher does; and the one non-recursive
 * watch the Stash side view needs of it (`watchOneOnDisk`). */

import * as fs from "node:fs";

import {
  isWatchedRepoPath,
  REPO_CHANGE_DEBOUNCE_MS,
  REPO_RESUME_GRACE_MS
} from "@ging/core/backend/utils/repoWatchPaths";
import type { WatchOne } from "@ging/core/extension/stashWatch";
import type { Watcher } from "@ging/core/host/ports";

export type DesktopWatcherOptions = {
  /** How long the watched files must stay quiet before the graph refreshes. */
  debounceMs?: number;
  /** How long after `unmute` changes are still ignored; see
   *  `REPO_RESUME_GRACE_MS`. */
  resumeGraceMs?: number;
  /** Told when a repository cannot be watched, or stops being watchable. */
  onError?: (message: string) => void;
};

export type DesktopWatcher = Watcher & {
  /** Watch nothing, and drop a refresh still waiting out the debounce. */
  stop(): void;
};

/**
 * Core's `WatchOne`, on disk: the name `target.glob` directly inside
 * `target.base`, watched without recursion — what the Stash side view's watch
 * hangs on (`createStashViewWatch`, #400). An event that names no file is
 * taken as one for it: Node leaves the name out where the platform does not
 * say. A folder that cannot be watched, or stops being watchable, is told to
 * `onError` and watched no longer.
 */
export function watchOneOnDisk(onError: (message: string) => void): WatchOne {
  return ({ base, glob }, onEvent) => {
    try {
      const watcher = fs.watch(base, (_event, file) => {
        if (file === null || file === glob) onEvent();
      });
      watcher.on("error", (e) => {
        onError(`Stopped watching ${glob} in ${base}: ${String(e)}`);
        watcher.close();
      });
      return { dispose: () => watcher.close() };
    } catch (e) {
      onError(`Cannot watch ${glob} in ${base}: ${String(e)}`);
      return { dispose: () => {} };
    }
  };
}

/** `onRepoChange` is the graph refresh: called once the watched repository
 *  has changed and gone quiet again, never for a change made while muted. */
export function createDesktopWatcher(
  onRepoChange: () => void,
  {
    debounceMs = REPO_CHANGE_DEBOUNCE_MS,
    resumeGraceMs = REPO_RESUME_GRACE_MS,
    onError = () => {}
  }: DesktopWatcherOptions = {}
): DesktopWatcher {
  let fsWatcher: fs.FSWatcher | null = null;
  let pending: NodeJS.Timeout | null = null;
  /** Changes are ignored until then: forever while muted, and for the grace
   *  after `unmute`. */
  let resumeAt = 0;

  const cancelPending = () => {
    if (pending !== null) clearTimeout(pending);
    pending = null;
  };

  const stop = () => {
    fsWatcher?.close();
    fsWatcher = null;
    cancelPending();
  };

  /** `file` is relative to the repository, in the platform's spelling; Node
   *  leaves it out when the platform does not say. */
  const changed = (file: string | null) => {
    if (Date.now() < resumeAt) return;
    if (file !== null && !isWatchedRepoPath(file.replace(/\\/g, "/"))) return;
    cancelPending();
    pending = setTimeout(() => {
      pending = null;
      onRepoChange();
    }, debounceMs);
  };

  return {
    start(repo) {
      stop();
      try {
        const watcher = fs.watch(repo, { recursive: true }, (_event, file) => changed(file));
        watcher.on("error", (e) => {
          onError(`Stopped watching ${repo}: ${String(e)}`);
          if (fsWatcher === watcher) stop();
        });
        fsWatcher = watcher;
      } catch (e) {
        onError(`Cannot watch ${repo}: ${String(e)}`);
      }
    },
    mute() {
      resumeAt = Infinity;
      // A refresh still waiting would land in the middle of GING's own
      // command; the refresh that follows the command covers its change too.
      cancelPending();
    },
    unmute() {
      resumeAt = Date.now() + resumeGraceMs;
    },
    stop
  };
}
