import type { ExtensionState } from "@ging/core/extensionState";
import type { HostConfig, RepoSource } from "@ging/core/host/ports";
import type { GitGraphViewState } from "@ging/shared/types";

export type GraphViewStateDeps = {
  config: HostConfig;
  repoSource: Pick<RepoSource, "getRepos" | "getBootRepo">;
  extensionState: Pick<ExtensionState, "getDialogMemory" | "isAvatarStorageAvailable">;
};

/**
 * The view state the graph's page boots with: the settings it reads instead of
 * asking, the known repositories, the one it opens on, and the dialogs'
 * remembered choices. Every host embeds this same object in its page, so a
 * field added to `GitGraphViewState` is added here once rather than in each
 * host. What wraps it — the page skeleton, its content security policy, how
 * the script reaches the webview — stays with the host.
 */
export function buildGraphViewState({
  config,
  repoSource,
  extensionState
}: GraphViewStateDeps): GitGraphViewState {
  return {
    autoCenterCommitDetailsView: config.autoCenterCommitDetailsView(),
    commitDetailsViewLocation: config.commitDetailsViewLocation(),
    referenceLabelAlignment: config.referenceLabelAlignment(),
    combineLocalAndRemoteBranchLabels: config.combineLocalAndRemoteBranchLabels(),
    dialogDeleteBranchForceDelete: config.dialogDeleteBranchForceDelete(),
    dialogCherryPickNoCommit: config.dialogCherryPickNoCommit(),
    dialogAddTagType: config.dialogAddTagType(),
    dialogCreateBranchCheckOut: config.dialogCreateBranchCheckOut(),
    dialogMergeNoFastForward: config.dialogMergeNoFastForward(),
    dialogMergeSquash: config.dialogMergeSquash(),
    dialogResetMode: config.dialogResetMode(),
    dialogMemory: extensionState.getDialogMemory(),
    contextMenuActionsVisibility: config.contextMenuActionsVisibility(),
    customBranchGlobPatterns: config.customBranchGlobPatterns(),
    customEmojiShortcodeMappings: config.customEmojiShortcodeMappings(),
    dateFormat: config.dateFormat(),
    dateCustomFormat: config.dateCustomFormat(),
    defaultColumnVisibility: config.defaultColumnVisibility(),
    enhancedAccessibility: config.enhancedAccessibility(),
    fetchAvatars: config.fetchAvatars() && extensionState.isAvatarStorageAvailable(),
    fileTreeCompactFolders: config.fileTreeCompactFolders(),
    fileViewType: config.fileViewType(),
    graphColours: config.graphColours(),
    graphStyle: config.graphStyle(),
    initialLoadCommits: config.initialLoadCommits(),
    issueLinkingRegex: config.issueLinkingRegex(),
    issueLinkingUrl: config.issueLinkingUrl(),
    keybindings: config.keybindings(),
    lastActiveRepo: repoSource.getBootRepo(),
    loadMoreAutomatically: config.loadMoreAutomatically(),
    loadMoreCount: config.loadMoreCount(),
    markdown: config.markdown(),
    muteCommitsNotAncestorsOfHead: config.muteCommitsNotAncestorsOfHead(),
    muteMergeCommits: config.muteMergeCommits(),
    signCommits: config.signCommits(),
    onLoadScrollToHead: config.onLoadScrollToHead(),
    referenceInputSpaceSubstitution: config.referenceInputSpaceSubstitution(),
    repos: repoSource.getRepos(),
    scmMultiRepoSelection: config.scmMultiRepoSelection(),
    showCurrentBranchByDefault: config.showCurrentBranchByDefault(),
    uncommittedChangesAtHead: config.uncommittedChangesAtHead(),
    showSpecificBranches: config.showSpecificBranches(),
    showRemoteBranches: config.showRemoteBranches(),
    repoSettingDefaults: config.repoSettingDefaults(),
    showTags: config.showTags()
  };
}
