/**
 * The host ports: what the message dispatch (and the core services built
 * beside it) asks of whatever editor or app is hosting GING.
 *
 * Each port is one host capability, and carries only the methods the dispatch
 * calls. They are plain structural interfaces, in the shape of
 * `AvatarConfig`/`AvatarStore`, so a host can often hand over an object it
 * already has.
 *
 * Types are host-neutral: paths are strings, not URIs, and a cancelled prompt
 * answers `undefined`.
 */

import type { SquashMessageFormat } from "@ging/core/backend/actions/merge";
import type { PullRequestProvider } from "@ging/core/backend/utils/pullRequest";
import type { CommitDiffRequest, DiffSide } from "@ging/core/extension/commitDiff";
import type { CommitOrdering, DateType } from "@ging/shared/backend/types";
import type { GitRepoSet, GitRepoState, RepoScopeSettings } from "@ging/shared/types";

/** The settings the dispatch and the core services beside it read, each read
 *  at the moment it is needed — a setting changed between two requests reaches
 *  the second. */
export interface HostConfig {
  signTags(): boolean;
  signCommits(): boolean;
  squashMergeMessageFormat(): SquashMessageFormat;
  commitOrder(): CommitOrdering;
  dateType(): DateType;
  showUncommittedChanges(): boolean;
  showSignatureStatus(): boolean;
  useMailmap(): boolean;
  /** Branch-name patterns exempt from being a cleanup candidate. */
  inactiveBranchAlwaysShow(): string[];
  fetchAndPrune(): boolean;
  fetchAndPruneTags(): boolean;
  /** Whether the current repository is fetched on a timer. Unlike the rest,
   *  read only when the timer is armed: the host calls
   *  `FetchService.restartAutoFetch` when either auto-fetch setting changes. */
  autoFetchEnabled(): boolean;
  /** How often, in minutes; clamped to 1–60 by the timer. */
  autoFetchIntervalMinutes(): number;
  pullRequestProviders(): PullRequestProvider[];
  /** "Show remote branches" for a repo that has not overridden it. */
  showRemoteBranches(): boolean;
  /** The load scope of a repo that has not overridden it. */
  repoSettingDefaults(): RepoScopeSettings;
}

/** One tier of persisted key-value state. Writes are not awaited by anyone: a
 *  read after a write sees the write. */
export interface StateStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** Where GING keeps what outlives a session, in its two tiers: what belongs to
 *  this workspace (its repos, its current repository) and what follows the
 *  user everywhere (dialog memory, avatars), plus the folder the global tier
 *  keeps its files in. Consumed by `ExtensionState`, which is what the
 *  dispatch talks to. */
export interface HostStorage {
  workspace: StateStore;
  global: StateStore;
  globalStoragePath: string;
}

/** Asking the user something, or telling them. Every answer is `undefined`
 *  when they dismissed the prompt. */
export interface Prompts {
  /** A notification that needs no answer. */
  showInformation(message: string): void;
  /** A notification that needs no answer, worded as a warning. */
  showWarning(message: string): void;
  /** An error notification offering `actions`; resolves to the one chosen. */
  showError(message: string, ...actions: string[]): PromiseLike<string | undefined>;
  /** A modal question offering `actions` — the host adds its own way to say
   *  no, so `actions` lists only the ways to say yes; resolves to the one
   *  chosen. Only buttons: no checkbox, since the VS Code host has none. */
  confirm(message: string, ...actions: string[]): PromiseLike<string | undefined>;
  // STAND-IN for #352's `Prompts.choose`, same signature; drop it in favour of
  // #352's when that lands on main.
  /** A modal choice among `actions`, offered in the order given, with an
   *  optional `detail` line under the message. The host adds its own way to
   *  say no; resolves to the chosen action's `value`, or undefined for Cancel
   *  or Esc. */
  choose<T>(
    message: string,
    options: { detail?: string; actions: readonly { label: string; value: T }[] }
  ): PromiseLike<T | undefined>;
  /** Where to write a file; resolves to the chosen path. */
  pickSaveLocation(options: {
    saveLabel: string;
    /** File-type filters by display name, each a list of extensions. */
    filters: Record<string, string[]>;
    defaultPath: string;
  }): PromiseLike<string | undefined>;
  /** A line of text. The prompt stays up until it is answered or dismissed,
   *  not lost to a focus change: git may be blocked on it waiting for a
   *  credential, and a stash's new name may be copied from elsewhere. */
  input(options: {
    prompt: string;
    placeholder: string;
    /** Mask what is typed. */
    password: boolean;
    /** Text the answer starts from, e.g. the name being changed. */
    value?: string;
  }): PromiseLike<string | undefined>;
}

/** Opening things in the host: editors, diffs, a terminal, a browser. */
export interface Opener {
  /** Open a working-tree file. Rejects when it could not be opened. */
  openFile(path: string): PromiseLike<unknown>;
  /** Open a file's contents as of a commit, read-only. Rejects when it could
   *  not be opened. */
  openFileAtRevision(file: DiffSide): PromiseLike<unknown>;
  /** A diff of a file at a commit (left) against a working-tree file (right).
   *  Rejects when it could not be opened. */
  diffWithWorking(left: DiffSide, workingPath: string, title: string): PromiseLike<unknown>;
  /** A commit's change to a file in a diff editor (see `commitDiffView`);
   *  resolves to whether it opened. */
  openCommitDiff(request: CommitDiffRequest): PromiseLike<boolean>;
  /** A conflicted file in a 3-way merge editor, or a plain editor where there
   *  is none. */
  openMergeEditor(repo: string, filePath: string): void;
  /** A terminal in `cwd`, titled `name`, brought into view. */
  openTerminal(cwd: string, name: string): void;
  openExternalUrl(url: string): void;
}

export interface Clipboard {
  /** Rejects when the clipboard could not be written. */
  writeText(text: string): PromiseLike<void>;
}

/** The current repository's file watcher, which turns changes made outside
 *  GING into a graph refresh. */
export interface Watcher {
  /** Watch `repo` instead of whatever was watched before. */
  start(repo: string): void;
  /** Ignore changes until `unmute` — GING's own git commands are about to make
   *  some, and their effect is reported by other means (ADR-0013). */
  mute(): void;
  unmute(): void;
}

/** A positional argument to a localized string. */
export type L10nArg = string | number | boolean;

/** Localized strings, by the keys of the l10n bundles. The same shape as the
 *  webview's `Translate`, with the bundles' positional arguments. */
export interface L10n {
  t(key: string, ...args: L10nArg[]): string;
}

/** The set of known repositories (`CONTEXT.md`), with each one's state. */
export interface RepoSource {
  getRepos(): GitRepoSet;
  /** Which repo the graph boots on; see `pickBootRepo`. */
  getBootRepo(): string | null;
  /** Drop the repos that are gone, broadcasting the set when any were;
   *  resolves to whether any were. */
  checkReposExist(): PromiseLike<boolean>;
  /** Remove `repo` and broadcast the set without it to everything showing it. */
  dropRepo(repo: string): void;
  setRepoState(repo: string, state: GitRepoState): void;
}

/** The GING log — the Output Channel, in VS Code. */
export interface HostLogger {
  log(message: string): void;
  logError(message: string): void;
  /** Bring the log into view. */
  reveal(): void;
}

/** Every port the message dispatch is handed. */
export interface HostPorts {
  config: HostConfig;
  prompts: Prompts;
  opener: Opener;
  clipboard: Clipboard;
  watcher: Watcher;
  l10n: L10n;
  repoSource: RepoSource;
  logger: HostLogger;
}
