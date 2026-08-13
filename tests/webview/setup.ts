import { DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY } from "@/backend/utils/contextMenuVisibility";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

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
export function makeViewState(
  overrides: Partial<GG.GitGraphViewState> = {}
): GG.GitGraphViewState {
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
    loadMoreAutomatically: false,
    loadMoreCommits: 75,
    markdown: false,
    muteCommitsNotAncestorsOfHead: false,
    muteMergeCommits: true,
    onLoadScrollToHead: false,
    referenceInputSpaceSubstitution: "None",
    repos: { [DEFAULT_REPO]: { columnWidths: null } },
    scmMultiRepoSelection: true,
    showCurrentBranchByDefault: false,
    uncommittedChangesAtHead: false,
    showSpecificBranches: [],
    showRemoteBranches: true,
    showTags: true,
    ...overrides
  };
}

// The real vscode.setState persists state as JSON, so anything that doesn't
// survive a JSON round-trip (Map, Set, DOM elements) is silently lost. Model
// that here, otherwise tests restore live objects the real webview never gets.
function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

export function createVscodeMock(initialState: WebViewState | null = null) {
  const sent: GG.RequestMessage[] = [];
  // The real getState() yields undefined (not null) when nothing was saved —
  // model that exactly, so a boot path that only handles null fails here too.
  let state: WebViewState | undefined =
    initialState === null ? undefined : jsonRoundTrip(initialState);

  const mock = {
    postMessage: (msg: GG.RequestMessage) => sent.push(msg),
    getState: () => state,
    setState: (s: WebViewState) => {
      state = jsonRoundTrip(s);
    }
  };

  global.acquireVsCodeApi = () => mock;

  return {
    sentMessages: sent,
    clearMessages: () => sent.splice(0),
    getState: () => state
  };
}

export function setupHtml(viewState: GG.GitGraphViewState) {
  document.body.innerHTML = `
    <div id="controls">
      <div id="controlsLeft">
        <div id="repoDropdown">
          <div id="repoTitle">
            <span id="repoTitleName"></span>
            <span id="repoTitleChevron"></span>
          </div>
          <ul id="repoDropdownList" role="listbox" tabindex="-1"></ul>
        </div>
        <span id="repoTitleBranch"></span>
        <div id="branchFilterChip">
          <span id="branchFilterIcon"></span>
          <span id="branchFilterText"></span>
          <div id="branchFilterClear" title="Show All"></div>
        </div>
      </div>
      <div id="refreshBtn" class="roundedBtn">Refresh</div>
      <div id="blinkHeadBtn" class="roundedBtn">Locate HEAD</div>
      <div id="findBtn" class="roundedBtn">Find</div>
    </div>
    <div id="content">
      <div id="commitGraph"></div>
      <div id="commitTable"></div>
    </div>
    <div id="footer"></div>
    <div id="findWidget">
      <input id="findInput" type="text">
      <span id="findCount"></span>
      <div id="findPrev" class="findBtn"></div>
      <div id="findNext" class="findBtn"></div>
      <div id="findClose" class="findBtn"></div>
    </div>
    <ul id="contextMenu" role="menu" tabindex="-1"></ul>
    <div id="dialogBacking"></div>
    <div id="dialog"></div>
    <div id="scrollShadow"></div>
  `;

  (global as unknown as { viewState: GG.GitGraphViewState }).viewState = viewState;
  global["l10n"] = getWebviewLocalizedStrings();
}

export function receive(msg: GG.ResponseMessage) {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}
