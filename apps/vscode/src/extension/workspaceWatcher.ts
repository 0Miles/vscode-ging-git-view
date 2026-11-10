import * as vscode from "vscode";

import { doesPathExist, isDirectory } from "@ging/core/backend/utils/path";
import { getPathFromUri } from "@ging/vscode/backend/utils/uri";
import { Config } from "@ging/vscode/config";

import { RepoManager } from "./repoManager";
import { RepoSearch } from "./workspaceSearch";

type WorkspaceApi = Pick<
  typeof vscode.workspace,
  "createFileSystemWatcher" | "onDidChangeWorkspaceFolders" | "workspaceFolders"
>;

/**
 * A queue of paths waiting for the debounce to fire, deduplicated while they
 * wait.
 *
 * Both halves are needed. The array is the queue because the drain is ordered
 * and re-entrant — each path is awaited, so more events arrive mid-drain — and
 * the Set is membership only. Membership used to be `indexOf`, which is fine
 * for the handful of events a hand edit produces and quadratic for the tens of
 * thousands that a branch switch, a build, or an `npm install` produces: every
 * event scans everything still queued, and the debounce is reset by each one,
 * so nothing drains while they pile up. That scan runs on the extension host's
 * shared thread, where it is not this extension it stalls.
 */
function pathQueue() {
  const queue: string[] = [];
  const queued = new Set<string>();
  return {
    /** Queue the path, reporting whether it was not already waiting. */
    add(path: string): boolean {
      if (queued.has(path)) return false;
      queued.add(path);
      queue.push(path);
      return true;
    },
    /** The next path to process, or `undefined` when the queue is empty. */
    next(): string | undefined {
      const path = queue.shift();
      if (path !== undefined) queued.delete(path);
      return path;
    }
  };
}

/** Work that has started and not yet settled, for a flush to wait out. */
function inFlightWork() {
  const running = new Set<Promise<void>>();
  return {
    track(work: Promise<void>): void {
      running.add(work);
      // `finally`, not `then(done, done)`: work that fails must still surface
      // as the unhandled rejection it always was, not be swallowed here.
      void work.finally(() => running.delete(work));
    },
    /** Settle once nothing tracked is running, including work tracked meanwhile. */
    async settled(): Promise<void> {
      while (running.size > 0) await Promise.allSettled(running);
    }
  };
}

/**
 * Paths handled together once they stop arriving for `delay`: each is passed to
 * `handle` in turn, including any queued while the batch runs, and `onChanged`
 * is called once at the end if any of them reported a change.
 */
function debouncedBatch(
  handle: (path: string) => Promise<boolean>,
  onChanged: () => void,
  delay: number
) {
  const paths = pathQueue();
  const inFlight = inFlightWork();
  let timeout: NodeJS.Timeout | null = null;

  async function drain() {
    let path;
    let changes = false;
    while ((path = paths.next())) {
      if (await handle(path)) changes = true;
    }
    if (changes) onChanged();
  }

  function run() {
    // Cleared when the timer fires, not when the drain ends: an event arriving
    // mid-drain sets a new timer, and that handle must not be dropped.
    timeout = null;
    inFlight.track(drain());
  }

  return {
    /** Queue the path and restart the debounce, unless it is already queued. */
    add(path: string): void {
      if (!paths.add(path)) return;
      if (timeout !== null) clearTimeout(timeout);
      timeout = setTimeout(run, delay);
    },
    /** Run the batch now if it is waiting out its debounce, and settle once no
     *  batch is waiting or running. */
    async flush(): Promise<void> {
      do {
        if (timeout !== null) {
          clearTimeout(timeout);
          run();
        }
        await inFlight.settled();
      } while (timeout !== null);
    }
  };
}

export function createRepoWatcher(
  repoManager: RepoManager,
  config: Config,
  repoSearch: RepoSearch,
  workspace: WorkspaceApi = vscode.workspace,
  debounceDelay = 1000
) {
  const folderWatchers: { [workspace: string]: vscode.FileSystemWatcher } = {};
  const sendRepos = () => repoManager.sendRepos();
  const createdPaths = debouncedBatch(
    async (path) =>
      (await isDirectory(path)) &&
      (await repoSearch.searchDirectoryForRepos(path, config.maxDepthOfRepoSearch())),
    sendRepos,
    debounceDelay
  );
  const changedPaths = debouncedBatch(
    async (path) => !(await doesPathExist(path)) && repoManager.removeReposWithinFolder(path),
    sendRepos,
    debounceDelay
  );
  const folderChanges = inFlightWork();

  function onWatcherCreate(uri: vscode.Uri) {
    let path = getPathFromUri(uri);
    if (path.indexOf("/.git/") > -1) return;
    if (path.endsWith("/.git")) path = path.slice(0, -5);
    createdPaths.add(path);
  }

  function onWatcherChange(uri: vscode.Uri) {
    let path = getPathFromUri(uri);
    if (path.indexOf("/.git/") > -1) return;
    if (path.endsWith("/.git")) path = path.slice(0, -5);
    changedPaths.add(path);
  }

  function onWatcherDelete(uri: vscode.Uri) {
    let path = getPathFromUri(uri);
    if (path.indexOf("/.git/") > -1) return;
    if (path.endsWith("/.git")) path = path.slice(0, -5);
    if (repoManager.removeReposWithinFolder(path)) repoManager.sendRepos();
  }

  function startWatchingFolder(path: string) {
    const watcher = workspace.createFileSystemWatcher(path + "/**");
    watcher.onDidCreate((uri) => onWatcherCreate(uri));
    watcher.onDidChange((uri) => onWatcherChange(uri));
    watcher.onDidDelete((uri) => onWatcherDelete(uri));
    folderWatchers[path] = watcher;
  }

  function stopWatchingFolder(path: string) {
    folderWatchers[path].dispose();
    delete folderWatchers[path];
  }

  async function onFolderChange(e: vscode.WorkspaceFoldersChangeEvent) {
    if (e.added.length > 0) {
      let path: string;
      let changes = false;
      for (let i = 0; i < e.added.length; i++) {
        path = getPathFromUri(e.added[i].uri);
        if (await repoSearch.searchDirectoryForRepos(path, config.maxDepthOfRepoSearch()))
          changes = true;
        startWatchingFolder(path);
      }
      if (changes) repoManager.sendRepos();
    }
    if (e.removed.length > 0) {
      let changes = false;
      let path: string;
      for (let i = 0; i < e.removed.length; i++) {
        path = getPathFromUri(e.removed[i].uri);
        if (repoManager.removeReposWithinFolder(path)) changes = true;
        stopWatchingFolder(path);
      }
      if (changes) repoManager.sendRepos();
    }
  }

  const folderChangeHandler = workspace.onDidChangeWorkspaceFolders((e) =>
    folderChanges.track(onFolderChange(e))
  );

  return {
    startWatching() {
      const rootFolders = workspace.workspaceFolders;
      if (typeof rootFolders !== "undefined") {
        for (let i = 0; i < rootFolders.length; i++) {
          startWatchingFolder(getPathFromUri(rootFolders[i].uri));
        }
      }
    },
    /**
     * Run any batch still waiting out its debounce now, and settle once every
     * batch and workspace folder change has finished — including work they
     * queued while running. Once it resolves, nothing already reported to the
     * watcher can still reach the repo manager.
     *
     * For tests: the batches are timers over real file system checks, so a
     * fixed sleep can only guess they are done, and cannot show that no
     * further call is coming (#286).
     */
    async flushPending(): Promise<void> {
      await Promise.all([createdPaths.flush(), changedPaths.flush(), folderChanges.settled()]);
    },
    dispose() {
      folderChangeHandler.dispose();
      const folders = Object.keys(folderWatchers);
      for (const folder of folders) {
        stopWatchingFolder(folder);
      }
    }
  };
}

export type RepoWatcher = ReturnType<typeof createRepoWatcher>;
