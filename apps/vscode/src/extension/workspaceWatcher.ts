import * as vscode from "vscode";

import { doesPathExist, getPathFromUri, isDirectory } from "@/backend/utils/path";
import { Config } from "@/config";

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

export function createRepoWatcher(
  repoManager: RepoManager,
  config: Config,
  repoSearch: RepoSearch,
  workspace: WorkspaceApi = vscode.workspace,
  debounceDelay = 1000
) {
  const folderWatchers: { [workspace: string]: vscode.FileSystemWatcher } = {};
  const createEventPaths = pathQueue();
  const changeEventPaths = pathQueue();
  let processCreateEventsTimeout: NodeJS.Timeout | null = null;
  let processChangeEventsTimeout: NodeJS.Timeout | null = null;

  async function processCreateEvents() {
    let path;
    let changes = false;
    while ((path = createEventPaths.next())) {
      if (await isDirectory(path)) {
        if (await repoSearch.searchDirectoryForRepos(path, config.maxDepthOfRepoSearch()))
          changes = true;
      }
    }
    processCreateEventsTimeout = null;
    if (changes) repoManager.sendRepos();
  }

  async function processChangeEvents() {
    let path;
    let changes = false;
    while ((path = changeEventPaths.next())) {
      if (!(await doesPathExist(path))) {
        if (repoManager.removeReposWithinFolder(path)) changes = true;
      }
    }
    processChangeEventsTimeout = null;
    if (changes) repoManager.sendRepos();
  }

  async function onWatcherCreate(uri: vscode.Uri) {
    let path = getPathFromUri(uri);
    if (path.indexOf("/.git/") > -1) return;
    if (path.endsWith("/.git")) path = path.slice(0, -5);
    if (!createEventPaths.add(path)) return;

    if (processCreateEventsTimeout !== null) clearTimeout(processCreateEventsTimeout);
    processCreateEventsTimeout = setTimeout(() => processCreateEvents(), debounceDelay);
  }

  function onWatcherChange(uri: vscode.Uri) {
    let path = getPathFromUri(uri);
    if (path.indexOf("/.git/") > -1) return;
    if (path.endsWith("/.git")) path = path.slice(0, -5);
    if (!changeEventPaths.add(path)) return;

    if (processChangeEventsTimeout !== null) clearTimeout(processChangeEventsTimeout);
    processChangeEventsTimeout = setTimeout(() => processChangeEvents(), debounceDelay);
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

  const folderChangeHandler = workspace.onDidChangeWorkspaceFolders(async (e) => {
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
  });

  return {
    startWatching() {
      const rootFolders = workspace.workspaceFolders;
      if (typeof rootFolders !== "undefined") {
        for (let i = 0; i < rootFolders.length; i++) {
          startWatchingFolder(getPathFromUri(rootFolders[i].uri));
        }
      }
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
