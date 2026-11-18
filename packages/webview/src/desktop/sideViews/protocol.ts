/* What the desktop host and a Tab's page say to each other about the page's
 * Branches, Remotes and Stash side views (#399, #400). Desktop-only, so declared under
 * desktop/ and never part of `RequestMessage` / `ResponseMessage` (ADR-0031):
 * they share the page's `message` event and the host's channel with the
 * graph's, and the compiler keeps their command names apart. */

import type { GitFileChangeType } from "@ging/shared/backend/types";
import type { BranchTreeNode } from "@ging/shared/backend/utils/branchTree";
import { isStashAction, type StashAction } from "@ging/shared/backend/utils/stashActionCatalogue";
import type {
  BatchSkipped,
  ContextMenuActionsVisibility,
  RequestMessage,
  ResponseMessage
} from "@ging/shared/types";
import {
  isRecord,
  isStringArray,
  type NoCommandShared
} from "@ging/webview/desktop/protocolGuards";

/** One of the Branches view's toggles, named by the repo-state field it
 *  writes — core's `SideViewField`, which the host holds this to. */
export type SideViewToggleField =
  | "showRemoteBranches"
  | "showInactiveBranches"
  | "showMergedBranches";

/** How a branch row reads, worded by the host: what follows its name
 *  ("current · 3mo") and its tooltip. */
export type SideViewRowText = { description: string; tooltip: string };

/** The Branches view, as the host read it. */
export type SideViewBranches = {
  /** The tree, as core builds it for both hosts' side views. */
  roots: BranchTreeNode[];
  /** Each leaf's words, by its canonical ref. */
  rows: Record<string, SideViewRowText>;
  /** The branch filter in force. On the desktop host the tree's selection is
   *  always this — nothing stops the page from drawing any set it is given,
   *  so there is no TreeView selection to fall out of step with it. */
  filter: string[];
  toggles: Record<SideViewToggleField, boolean>;
};

/** The column's width, in CSS pixels, until the user drags it (#459). */
export const SIDE_VIEW_WIDTH = 260;
/** How narrow and how wide a drag may make the column. */
export const SIDE_VIEW_MIN_WIDTH = 160;
export const SIDE_VIEW_MAX_WIDTH = 600;

/** `width` as the column may be: whole pixels, within its bounds. */
export const clampSideViewWidth = (width: number): number =>
  Math.min(SIDE_VIEW_MAX_WIDTH, Math.max(SIDE_VIEW_MIN_WIDTH, Math.round(width)));

/** How the column sits in every Tab of the app (#459): its width, and whether
 *  it is shown at all. The app's, not a Tab's or a repository's. */
export type SideViewLayout = { width: number; shown: boolean };

export const DEFAULT_SIDE_VIEW_LAYOUT: SideViewLayout = { width: SIDE_VIEW_WIDTH, shown: true };

/** One configured remote, as the Remotes view lists it. */
export type SideViewRemote = { name: string; fetchUrl: string; pushUrl: string };

/** One stash, as the Stash view lists it (core's `StashListItem`), worded by
 *  the host as VS Code's TreeItem is. */
export type SideViewStash = {
  /** Its SHA, told apart from a repeat of it (`stashListItems`): what the
   *  page names it by. */
  id: string;
  /** Where it sits now, e.g. `stash@{0}`. */
  selector: string;
  message: string;
  /** Its selector, message and date, a line each. */
  tooltip: string;
};

/** One file of an expanded stash (core's `StashFile`). */
export type SideViewStashFile = {
  /** Its path in the stash: what the page names it by. */
  path: string;
  /** Its name, without its folder. */
  name: string;
  /** Its folder; empty at the top. */
  dir: string;
  /** git's letter, or `U` for a file untracked when stashed. */
  badge: GitFileChangeType | "U";
  /** Its path, or where it was renamed from and to. */
  tooltip: string;
};

/** The side views' own words. The branch actions' labels are the graph's
 *  (the page's `l10n`): the same actions, under the same names. */
export type SideViewStrings = {
  branches: string;
  remotes: string;
  groupRemote: string;
  groupLocal: string;
  noBranches: string;
  noRemotes: string;
  more: string;
  showAll: string;
  refresh: string;
  showRemoteBranches: string;
  showInactive: string;
  showMerged: string;
  collapseAll: string;
  cleanup: string;
  deleteSelected: string;
  pushSelected: string;
  fastForwardSelected: string;
  copyNameSelected: string;
  addRemote: string;
  managePullRequestProviders: string;
  fetchRemote: string;
  editUrl: string;
  renameRemote: string;
  removeRemote: string;
  copyUrl: string;
  stashes: string;
  noStashes: string;
  /** The Branches view's Search Branch (#459). */
  search: string;
  /** The Branches view's More Actions' View Reflog (#459). */
  viewReflog: string;
  /** The column's drag handle (#459). */
  resize: string;
};

/** Host → page: every view, whole each time. `null` for a view whose read has
 *  not landed yet, or failed. */
export type SideViewStateMessage = {
  command: "sideViewState";
  repo: string;
  branches: SideViewBranches | null;
  remotes: SideViewRemote[] | null;
  /** Newest first, as git lists them. */
  stashes: SideViewStash[] | null;
  /** The `seq` of the last `sideViewSetFilter` the host had taken when it
   *  sent this; 0 before any since the page loaded. The page keeps its own
   *  highlight against a state from before its latest ask. */
  filterSeq: number;
  /** Which branch and stash actions the settings hide, as the graph's menu
   *  reads them. */
  cmv: Pick<ContextMenuActionsVisibility, "branch" | "remoteBranch" | "stash">;
  strings: SideViewStrings;
};

/** Host → page: the files of a stash the page expanded, `null` when they could
 *  not be read. A stash never changes under its SHA, so the page keeps them. */
export type SideViewStashFilesMessage = {
  command: "sideViewStashFiles";
  repo: string;
  id: string;
  files: SideViewStashFile[] | null;
};

/** Host → page: lay the column out so (#459) — on the page's word that it
 *  listens, and whenever the app's layout changes, from any Tab or the View
 *  menu. */
export type SideViewLayoutMessage = { command: "sideViewLayout"; layout: SideViewLayout };

/** Everything the host posts to the side views. */
export type SideViewMessage =
  | SideViewStateMessage
  | SideViewStashFilesMessage
  | SideViewLayoutMessage;

/** What the Remotes view does to one remote it lists. */
export type SideViewRemoteAction = "fetch" | "editUrl" | "rename" | "remove" | "copyUrl";

/** Page → host. */
export type SideViewRequest =
  /** The page listens: until it says so after each load, the host holds the
   *  state back rather than send it into nothing. */
  | { command: "sideViewReady" }
  /** Read both views again, past the coalescing window: the user asked. */
  | { command: "sideViewRefresh" }
  | { command: "sideViewToggle"; field: SideViewToggleField }
  /** Make `branches` the repo's branch filter: the tree's selection, or
   *  Show All's empty one. `seq` counts the page's asks, from 1 at each load. */
  | { command: "sideViewSetFilter"; repo: string; branches: string[]; seq: number }
  /** A batch action whose every selected branch was ruled out, for the host
   *  to say so. */
  | { command: "sideViewNoTargets"; skipped: BatchSkipped[] }
  | { command: "sideViewAddRemote" }
  | { command: "sideViewManagePullRequestProviders" }
  | { command: "sideViewRemote"; action: SideViewRemoteAction; name: string }
  /** Run `action` on the stash listed as `id`: in the host, through core
   *  (ADR-0029), on the stash as the host listed it. */
  | { command: "sideViewStash"; action: StashAction; id: string }
  /** Read the files of the stash listed as `id`. */
  | { command: "sideViewStashFiles"; id: string }
  /** Open the diff of the file at `path` in the stash listed as `id`. */
  | { command: "sideViewStashDiff"; id: string; path: string }
  /** VS Code's Search Branch (#459): asked in the host prompt overlay, over
   *  the tree the host last read; what is checked becomes the filter. */
  | { command: "sideViewSearch" }
  /** The instance's View Reflog, as the application menu runs it (#459). */
  | { command: "sideViewViewReflog" }
  /** The user left the column `width` wide (#459): the app's, from now on. */
  | { command: "sideViewResize"; width: number };

/** Checked by the compiler (ADR-0031). */
export const SIDE_VIEW_COMMANDS_STAY_APART: NoCommandShared<
  SideViewMessage["command"],
  ResponseMessage["command"]
> &
  NoCommandShared<SideViewRequest["command"], RequestMessage["command"]> = true;

/** Whether `data`, heard on the page's `message` channel, is the side views'. */
export function isSideViewStateMessage(data: unknown): data is SideViewStateMessage {
  return (
    isRecord(data) &&
    data.command === "sideViewState" &&
    typeof data.repo === "string" &&
    typeof data.filterSeq === "number" &&
    isRecord(data.cmv) &&
    isRecord(data.strings)
  );
}

/** Whether `value` is a layout, as the host states one. */
export function isSideViewLayout(value: unknown): value is SideViewLayout {
  return (
    isRecord(value) &&
    typeof value.width === "number" &&
    Number.isFinite(value.width) &&
    typeof value.shown === "boolean"
  );
}

/** Whether `data`, heard on the page's `message` channel, is the column's
 *  layout. */
export function isSideViewLayoutMessage(data: unknown): data is SideViewLayoutMessage {
  return isRecord(data) && data.command === "sideViewLayout" && isSideViewLayout(data.layout);
}

/** Whether `data`, heard on the page's `message` channel, is a stash's files. */
export function isSideViewStashFilesMessage(data: unknown): data is SideViewStashFilesMessage {
  return (
    isRecord(data) &&
    data.command === "sideViewStashFiles" &&
    typeof data.repo === "string" &&
    typeof data.id === "string" &&
    (data.files === null || Array.isArray(data.files))
  );
}

const TOGGLE_FIELDS: readonly string[] = [
  "showRemoteBranches",
  "showInactiveBranches",
  "showMergedBranches"
] satisfies SideViewToggleField[];
const REMOTE_ACTIONS: readonly string[] = [
  "fetch",
  "editUrl",
  "rename",
  "remove",
  "copyUrl"
] satisfies SideViewRemoteAction[];

/** Whether `data`, posted by a Tab's page, is one of its side views' requests.
 *  A page is not to be taken at its word, so every field is checked. */
export function isSideViewRequest(data: unknown): data is SideViewRequest {
  if (!isRecord(data)) return false;
  switch (data.command) {
    case "sideViewReady":
    case "sideViewRefresh":
    case "sideViewAddRemote":
    case "sideViewManagePullRequestProviders":
    case "sideViewSearch":
    case "sideViewViewReflog":
      return true;
    case "sideViewResize":
      return typeof data.width === "number" && Number.isFinite(data.width);
    case "sideViewToggle":
      return typeof data.field === "string" && TOGGLE_FIELDS.includes(data.field);
    case "sideViewSetFilter":
      return (
        typeof data.repo === "string" &&
        isStringArray(data.branches) &&
        typeof data.seq === "number"
      );
    case "sideViewNoTargets":
      return (
        Array.isArray(data.skipped) &&
        data.skipped.every(
          (s) =>
            isRecord(s) &&
            typeof s.ref === "string" &&
            (s.reason === "checkedOut" || s.reason === "remote")
        )
      );
    case "sideViewRemote":
      return (
        typeof data.name === "string" &&
        typeof data.action === "string" &&
        REMOTE_ACTIONS.includes(data.action)
      );
    case "sideViewStash":
      return typeof data.id === "string" && isStashAction(data.action);
    case "sideViewStashFiles":
      return typeof data.id === "string";
    case "sideViewStashDiff":
      return typeof data.id === "string" && typeof data.path === "string";
    default:
      return false;
  }
}
