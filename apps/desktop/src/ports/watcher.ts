/* The desktop `Watcher` (`@ging/core/host/ports`): the current repository's
 * folder watched with Node's own recursive `fs.watch`, filtered and debounced
 * as the VS Code host's RepoFileWatcher does. */

import * as fs from "node:fs";

import {
  isWatchedRepoPath,
  REPO_CHANGE_DEBOUNCE_MS
} from "@ging/core/backend/utils/repoWatchPaths";
import type { Watcher } from "@ging/core/host/ports";

/** How long after `unmute` changes are still ignored. GING's own git command
 *  has finished by then, but the file system may still be reporting what it
 *  did; the VS Code host waits as long. */
const RESUME_GRACE_MS = 1500;

export type DesktopWatcherOptions = {
  /** How long the watched files must stay quiet before the graph refreshes. */
  debounceMs?: number;
  /** See `RESUME_GRACE_MS`. */
  resumeGraceMs?: number;
  /** Told when a repository cannot be watched, or stops being watchable. */
  onError?: (message: string) => void;
};

export type DesktopWatcher = Watcher & {
  /** Watch nothing, and drop a refresh still waiting out the debounce. */
  stop(): void;
};

/** `onRepoChange` is the graph refresh: called once the watched repository
 *  has changed and gone quiet again, never for a change made while muted. */
export function createDesktopWatcher(
  onRepoChange: () => void,
  {
    debounceMs = REPO_CHANGE_DEBOUNCE_MS,
    resumeGraceMs = RESUME_GRACE_MS,
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
