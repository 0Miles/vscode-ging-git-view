import * as fs from "node:fs";

import * as vscode from "vscode";

import {
  applyExternalConfig,
  EXTERNAL_CONFIG_RELATIVE_PATH,
  generateExternalConfig,
  readExternalConfig,
  serializeExternalConfig
} from "@ging/core/backend/utils/externalConfig";
import { isGitRepository } from "@ging/core/backend/utils/git";
import { evalPromises } from "@ging/core/backend/utils/promise";
import { pickBootRepo, REPO_EXISTENCE_CHECKS_AT_ONCE } from "@ging/core/backend/utils/repoPath";
import { ExtensionState } from "@ging/core/extensionState";
import { GitRepoSet, GitRepoState } from "@ging/shared/types";
import { getPathFromUri } from "@ging/vscode/backend/utils/uri";
import { Config } from "@ging/vscode/config";
import { StatusBarItem } from "@ging/vscode/statusBarItem";

export type RepoChangeCallback = (repos: GitRepoSet, numRepos: number) => void;
/** Told of every repo-state write: the state it replaced (undefined for a repo
 *  the manager did not hold) and the state it wrote. */
export type RepoStateWriteCallback = (
  repo: string,
  before: GitRepoState | undefined,
  after: GitRepoState
) => void;

function sortRepos(repos: GitRepoSet) {
  const repoPaths = Object.keys(repos).toSorted();
  const sorted: GitRepoSet = {};
  for (let i = 0; i < repoPaths.length; i++) {
    sorted[repoPaths[i]] = repos[repoPaths[i]];
  }
  return sorted;
}

export function createRepoManager(
  extensionState: ExtensionState,
  statusBarItem: StatusBarItem,
  config: Config
) {
  let repos = extensionState.getRepos();
  const viewCallbacks = new Set<RepoChangeCallback>();
  const stateWriteCallbacks = new Set<RepoStateWriteCallback>();

  function getRepos() {
    return sortRepos(repos);
  }

  function sendRepos() {
    const sorted = getRepos();
    const numRepos = Object.keys(sorted).length;
    statusBarItem.setNumRepos(numRepos);
    for (const cb of viewCallbacks) cb(sorted, numRepos);
  }

  function removeRepo(repo: string) {
    delete repos[repo];
    extensionState.saveRepos(repos);
  }

  /** Remove `repo` and broadcast the set without it. */
  function dropRepo(repo: string) {
    removeRepo(repo);
    sendRepos();
  }

  function registerViewCallback(cb: RepoChangeCallback) {
    viewCallbacks.add(cb);
  }

  function deregisterViewCallback(cb: RepoChangeCallback) {
    viewCallbacks.delete(cb);
  }

  function isDirectoryWithinRepos(path: string) {
    const repoPaths = Object.keys(repos);
    for (let i = 0; i < repoPaths.length; i++) {
      if (path === repoPaths[i] || path.startsWith(repoPaths[i] + "/")) return true;
    }
    return false;
  }

  function addRepo(repo: string) {
    let state: GitRepoState = { columnWidths: null };
    // Apply any committed GING config so a freshly-discovered repo picks up
    // the team's shared settings.
    const external = readExternalConfig(repo);
    if (external !== null) state = applyExternalConfig(external, state);
    repos[repo] = state;
    extensionState.saveRepos(repos);
  }

  /** Write the repo's shareable GING config to its .vscode file.
   *  Returns an error message, or null on success. */
  function exportRepoConfig(repo: string): string | null {
    try {
      fs.mkdirSync(repo + "/.vscode", { recursive: true });
      fs.writeFileSync(
        repo + "/" + EXTERNAL_CONFIG_RELATIVE_PATH,
        serializeExternalConfig(generateExternalConfig(repos[repo]))
      );
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  function removeReposWithinFolder(path: string) {
    const pathFolder = path + "/";
    const repoPaths = Object.keys(repos);
    let changes = false;
    for (let i = 0; i < repoPaths.length; i++) {
      if (repoPaths[i] === path || repoPaths[i].startsWith(pathFolder)) {
        removeRepo(repoPaths[i]);
        changes = true;
      }
    }
    return changes;
  }

  function setRepoState(repo: string, state: GitRepoState) {
    const before = repos[repo];
    repos[repo] = state;
    extensionState.saveRepos(repos);
    for (const cb of stateWriteCallbacks) cb(repo, before, state);
  }

  /** See `RepoSource.updateRepoState`: the state is read here, at the write,
   *  not wherever the caller read it before asking the user something. */
  function updateRepoState(repo: string, patch: Partial<GitRepoState>) {
    const current = repos[repo];
    if (current === undefined) return;
    setRepoState(repo, { ...current, ...patch });
    sendRepos();
  }

  /** Listen to every repo-state write, whoever made it — so what depends on a
   *  field (the Branches side-view on its toggles) follows it without each
   *  writer having to remember to say so. */
  function onDidWriteRepoState(cb: RepoStateWriteCallback): vscode.Disposable {
    stateWriteCallbacks.add(cb);
    return { dispose: () => stateWriteCallbacks.delete(cb) };
  }

  function removeReposNotInWorkspace() {
    const rootsExact: string[] = [];
    const rootsFolder: string[] = [];
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const repoPaths = Object.keys(repos);
    if (typeof workspaceFolders !== "undefined") {
      for (let i = 0; i < workspaceFolders.length; i++) {
        const path = getPathFromUri(workspaceFolders[i].uri);
        rootsExact.push(path);
        rootsFolder.push(path + "/");
      }
    }
    for (let i = 0; i < repoPaths.length; i++) {
      if (
        rootsExact.indexOf(repoPaths[i]) === -1 &&
        !rootsFolder.find((x) => repoPaths[i].startsWith(x))
      )
        removeRepo(repoPaths[i]);
    }
  }

  function checkReposExist() {
    return new Promise<boolean>((resolve) => {
      const repoPaths = Object.keys(repos);
      let changes = false;
      evalPromises(repoPaths, REPO_EXISTENCE_CHECKS_AT_ONCE, (path) =>
        isGitRepository(path, config.gitPath())
      ).then((results) => {
        for (let i = 0; i < repoPaths.length; i++) {
          if (!results[i]) {
            removeRepo(repoPaths[i]);
            changes = true;
          }
        }
        if (changes) sendRepos();
        resolve(changes);
      });
    });
  }

  /** Which repo the graph boots on. Every webview handshake takes its seed from
   *  here rather than letting the webview pick one out of the repo set: the set
   *  is persisted and can name directories that are gone, and only the host can
   *  tell. Not folded into `getRepos` — that has 22 callers, and the panel
   *  rebuilds its HTML every time it becomes visible again. */
  function getBootRepo() {
    return pickBootRepo(extensionState.getLastActiveRepo(), Object.keys(getRepos()));
  }

  return {
    registerViewCallback,
    deregisterViewCallback,
    getRepos,
    getBootRepo,
    isDirectoryWithinRepos,
    sendRepos,
    addRepo,
    exportRepoConfig,
    removeRepo,
    dropRepo,
    removeReposWithinFolder,
    setRepoState,
    updateRepoState,
    onDidWriteRepoState,
    removeReposNotInWorkspace,
    checkReposExist
  };
}

export type RepoManager = ReturnType<typeof createRepoManager>;
