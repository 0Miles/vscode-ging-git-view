/* The desktop `HostConfig` (`@ging/core/host/ports`), over the desktop
 * settings file. The values and their defaults are the schema's
 * (settings/schema.ts), so this only turns them into what each method answers,
 * the way the VS Code host's `config` does with VS Code's. Each method reads
 * the file when it is called: the port's first group is read per request, and
 * a change has to reach the next one. */

import type { SquashMessageFormat } from "@ging/core/backend/actions/merge";
import { normalizeKeybinding } from "@ging/core/backend/utils/keybinding";
import { normalizePullRequestProviders } from "@ging/core/backend/utils/pullRequest";
import type { HostConfig } from "@ging/core/host/ports";
import type { Settings } from "@ging/desktop/settings/settingsFile";
import type { CommitOrdering, DateType, GitResetMode } from "@ging/shared/backend/types";
import { mergeContextMenuActionsVisibility } from "@ging/shared/backend/utils/contextMenuVisibility";
import type {
  DateFormat,
  FileViewType,
  GitGraphViewState,
  GraphStyle,
  RefSpaceSubstitution
} from "@ging/shared/types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function createDesktopConfig(settings: Settings): HostConfig {
  /** A setting by its name after `ging-git-view.`; the settings file has
   *  already held it to the schema's type and enum. */
  const get = <T>(name: string) => settings.get(`ging-git-view.${name}`) as T;
  const keybinding = (name: string, defaultKey: string) =>
    normalizeKeybinding(get<string>(`shortcuts.${name}`), defaultKey);

  const config: HostConfig = {
    signTags: () => get("signing.tags"),
    signCommits: () => get("signing.commits"),
    squashMergeMessageFormat: () =>
      get<SquashMessageFormat>("dialogDefaults.mergeSquashMessageFormat"),
    commitOrder: () => get<CommitOrdering>("history.commitOrder"),
    dateType: () => get<DateType>("dates.type"),
    showUncommittedChanges: () => get("show.uncommittedChanges"),
    showSignatureStatus: () => get("history.showSignatures"),
    useMailmap: () => get("history.useMailmap"),
    inactiveBranchAlwaysShow: () => get("branches.alwaysShow"),
    fetchAndPrune: () => get("fetch.prune"),
    fetchAndPruneTags: () => get("fetch.pruneTags"),
    autoFetchEnabled: () => get("autoFetch.enabled"),
    autoFetchIntervalMinutes: () => get("autoFetch.intervalMinutes"),
    pullRequestProviders: () => normalizePullRequestProviders(get("pullRequests.providers")),
    showRemoteBranches: () => get("show.remoteBranches"),
    repoSettingDefaults: () => ({
      onlyFollowFirstParent: get("history.firstParentOnly"),
      includeReflogCommits: get("history.includeReflogCommits"),
      showStashes: get("show.stashes"),
      showTagOnlyCommits: get("show.tagOnlyCommits"),
      showRemoteHeads: get("show.remoteHeads"),
      showInactiveBranches: get("branches.showInactiveByDefault"),
      showMergedBranches: get("branches.showMergedByDefault")
    }),

    autoCenterCommitDetailsView: () => get("detailsPanel.autoScroll"),
    commitDetailsViewLocation: () =>
      get<GitGraphViewState["commitDetailsViewLocation"]>("detailsPanel.position"),
    referenceLabelAlignment: () =>
      get<GitGraphViewState["referenceLabelAlignment"]>("refLabels.alignment"),
    combineLocalAndRemoteBranchLabels: () => get("refLabels.combineLocalAndRemote"),
    dialogDeleteBranchForceDelete: () => get("dialogDefaults.deleteBranchForce"),
    dialogCherryPickNoCommit: () => get("dialogDefaults.cherryPickNoCommit"),
    dialogAddTagType: () => get<GitGraphViewState["dialogAddTagType"]>("dialogDefaults.addTagType"),
    dialogCreateBranchCheckOut: () => get("dialogDefaults.createBranchCheckOut"),
    dialogMergeNoFastForward: () => get("dialogDefaults.mergeNoFastForward"),
    dialogMergeSquash: () => get("dialogDefaults.mergeSquash"),
    dialogResetMode: () => get<GitResetMode>("dialogDefaults.resetMode"),
    contextMenuActionsVisibility: () =>
      mergeContextMenuActionsVisibility(get<object>("contextMenuActions")),
    customBranchGlobPatterns: () =>
      get<unknown[]>("customBranchGlobs").filter(
        (p): p is { name: string; glob: string } =>
          isRecord(p) && typeof p.name === "string" && typeof p.glob === "string" && p.glob !== ""
      ),
    customEmojiShortcodeMappings: () => {
      const mappings: Record<string, string> = {};
      for (const m of get<unknown[]>("customEmojiShortcodes")) {
        if (isRecord(m) && typeof m.shortcode === "string" && typeof m.emoji === "string") {
          // With or without the colons around it.
          mappings[m.shortcode.replace(/^:|:$/g, "")] = m.emoji;
        }
      }
      return mappings;
    },
    dateFormat: () => get<DateFormat>("dates.format"),
    dateCustomFormat: () => get("dates.customFormat"),
    defaultColumnVisibility: () => {
      const v = get<Record<string, unknown>>("columnVisibility");
      return { date: v.date !== false, author: v.author !== false, commit: v.commit !== false };
    },
    enhancedAccessibility: () => get("accessibilityEnhancements"),
    fetchAvatars: () => get("history.fetchAvatars"),
    fileTreeCompactFolders: () => get("detailsPanel.compactFolders"),
    fileViewType: () => get<FileViewType>("detailsPanel.fileLayout"),
    // The schema's pattern for a colour has already dropped the bad entries.
    graphColours: () => get("graph.palette"),
    graphStyle: () => get<GraphStyle>("graph.edgeStyle"),
    initialLoadCommits: () => get("history.initialCommitCount"),
    issueLinkingRegex: () => get("issueLinks.pattern"),
    issueLinkingUrl: () => get("issueLinks.url"),
    keybindings: () => ({
      find: keybinding("find", "f"),
      refresh: keybinding("refresh", "r"),
      scrollToHead: keybinding("scrollToHead", "h"),
      scrollToStash: keybinding("scrollToStash", "s")
    }),
    loadMoreAutomatically: () => get("history.loadMoreOnScroll"),
    loadMoreCount: () => get("history.loadMoreCount"),
    markdown: () => get("renderMarkdown"),
    muteCommitsNotAncestorsOfHead: () => get("dim.nonAncestorCommits"),
    muteMergeCommits: () => get("dim.mergeCommits"),
    onLoadScrollToHead: () => get("onOpen.scrollToHead"),
    referenceInputSpaceSubstitution: () => get<RefSpaceSubstitution>("refNameSpaceReplacement"),
    // The port leaves this to a host without VS Code's Source Control view. A
    // desktop tab is one repository (GLOSSARY.md's Tab), and another one opens
    // in a tab of its own, so the graph offers no dropdown to switch.
    scmMultiRepoSelection: () => false,
    showCurrentBranchByDefault: () => get("onOpen.selectCheckedOutBranch"),
    uncommittedChangesAtHead: () =>
      get("graph.uncommittedMarker") === "Open Circle at the Checked Out Commit",
    showSpecificBranches: () => get("onOpen.branchSelection"),
    showTags: () => get("show.tags")
  };
  return config;
}
