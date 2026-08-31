import { expect } from "vitest";

import { DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY } from "@/backend/utils/contextMenuVisibility";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import { buildWebviewMarkup } from "@/extension/webviewMarkup";
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
export function makeViewState(overrides: Partial<GG.GitGraphViewState> = {}): GG.GitGraphViewState {
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
    showTags: true,
    ...overrides
  };
}

/** The viewport height every suite starts with — jsdom's own default, restated
 *  so the threshold below is worked out from declared numbers rather than from
 *  one declared number and one inherited one. */
export const VIEWPORT_HEIGHT = 768;
/** The page height every suite starts with. Only its relation to
 *  VIEWPORT_HEIGHT matters: tall enough that a viewport at the top is nowhere
 *  near the bottom, so the near-the-bottom threshold starts out false. */
export const PAGE_HEIGHT = 10000;
/** The offset at which `innerHeight + scrollY >= offsetHeight - 250` first
 *  holds — the threshold, worked out from the geometry above rather than
 *  copied off the implementation. Suites that want automatic loading to fire
 *  park the viewport here. */
export const NEAR_BOTTOM = PAGE_HEIGHT - 250 - VIEWPORT_HEIGHT;

/** Park the viewport at a known offset. jsdom never scrolls on its own and its
 *  scrollTo is unimplemented, so the offset has to be declared.
 *
 *  Both names for it are written together because the webview reads each in a
 *  different place: `scrollY` for the near-the-bottom threshold, `pageYOffset`
 *  for context-menu placement *and* for deciding whether an opening Commit
 *  Details View needs bringing into view (`main.ts` around the
 *  `cdvBroughtIntoView` guard). That second reader is why the CDV suites care:
 *  their "never moves the viewport" assertions are about the branch those two
 *  comparisons choose. A viewport that is in two places at once would pick a
 *  branch neither suite is describing. */
export function parkViewportAt(offset: number) {
  Object.defineProperty(window, "scrollY", { value: offset, configurable: true });
  Object.defineProperty(window, "pageYOffset", { value: offset, configurable: true });
}

/* Give every webview suite a page with a size, at the top of it.
 *
 * jsdom performs no layout, so `document.body.offsetHeight` is 0 and `scrollY`
 * never moves unless told to. The webview's near-the-bottom test —
 * `innerHeight + scrollY >= offsetHeight - 250` — therefore degenerates to
 * `768 >= -250`: true wherever the viewport is. Multiply that by the fixture
 * above, which carries `loadMoreAutomatically: true` because it tracks the
 * shipped configuration on purpose, and any scroll event in any suite smuggles
 * in a `loadCommits` that reads like the code under test asking twice.
 *
 * Nothing was actually being smuggled when this landed: every suite that
 * dispatched a scroll had already stubbed a height of its own. That is what
 * makes it worth pinning rather than leaving alone — the ones exposed to it are
 * the ones not yet written, by someone who has not met the trap, and a suite
 * has to already suspect it to opt out. So the default is far from the bottom
 * and the threshold is false until a suite says otherwise.
 *
 * Of the three pins only `offsetHeight` changes what any suite sees today; the
 * other two restate jsdom's own defaults, so that the numbers the threshold is
 * derived from are all declared in one place instead of half-declared and
 * half-inherited.
 *
 * It reaches every suite through `setupFiles` in vitest.config.ts, not through
 * being imported — seven webview suites never import this file at all. That is
 * also why it is one bare side effect rather than an exported function nobody
 * would think to call. Every property is `configurable`, so a suite that owns
 * its geometry redefines it as before and this is only what it starts from:
 * loadMoreOnScrollDisabled and loadMoreOnScrollLayoutCost swap in counting
 * getters over their own heights, and contextMenuPosition adds the viewport
 * *width*, the one dimension nothing else measures against.
 *
 * On ADR-0019: its rejected alternative "為捲動門檻抽一個純函式" gave three
 * reasons, and this overturns the middle one — "不需要進共用的測試 setup". The
 * ruling on #97 is what overturned it, on the grounds that the first and third
 * still stand: per-suite stubbing is still the precedent for suites that want
 * their own geometry, and no seam has been opened in product code, which is
 * untouched by this file. The ADR has since been corrected in place — the
 * middle reason struck through, the other two left standing. */
Object.defineProperty(window, "innerHeight", { value: VIEWPORT_HEIGHT, configurable: true });
Object.defineProperty(document.body, "offsetHeight", {
  value: PAGE_HEIGHT,
  configurable: true
});
parkViewportAt(0);

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
  const l10nStrings = getWebviewLocalizedStrings();

  // The DOM under test is the extension's real markup — the same string
  // buildWebviewHtml embeds into the webview — so the tests' DOM and the
  // shipped DOM have one source and cannot silently diverge.
  document.body.innerHTML = buildWebviewMarkup(l10nStrings);

  (global as unknown as { viewState: GG.GitGraphViewState }).viewState = viewState;
  global["l10n"] = l10nStrings;
}

export function receive(msg: GG.ResponseMessage) {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

/** Activate a context-menu item by its label.
 *
 *  `toBeDefined`, not `not.toBeNull`: `find` yields `undefined` when nothing
 *  matches, and a null check waves that straight through — leaving the miss to
 *  surface a line later on `dispatchEvent`, as a TypeError naming neither the
 *  label nor the fact that the menu simply did not carry it (issue #131). A
 *  fixture that has drifted then reads like a listener that stopped working.
 *
 *  It is here for the reason `makeViewState` is: five suites held byte-identical
 *  copies, so one wrong assertion was wrong in five places and had to be
 *  corrected in five.
 *
 *  Six local copies remain, and this is not the finished inventory — issue #154
 *  is where the whole set gets settled, including whether the guard should throw
 *  rather than assert. Three of them are byte-identical to this one
 *  (`dialogSurvivesBackgroundReload`, `loadMoreOnScroll`,
 *  `stashSelectorBoundAtConsent`); nothing distinguishes them, and they are out
 *  of this change only because #131 named a different six files. The other three
 *  (`cdvFileListenerScope`, `graphCommitListenerScope`,
 *  `graphCommitListenerScopeDocked`) end differently, handing the element to a
 *  local `click(elem)` rather than dispatching here, so folding them in means
 *  first deciding whether that indirection survives. `droppedLoadRequests` is a
 *  fourth shape rather than a copy: `chooseCommitOrder` opens the menu itself and
 *  matches on `.contextMenuItemLabel` instead of the whole row, and its assertion
 *  was already right before #131 was filed.
 *
 *  No suite reaches the guard: every label they pass is one their menu really
 *  carries. `missingMenuItem` is what exercises the miss, and without it a green
 *  run cannot tell an assertion that fires from one that only looks like it. */
export function clickItem(label: string) {
  const item = Array.from(
    document.querySelectorAll<HTMLElement>("#contextMenu .contextMenuItem")
  ).find((li) => (li.textContent ?? "").trim() === label);
  expect(item, label).toBeDefined();
  item!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}
