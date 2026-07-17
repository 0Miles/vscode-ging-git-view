import * as fs from "node:fs";

import { ExtensionContext, Memento } from "vscode";

import { getPathFromStr } from "./backend/utils/path";
import { Avatar, AvatarCache, DialogMemoryStore, GitRepoSet } from "./types";

const AVATAR_STORAGE_FOLDER = "/avatars";
const AVATAR_CACHE = "avatarCache";
const LAST_ACTIVE_REPO = "lastActiveRepo";
const REPO_STATES = "repoStates";
const DIALOG_MEMORY = "dialogMemory";

export class ExtensionState {
  private globalState: Memento;
  private workspaceState: Memento;
  private globalStoragePath: string;
  private avatarStorageAvailable: boolean = false;

  constructor(context: ExtensionContext) {
    this.globalState = context.globalState;
    this.workspaceState = context.workspaceState;

    this.globalStoragePath = getPathFromStr(context.globalStoragePath);
    fs.stat(this.globalStoragePath + AVATAR_STORAGE_FOLDER, (err) => {
      if (!err) {
        this.avatarStorageAvailable = true;
      } else {
        fs.mkdir(this.globalStoragePath, () => {
          fs.mkdir(this.globalStoragePath + AVATAR_STORAGE_FOLDER, (mkdirErr) => {
            if (!mkdirErr) this.avatarStorageAvailable = true;
          });
        });
      }
    });
  }

  /* Discovered Repos */
  public getRepos() {
    return this.workspaceState.get<GitRepoSet>(REPO_STATES, {});
  }
  public saveRepos(gitRepoSet: GitRepoSet) {
    this.workspaceState.update(REPO_STATES, gitRepoSet);
  }

  /* Last Active Repo */
  public getLastActiveRepo() {
    return this.workspaceState.get<string | null>(LAST_ACTIVE_REPO, null);
  }
  public setLastActiveRepo(repo: string | null) {
    this.workspaceState.update(LAST_ACTIVE_REPO, repo);
  }

  /* Dialog "Remember my choice" values (global, shared across repos) */
  public getDialogMemory() {
    return this.globalState.get<DialogMemoryStore>(DIALOG_MEMORY, {});
  }
  public saveDialogMemory(dialogKey: string, values: { [inputName: string]: string } | null) {
    const store = this.getDialogMemory();
    if (values === null) {
      delete store[dialogKey];
    } else {
      store[dialogKey] = values;
    }
    this.globalState.update(DIALOG_MEMORY, store);
  }

  /* Avatars */
  public isAvatarStorageAvailable() {
    return this.avatarStorageAvailable;
  }
  public getAvatarStoragePath() {
    return this.globalStoragePath + AVATAR_STORAGE_FOLDER;
  }
  public getAvatarCache() {
    return this.globalState.get<AvatarCache>(AVATAR_CACHE, {});
  }
  public saveAvatar(email: string, avatar: Avatar) {
    let avatars = this.getAvatarCache();
    avatars[email] = avatar;
    this.globalState.update(AVATAR_CACHE, avatars);
  }
  public removeAvatarFromCache(email: string) {
    let avatars = this.getAvatarCache();
    delete avatars[email];
    this.globalState.update(AVATAR_CACHE, avatars);
  }
  public clearAvatarCache() {
    this.globalState.update(AVATAR_CACHE, {});
    fs.readdir(this.globalStoragePath + AVATAR_STORAGE_FOLDER, (err, files) => {
      if (err) return;
      for (let i = 0; i < files.length; i++) {
        fs.unlink(this.globalStoragePath + AVATAR_STORAGE_FOLDER + "/" + files[i], () => {});
      }
    });
  }
}
