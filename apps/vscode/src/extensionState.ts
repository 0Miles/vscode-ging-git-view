import * as fs from "node:fs";

import { ExtensionContext, Memento } from "vscode";

import { getPathFromStr } from "./backend/utils/path";
import { isUsableRepoPath, resolveCurrentRepo } from "./backend/utils/repoPath";
import { Avatar, AvatarCache, DialogMemoryStore, GitRepoSet } from "./types";

const AVATAR_STORAGE_FOLDER = "/avatars";
const AVATAR_CACHE = "avatarCache";
const LAST_ACTIVE_REPO = "lastActiveRepo";
const REPO_STATES = "repoStates";
const DIALOG_MEMORY = "dialogMemory";
const PRUNE_TAGS_MIGRATION = "pruneTagsMigrationDone";

export class ExtensionState {
  private globalState: Memento;
  private workspaceState: Memento;
  private globalStoragePath: string;
  private avatarStorageAvailable: boolean = false;
  private currentRepo: string | null = null;

  constructor(context: ExtensionContext) {
    this.globalState = context.globalState;
    this.workspaceState = context.workspaceState;
    this.resolveCurrentRepo();

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

  /* Current repository — see `resolveCurrentRepo` for why the stored string is
     not the answer, and why a stale one is kept rather than deleted. */

  /** The stored path as written, resolved or not. Only for reporting which
   *  path was dropped: nothing may select a repo from this. */
  public getPersistedRepoPath() {
    return this.workspaceState.get<string | null>(LAST_ACTIVE_REPO, null);
  }
  public getLastActiveRepo() {
    return this.currentRepo;
  }
  /** Resolved once per activation, not per read: `getLastActiveRepo` has nine
   *  callers, and a path on an unreachable network share costs seconds per
   *  stat. Resolution is synchronous because the webview's HTML is built
   *  synchronously — `avatarStorageAvailable` above resolves asynchronously and
   *  an early build reads it before it lands, a race not worth inheriting. */
  private resolveCurrentRepo() {
    this.currentRepo = resolveCurrentRepo(this.getPersistedRepoPath());
  }
  /** Storage does not keep paths it has no reason to believe in: a rejected one
   *  is written down as "none selected" rather than stored. Say it that way
   *  round — this substitutes, it does not decline, and the difference shows up
   *  in what a rejected write does to a *good* stored value: it replaces it.
   *  Validating only on read would mean conceding that the persisted layer may
   *  hold rubbish and every reader must defend itself — two of the three
   *  writers can supply it (a graph opened by explicit path persists the path
   *  verbatim when it resolves to no known repo; the webview supplies whatever
   *  it has selected).
   *
   *  This is not the promise `resolveCurrentRepo` makes. That one is about
   *  *resolution* — a stored path that will not resolve today is kept, because
   *  no probe separates "deleted" from "not mounted right now" — and it is
   *  honoured above, where a failed resolve touches the field and never
   *  storage. Nothing here weakens it in practice: the predicate accepts every
   *  path the UI can offer, so the substitution is reachable only for a value
   *  no caller has any reason to send.
   *
   *  The predicate is membership *or* existence, not membership alone: a
   *  known repository is one this session already saw, so it needs no stat,
   *  while `CONTEXT.md` promises that "an explicitly named path can bypass the
   *  set and open directly" — which membership alone would break. */
  public setLastActiveRepo(repo: string | null) {
    const accepted =
      repo === null || this.isKnownRepo(repo) || isUsableRepoPath(repo) ? repo : null;
    this.currentRepo = accepted;
    this.workspaceState.update(LAST_ACTIVE_REPO, accepted);
  }
  private isKnownRepo(repo: string) {
    return Object.prototype.hasOwnProperty.call(this.getRepos(), repo);
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

  /* Whether the one-off fetch.pruneTags rescue has already run (ADR-0012).
     Global: it edits user settings, which are not per-workspace. */
  public isPruneTagsMigrationDone() {
    return this.globalState.get<boolean>(PRUNE_TAGS_MIGRATION, false);
  }
  public setPruneTagsMigrationDone() {
    this.globalState.update(PRUNE_TAGS_MIGRATION, true);
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
