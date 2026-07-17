import * as fs from "node:fs";

import * as vscode from "vscode";

import {
  applyExternalConfig,
  EXTERNAL_CONFIG_RELATIVE_PATH,
  generateExternalConfig,
  parseExternalConfig,
  serializeExternalConfig
} from "@/backend/utils/externalConfig";
import { isGitRepository } from "@/backend/utils/git";
import { getPathFromUri } from "@/backend/utils/path";
import { evalPromises } from "@/backend/utils/promise";
import { Config } from "@/config";
import { ExtensionState } from "@/extensionState";
import { StatusBarItem } from "@/statusBarItem";
import { GitRepoSet, GitRepoState } from "@/types";

export type RepoChangeCallback = (repos: GitRepoSet, numRepos: number) => void;

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

  /** Read + validate the shared config file in `repo`, or null if absent/invalid. */
  function readExternalConfig(repo: string) {
    try {
      return parseExternalConfig(
        fs.readFileSync(repo + "/" + EXTERNAL_CONFIG_RELATIVE_PATH, "utf8")
      );
    } catch {
      return null; // no file / unreadable
    }
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
    repos[repo] = state;
    extensionState.saveRepos(repos);
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
      evalPromises(repoPaths, 3, (path) => isGitRepository(path, config.gitPath())).then(
        (results) => {
          for (let i = 0; i < repoPaths.length; i++) {
            if (!results[i]) {
              removeRepo(repoPaths[i]);
              changes = true;
            }
          }
          if (changes) sendRepos();
          resolve(changes);
        }
      );
    });
  }

  return {
    registerViewCallback,
    deregisterViewCallback,
    getRepos,
    isDirectoryWithinRepos,
    sendRepos,
    addRepo,
    exportRepoConfig,
    removeRepo,
    removeReposWithinFolder,
    setRepoState,
    removeReposNotInWorkspace,
    checkReposExist
  };
}

export type RepoManager = ReturnType<typeof createRepoManager>;
