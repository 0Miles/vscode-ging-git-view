import * as vscode from "vscode";

import { doesPathExist, isDirectory } from "@ging/core/backend/utils/path";
import { debouncedBatch, inFlightWork } from "@ging/core/extension/debouncedBatch";
import { getPathFromUri } from "@ging/vscode/backend/utils/uri";
import { Config } from "@ging/vscode/config";

import { RepoManager } from "./repoManager";
import { RepoSearch } from "./workspaceSearch";

type WorkspaceApi = Pick<
  typeof vscode.workspace,
  "createFileSystemWatcher" | "onDidChangeWorkspaceFolders" | "workspaceFolders"
>;

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

  /** The folder a watcher event is about — a repo's `.git` stands for the repo
   *  itself — or `null` for an event inside a `.git` directory. */
  function folderOf(uri: vscode.Uri): string | null {
    const path = getPathFromUri(uri);
    if (path.indexOf("/.git/") > -1) return null;
    return path.endsWith("/.git") ? path.slice(0, -5) : path;
  }

  const queueInto = (batch: ReturnType<typeof debouncedBatch>) => (uri: vscode.Uri) => {
    const path = folderOf(uri);
    if (path !== null) batch.add(path);
  };
  const onWatcherCreate = queueInto(createdPaths);
  const onWatcherChange = queueInto(changedPaths);

  function onWatcherDelete(uri: vscode.Uri) {
    const path = folderOf(uri);
    if (path !== null && repoManager.removeReposWithinFolder(path)) repoManager.sendRepos();
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
      // A batch still waiting out its debounce never reaches the repo manager
      // once the watcher is gone.
      createdPaths.cancel();
      changedPaths.cancel();
      const folders = Object.keys(folderWatchers);
      for (const folder of folders) {
        stopWatchingFolder(folder);
      }
    }
  };
}

export type RepoWatcher = ReturnType<typeof createRepoWatcher>;
