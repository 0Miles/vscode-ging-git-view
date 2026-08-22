import * as vscode from "vscode";

import { SquashMessageFormat } from "./backend/actions/merge";
import { CommitOrdering, DateType } from "./backend/types";
import { mergeContextMenuActionsVisibility } from "./backend/utils/contextMenuVisibility";
import { resolveGitPath } from "./backend/utils/gitPath";
import { normalizeKeybinding } from "./backend/utils/keybinding";
import {
  normalizePullRequestProviders,
  type PullRequestProvider
} from "./backend/utils/pullRequest";
import {
  ContextMenuActionsVisibility,
  DateFormat,
  FileViewType,
  GraphStyle,
  KeybindingConfig,
  RefSpaceSubstitution
} from "./types";

type TabIconColourTheme = "colour" | "grey";
type AddTagType = "annotated" | "lightweight";
export type CommitDetailsViewLocation = "Inline" | "Docked to Bottom";
export type ReferenceLabelAlignment =
  | "Normal"
  | "Branches (on the left) & Tags (on the right)"
  | "Branches (aligned to the graph) & Tags (on the right)";
// Names match the vscode.ViewColumn enum keys, so they index it directly.
export type EditorGroup =
  | "Active"
  | "Beside"
  | "One"
  | "Two"
  | "Three"
  | "Four"
  | "Five"
  | "Six"
  | "Seven"
  | "Eight"
  | "Nine";

function getConfig<T>(key: string, defaultValue: T): T {
  return vscode.workspace.getConfiguration("ging-git-view").get(key, defaultValue);
}

/** VSCode's own setting for whether the Source Control Repositories view lets
 *  several repos be selected at once ("選取多個存放庫" in its `...` menu). Which
 *  repos are actually ticked is kept in workbench storage and is not readable by
 *  extensions — only this mode is. */
export const SCM_SELECTION_MODE_SETTING = "scm.repositories.selectionMode";

/** Read and normalise a `keyboardShortcut.*` setting (see normalizeKeybinding). */
function getKeybinding(section: string, defaultKey: string): string | null {
  return normalizeKeybinding(getConfig<string>(section, ""), defaultKey);
}

export const config = {
  autoCenterCommitDetailsView: (): boolean => getConfig("detailsPanel.autoScroll", true),
  commitDetailsViewLocation: (): CommitDetailsViewLocation =>
    getConfig<string>("detailsPanel.position", "Inline") === "Docked to Bottom"
      ? "Docked to Bottom"
      : "Inline",
  referenceLabelAlignment: (): ReferenceLabelAlignment => {
    const v = getConfig<string>("refLabels.alignment", "Normal");
    return v === "Branches (on the left) & Tags (on the right)" ||
      v === "Branches (aligned to the graph) & Tags (on the right)"
      ? v
      : "Normal";
  },
  combineLocalAndRemoteBranchLabels: (): boolean =>
    getConfig("refLabels.combineLocalAndRemote", true),
  dialogDeleteBranchForceDelete: (): boolean =>
    getConfig("dialogDefaults.deleteBranchForce", false),
  dialogCherryPickNoCommit: (): boolean => getConfig("dialogDefaults.cherryPickNoCommit", false),
  dialogAddTagType: (): AddTagType => getConfig("dialogDefaults.addTagType", "annotated"),
  dialogCreateBranchCheckOut: (): boolean =>
    getConfig("dialogDefaults.createBranchCheckOut", false),
  dialogMergeNoFastForward: (): boolean => getConfig("dialogDefaults.mergeNoFastForward", true),
  dialogMergeSquash: (): boolean => getConfig("dialogDefaults.mergeSquash", false),
  squashMergeMessageFormat: (): SquashMessageFormat =>
    getConfig<string>("dialogDefaults.mergeSquashMessageFormat", "Default") === "Git SQUASH_MSG"
      ? "Git SQUASH_MSG"
      : "Default",
  dialogResetMode: (): "soft" | "mixed" | "hard" => getConfig("dialogDefaults.resetMode", "mixed"),
  commitOrder: (): CommitOrdering => getConfig("history.commitOrder", "date"),
  contextMenuActionsVisibility: (): ContextMenuActionsVisibility =>
    mergeContextMenuActionsVisibility(getConfig("contextMenuActions", {})),
  customBranchGlobPatterns: (): { name: string; glob: string }[] => {
    const patterns = getConfig<{ name: string; glob: string }[]>("customBranchGlobs", []);
    return patterns.filter(
      (p) => p && typeof p.name === "string" && typeof p.glob === "string" && p.glob !== ""
    );
  },
  customEmojiShortcodeMappings: (): { [code: string]: string } => {
    const mappings = getConfig<{ shortcode: string; emoji: string }[]>("customEmojiShortcodes", []);
    const result: { [code: string]: string } = {};
    for (const m of mappings) {
      if (m && typeof m.shortcode === "string" && typeof m.emoji === "string") {
        // Accept shortcodes with or without surrounding colons.
        result[m.shortcode.replace(/^:|:$/g, "")] = m.emoji;
      }
    }
    return result;
  },
  dateFormat: (): DateFormat => getConfig("dates.format", "Date & Time"),
  dateCustomFormat: (): string => getConfig("dates.customFormat", "DD MMM YYYY"),
  defaultColumnVisibility: (): { date: boolean; author: boolean; commit: boolean } => {
    const v = getConfig<{ date?: boolean; author?: boolean; commit?: boolean }>(
      "columnVisibility",
      {}
    );
    return {
      date: v.date !== false,
      author: v.author !== false,
      commit: v.commit !== false
    };
  },
  dateType: (): DateType => getConfig("dates.type", "Author Date"),
  enhancedAccessibility: (): boolean => getConfig("accessibilityEnhancements", false),
  autoFetchEnabled: (): boolean => getConfig("autoFetch.enabled", false),
  // Clamped to the supported 1–60 minute range at the call site.
  autoFetchIntervalMinutes: (): number => getConfig("autoFetch.intervalMinutes", 10),
  // On by default: hosts routinely delete the source branch when a PR merges, and
  // without `--prune` its remote-tracking ref survives every later fetch and goes
  // on being drawn on the graph (#34). Tags are deliberately not pruned with it —
  // see `fetch.pruneTags` and ADR-0012.
  fetchAndPrune: (): boolean => getConfig("fetch.prune", true),
  fetchAndPruneTags: (): boolean => getConfig("fetch.pruneTags", false),
  fetchAvatars: (): boolean => getConfig("history.fetchAvatars", false),
  // Optional GitLab personal access token (read_user scope) used to look up
  // committer avatars on GitLab. Empty by default; when unset, GitLab-hosted
  // repos fall back to Gravatar (the GitLab user search API requires auth).
  gitLabToken: (): string => getConfig("history.gitLabToken", ""),
  fileTreeCompactFolders: (): boolean => getConfig("detailsPanel.compactFolders", true),
  fileViewType: (): FileViewType => getConfig("detailsPanel.fileLayout", "File Tree"),
  graphColours: (): string[] =>
    getConfig("graph.palette", [
      "#0085d9",
      "#d9008f",
      "#00d90a",
      "#d98500",
      "#a300d9",
      "#ff0000"
    ]).filter(
      (v: string) =>
        v.match(
          /^\s*(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|rgb[a]?\s*\(\d{1,3},\s*\d{1,3},\s*\d{1,3}\))\s*$/
        ) !== null
    ),
  graphStyle: (): GraphStyle => getConfig("graph.edgeStyle", "rounded"),
  includeCommitsMentionedByReflogs: (): boolean => getConfig("history.includeReflogCommits", false),
  initialLoadCommits: (): number => getConfig("history.initialCommitCount", 300),
  issueLinkingRegex: (): string => getConfig("issueLinks.pattern", ""),
  issueLinkingUrl: (): string => getConfig("issueLinks.url", ""),
  keybindings: (): KeybindingConfig => ({
    find: getKeybinding("shortcuts.find", "f"),
    refresh: getKeybinding("shortcuts.refresh", "r"),
    scrollToHead: getKeybinding("shortcuts.scrollToHead", "h"),
    scrollToStash: getKeybinding("shortcuts.scrollToStash", "s")
  }),
  loadMoreAutomatically: (): boolean => getConfig("history.loadMoreOnScroll", false),
  loadMoreCommits: (): number => getConfig("history.loadMoreCount", 75),
  maxDepthOfRepoSearch: (): number => getConfig("repoSearchDepth", 0),
  markdown: (): boolean => getConfig("renderMarkdown", true),
  muteCommitsNotAncestorsOfHead: (): boolean => getConfig("dim.nonAncestorCommits", false),
  muteMergeCommits: (): boolean => getConfig("dim.mergeCommits", true),
  onLoadScrollToHead: (): boolean => getConfig("onOpen.scrollToHead", false),
  openToTheRepoOfActiveEditor: (): boolean => getConfig("followActiveEditorRepo", false),
  followSourceControlSelection: (): boolean => getConfig("followSourceControlSelection", true),
  /** True while the Source Control Repositories view is in multi-select mode —
   *  the state under which the graph offers its repo dropdown (#16). */
  scmMultiRepoSelection: (): boolean =>
    vscode.workspace
      .getConfiguration("scm")
      .get<string>("repositories.selectionMode", "multiple") !== "single",
  onlyFollowFirstParent: (): boolean => getConfig("history.firstParentOnly", false),
  openNewTabEditorGroup: (): EditorGroup => getConfig("diffEditorGroup", "Active"),
  // Which host serves pull requests for which forge. Malformed entries are
  // dropped rather than turned into a broken URL; the built-in public hosts
  // apply on top of whatever is listed here (see backend/utils/pullRequest.ts).
  pullRequestProviders: (): PullRequestProvider[] =>
    normalizePullRequestProviders(getConfig<unknown>("pullRequests.providers", [])),
  referenceInputSpaceSubstitution: (): RefSpaceSubstitution =>
    getConfig("refNameSpaceReplacement", "None"),
  retainContextWhenHidden: (): boolean => getConfig("keepWebviewAlive", true),
  showCommitsOnlyReferencedByTags: (): boolean => getConfig("show.tagOnlyCommits", true),
  signCommits: (): boolean => getConfig("signing.commits", false),
  signTags: (): boolean => getConfig("signing.tags", false),
  showRemoteBranches: (): boolean => getConfig("show.remoteBranches", true),
  // Branches side-view: how many days of inactivity before a branch is hidden
  // (0 disables the feature), the always-show name/glob exemptions, and the
  // global defaults for the two per-repo hide toggles. `alwaysShow` exempts a
  // branch from both rules — it is the "I always want to see this" list, not an
  // inactivity-specific one.
  inactiveBranchThresholdDays: (): number => getConfig("branches.inactiveAfterDays", 30),
  inactiveBranchAlwaysShow: (): string[] =>
    getConfig("branches.alwaysShow", ["main", "master", "develop", "dev", "trunk"]),
  showInactiveBranchesByDefault: (): boolean => getConfig("branches.showInactiveByDefault", false),
  showMergedBranchesByDefault: (): boolean => getConfig("branches.showMergedByDefault", false),
  showRemoteHeads: (): boolean => getConfig("show.remoteHeads", true),
  showSignatureStatus: (): boolean => getConfig("history.showSignatures", false),
  showStashes: (): boolean => getConfig("show.stashes", true),
  showCurrentBranchByDefault: (): boolean => getConfig("onOpen.selectCheckedOutBranch", false),
  // Where the open (hollow) circle for uncommitted changes is drawn —
  // at the uncommitted-changes node (default) or at the checked-out commit.
  uncommittedChangesAtHead: (): boolean =>
    getConfig<string>("graph.uncommittedMarker", "Open Circle at the Uncommitted Changes") ===
    "Open Circle at the Checked Out Commit",
  showSpecificBranches: (): string[] => {
    const v = getConfig<unknown>("onOpen.branchSelection", []);
    return Array.isArray(v) ? v.filter((b): b is string => typeof b === "string") : [];
  },
  showTags: (): boolean => getConfig("show.tags", true),
  showStatusBarItem: (): boolean => getConfig("statusBarButton", true),
  showUncommittedChanges: (): boolean => getConfig("show.uncommittedChanges", true),
  showUntrackedFiles: (): boolean => getConfig("show.untrackedFiles", true),
  useMailmap: (): boolean => getConfig("history.useMailmap", false),
  // Resolvable at a Workspace Folder scope: pass the repo's Uri so a
  // per-folder `fileEncoding` override is honoured, else the global value.
  fileEncoding: (scope?: vscode.Uri): string =>
    vscode.workspace.getConfiguration("ging-git-view", scope).get("defaultFileEncoding", "utf8"),
  tabIconColourTheme: (): TabIconColourTheme => getConfig("tabIconTheme", "colour"),
  gitPath: (): string =>
    resolveGitPath(
      vscode.workspace.getConfiguration("git").get<string | string[] | null>("path", null)
    )
};

export type Config = typeof config;
