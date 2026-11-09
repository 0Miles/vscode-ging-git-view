import { DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY } from "@/backend/utils/contextMenuVisibility";
import type * as GG from "@/types";

/* The single source of the default GitGraphViewState (issue #76). It lives
 * apart from setup.ts because two kinds of caller load it: the webview suites,
 * through setup.ts, and scripts/webview-harness.js, which bundles this file
 * with esbuild and runs it under plain node. So nothing here may import vitest,
 * the DOM, or anything else only a test run provides. */

/** The repository path the shared viewState fixture is loaded with. Suites
 *  that talk to "the" repo should reuse it so their messages target the same
 *  repo the fixture registered. */
export const DEFAULT_REPO = "/workspace/my-repo";

/**
 * The one viewState fixture behind every webview suite. The baseline is a
 * single repo (DEFAULT_REPO) under a realistic, near-shipped configuration;
 * a suite overrides only the fields its scenario actually turns on, so a new
 * GitGraphViewState field lands here once instead of in every test file.
 */
export function makeViewState(overrides: Partial<GG.GitGraphViewState> = {}): GG.GitGraphViewState {
  const state = buildViewState(overrides);
  // The host now resolves which repo the graph boots on and sends it as
  // `lastActiveRepo` — the webview no longer picks one out of `repos` itself,
  // because `repos` is persisted state that can name directories that are gone
  // and only the host can tell. Suites that don't care which repo boots get
  // the seed the host would send for a workspace whose repos are all present.
  // A suite that passes `lastActiveRepo` explicitly — including `null`, which
  // now means "the host found no live repo" — keeps what it asked for.
  if (!("lastActiveRepo" in overrides)) {
    state.lastActiveRepo = Object.keys(state.repos)[0] ?? null;
  }
  return state;
}

function buildViewState(overrides: Partial<GG.GitGraphViewState>): GG.GitGraphViewState {
  return {
    autoCenterCommitDetailsView: true,
    commitDetailsViewLocation: "Inline",
    referenceLabelAlignment: "Normal",
    combineLocalAndRemoteBranchLabels: true,
    dialogDeleteBranchForceDelete: false,
    dialogCherryPickNoCommit: false,
    dialogAddTagType: "annotated",
    dialogCreateBranchCheckOut: false,
    dialogMergeNoFastForward: true,
    dialogMergeSquash: false,
    dialogResetMode: "mixed",
    dialogMemory: {},
    contextMenuActionsVisibility: DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY,
    customBranchGlobPatterns: [],
    customEmojiShortcodeMappings: {},
    dateFormat: "Date & Time",
    dateCustomFormat: "DD MMM YYYY",
    defaultColumnVisibility: { date: true, author: true, commit: true },
    enhancedAccessibility: false,
    fetchAvatars: false,
    fileTreeCompactFolders: true,
    fileViewType: "File Tree",
    graphColours: ["#0085d9"],
    graphStyle: "rounded",
    initialLoadCommits: 300,
    issueLinkingRegex: "",
    issueLinkingUrl: "",
    keybindings: { find: "f", refresh: "r", scrollToHead: "h", scrollToStash: "s" },
    lastActiveRepo: null,
    loadMoreAutomatically: true,
    loadMoreCount: 100,
    markdown: false,
    muteCommitsNotAncestorsOfHead: false,
    muteMergeCommits: true,
    onLoadScrollToHead: false,
    referenceInputSpaceSubstitution: "None",
    repos: { [DEFAULT_REPO]: { columnWidths: null } },
    scmMultiRepoSelection: true,
    signCommits: false,
    showCurrentBranchByDefault: false,
    uncommittedChangesAtHead: false,
    showSpecificBranches: [],
    showRemoteBranches: true,
    repoSettingDefaults: {
      onlyFollowFirstParent: false,
      includeReflogCommits: false,
      showStashes: true,
      showTagOnlyCommits: true,
      showRemoteHeads: true,
      showInactiveBranches: false,
      showMergedBranches: false
    },
    showTags: true,
    ...overrides
  };
}
