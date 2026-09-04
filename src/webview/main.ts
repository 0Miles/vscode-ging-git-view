import type {
  BatchActionRequest,
  BatchDeleteResult,
  BatchRefResult,
  BranchSearchEntry,
  BranchRedundancy,
  CommitOrdering,
  GitCommandStatus,
  GitCommitDetails,
  GitCommitNode,
  GitFileChange,
  GitFileChangeType,
  GitOperation,
  GitResetMode,
  GitTagDetails,
  RedundancyCommit
} from "@/backend/types";
import { displayRef, REMOTE_PREFIX } from "@/backend/utils/branchRef";
import {
  planRebase,
  type RebaseCommit,
  type RebasePlan,
  rebaseTodo
} from "@/backend/utils/rebasePlan";
import { REF_ACTION_CATALOGUE } from "@/backend/utils/refActionCatalogue";

import { BatchRun, type BatchRunCommand, type BatchRunOptions } from "./batchRun";
import { defaultCheckedRefs, groupToggleState, mergeCheckedRefs } from "./branchCleanup";
import { applyDialogMemory, extractDialogMemory } from "./dialogMemory";
import { createErrorReporter } from "./errorReporting";
import { buildFindMatches, planFindLoad, resolveFindCurrent, type FindMatch } from "./find";
import { Graph } from "./graph";
import { type RebaseReplay, rebaseReplay } from "./rebaseReplay";
import { menuFor, type RefMenuActions, type RefTarget } from "./refContextMenu";
import { formatDate, pad2 } from "./utils/date";
import { addListenerToClass, blinkRow, insertAfter } from "./utils/dom";
import { replaceEmojiShortcodes } from "./utils/emoji";
import {
  alterGitFileTree,
  compactGitFileTree,
  deserializeGitFileTree,
  generateGitFileListHtml,
  generateGitFileTree,
  generateGitFileTreeHtml,
  serializeGitFileTree
} from "./utils/fileTree";
import {
  arraysEqual,
  branchFilterLabel,
  commitNodeTooltip,
  commitsReachableFrom,
  dropCommitPossible,
  ELLIPSIS,
  graphNavigationTarget,
  latestTagName,
  type RebaseOntoRange,
  rebaseOntoRange,
  refInvalid,
  signatureCategory,
  splitDisplayRemoteRef,
  substituteRefSpaces
} from "./utils/git";
import {
  escapeHtml,
  firstIssueUrl,
  linkifyCommitHashes,
  linkifyIssues,
  linkifyUrls,
  preserveLeadingWhitespace,
  renderInlineMarkdown,
  unescapeHtml
} from "./utils/html";
import { svgIcons } from "./utils/icons";
import { RovingTabStop, stepWithinGroup } from "./utils/rovingFocus";
import { getVSCodeStyle, sendMessage, vscode } from "./utils/vscode";

/** Where every failure this view cannot handle goes: to the host, and from
 *  there into the GING Output Channel (ADR-0016). Armed as this module's first
 *  statement, so the failures thrown while the view is being built below are
 *  reported too — though not one thrown while an imported module above is
 *  evaluating, which is earlier than anything here can reach. */
const errorReporter = createErrorReporter((report) =>
  sendMessage({ command: "reportError", report })
);
errorReporter.watchGlobals(window);

/** Everything in the graph that keyboard focus can land on. Each is also a
 *  context-menu source, which is the point: a menu that only `contextmenu` can
 *  raise needs a focusable element to be raised from. */
const GRAPH_FOCUSABLE = "tr.commit, tr.unsavedChanges, #tableColHeaders, .tableColHeader, .gitRef";

/** Everything that can raise a context menu, and so everything Shift+F10 and
 *  the Context Menu key have to work on. The header *row* is absent: its menu
 *  belongs to the individual column headers, which Left/Right reach. */
const MENU_SOURCES =
  "tr.commit, tr.unsavedChanges, .tableColHeader, .gitRef, .gitFile, .commitBodyLink";

/** What Enter and Space activate. Commit-message links are absent: they are real
 *  `<a href>`s, and the browser already knows Enter follows a link while Space
 *  scrolls the page. The footer's two controls are absent for the same reason —
 *  they are real `<button>`s, and a second opinion about Enter is how a button
 *  gets pressed twice. */
const ACTIVATABLE = GRAPH_FOCUSABLE + ", .gitFile";

/** The graph footer's controls, by id. Peers rather than a roving group: Tab
 *  visits each of them, so neither needs a tabindex and there is no tab stop to
 *  hold between them — being real `<button>`s is the whole of it (#88).
 *
 *  The list exists so a redraw can tell "focus was on a control this footer is
 *  about to destroy" from "focus is somewhere else entirely". See
 *  {@link GitGraphView.rememberFooterFocus}. */
const FOOTER_CONTROLS = new Set(["loadMoreCommitsBtn", "resetLoadedCommitWindowBtn"]);

/** The commit table's column-header row. A row for navigation — Up from the
 *  first commit reaches it, which is what makes the column and commit-ordering
 *  menu keyboard-reachable — but not a place to enter the grid at. */
function isHeaderRow(row: HTMLElement): boolean {
  return row.id === "tableColHeaders";
}

/** What a commit table row *stands for*, as opposed to which element it is.
 *  `renderTable` replaces every row object, so anything that has to survive a
 *  re-render — the keyboard's place in the graph above all — has to name its
 *  row by this and look it up again afterwards. A commit's hash is the obvious
 *  key; the header and uncommitted-changes rows are one of a kind, so their
 *  place in the table is key enough.
 *
 *  Rows are as fine as this goes, deliberately. Focus sitting on a ref chip
 *  *within* a row comes back to the row, so a re-render resets the Left/Right
 *  axis of ADR-0014 while preserving the Up/Down one. Keying the widgets too
 *  would need a second identity scheme for chips whose row may itself have
 *  gone, to buy back an axis the user re-enters with one keypress — and before
 *  any of this, focus was lost outright, so the row is already the whole of the
 *  ground gained. */
function graphRowKey(row: HTMLElement): string {
  return row.dataset.hash ?? (isHeaderRow(row) ? "#columnHeaders" : "#uncommittedChanges");
}

/** What a Commit Details View file row *stands for*, the way
 *  {@link graphRowKey} names a commit row — the path the row is about, which is
 *  what the user thinks they are standing on. Two renders of the same view give
 *  the same file the same key, so it survives the redraw that replaces every
 *  row object.
 *
 *  The path, not the row's position, for the same reason a commit is keyed by
 *  hash: the tree and list layouts order and label the rows differently, and a
 *  file's index means nothing across the two. The path is written into both
 *  layouts' markup by the same `renderGitFileRow`, so the key is the one thing
 *  that does not change between them. It is also unique within a view: a commit
 *  changes any given path at most once. */
function cdvFileKey(file: HTMLElement): string {
  return file.dataset.newfilepath!;
}

/** Which of `rows` keyboard focus is in — the row itself, or a widget nested
 *  inside it, such as a ref chip. Undefined when focus is somewhere else
 *  entirely, which each caller reads its own way: as no row to key, as a cue to
 *  step from the expanded commit instead, or as nothing to walk. */
function focusedRow(rows: HTMLElement[]): HTMLElement | undefined {
  const active = document.activeElement;
  return rows.find((row) => row === active || row.contains(active));
}

/** The focusable elements of a commit table row, in visual order: the ref chips
 *  of a commit row, the column headers of the header row. Left/Right walk
 *  these — the row itself is what Up/Down move between. */
function rowWidgets(row: HTMLElement): HTMLElement[] {
  // A hidden column's header still exists in the markup but `display: none`
  // takes it out of the focus order, so walking onto it would strand focus.
  return Array.from(row.querySelectorAll<HTMLElement>(".gitRef, .tableColHeader")).filter(
    (widget) => !widget.classList.contains("hidden")
  );
}

/** The keyboard's way of asking for a context menu (Shift+F10, or the Context
 *  Menu key). Dispatched on the focused element so it bubbles to the same
 *  handlers a right-click reaches, and so the innermost source wins — a ref
 *  chip rather than the commit row behind it — exactly as it does for the
 *  pointer. */
const MENU_KEY_EVENT = "ging.contextMenuKey";

/** Wire a context-menu handler to both ways of raising one. */
function addContextMenuListener(className: string, listener: EventListener) {
  addListenerToClass(className, "contextmenu", listener);
  addListenerToClass(className, MENU_KEY_EVENT, listener);
}

/** ExpandedCommit in the JSON-safe form saved with vscode.setState: DOM
 *  references are dropped (renderTable re-binds them to the fresh rows) and
 *  the file tree's Maps are converted to arrays. */
function serializeExpandedCommit(
  expandedCommit: ExpandedCommit | null
): SerializedExpandedCommit | null {
  if (expandedCommit === null) return null;
  const { srcElem: _src, compareWithSrcElem: _cmp, fileTree, ...rest } = expandedCommit;
  return { ...rest, fileTree: fileTree !== null ? serializeGitFileTree(fileTree) : null };
}

/** Revive a persisted ExpandedCommit. An invalid file tree (e.g. saved by a
 *  version that persisted Maps, which JSON collapsed to {}) becomes NULL, so
 *  renderTable re-requests the commit details instead of crashing. */
function deserializeExpandedCommit(
  expandedCommit: SerializedExpandedCommit | null
): ExpandedCommit | null {
  if (!expandedCommit) return null;
  return {
    ...expandedCommit,
    srcElem: null,
    compareWithSrcElem: null,
    fileTree: deserializeGitFileTree(expandedCommit.fileTree)
  };
}

/** The batch actions a BatchRun can execute, named by their protocol command
 *  so the tag can never drift from the messages it labels. */
type BatchActionKind = BatchActionRequest["command"];
/** What every batch run carries for its adapter whatever the action is: the
 *  repository the run was started for. Each action's own parameters intersect
 *  with this, so no `send` has to read the repo at send time — by then the
 *  confirmation, the host round-trip and possibly a retry dialog have all
 *  happened. */
type BatchParams = { repo: string };

/** Where Find is standing, in the form something that moved it can put it back.
 *  The hash is the position; the index is only what `resolveFindCurrent` falls
 *  back to on the one case the hash cannot cover — the match having stopped
 *  matching while the branch index was out. */
type FindPosition = { hash: string | null; index: number };

/** A step onto a match that a branch names, waiting on a fresh branch index —
 *  the branch may have moved since the one in hand was fetched, so where the
 *  step lands is settled against the answer, not against the click. Nothing
 *  about the step has happened yet; `direction` is the one thing it would set,
 *  carried here rather than written, and written only if the step goes ahead. */
type PendingFindNavigation = { hash: string; branchRefs: string[]; direction: -1 | 1 };

/** Whether the step that called {@link GitGraphView.loadFindMatch} may record
 *  itself.
 *
 *  - `move`: go ahead. Either the match is already loaded and no request was
 *    needed — emphatically not a failure, and the ordinary case — or a load is
 *    on its way and the page that lands will draw it.
 *  - `hold`: nothing went out, so nothing may be recorded. Either the request
 *    was dropped ({@link GitGraphView.commitLoadInFlight}), or the plan needs
 *    confirming and the user has not answered — and while that dialog stands,
 *    no more has happened than if the request had been dropped.
 *
 *  Both sources of `hold` are visible to the user, and neither caller has to
 *  know which one it got: the confirming one put a question on screen, and the
 *  dropped one raises `dialogFindStepBusy` where it is refused (#137). That
 *  parity is why the callers may go on treating `hold` as one answer — before
 *  it held, half of every `hold` was a step that reported nothing at all. */
type FindLoadOutcome = "move" | "hold";

/** What brought {@link GitGraphView.loadMoreCommits} here — and therefore
 *  whether a refusal has anyone to report to.
 *
 *  Named for ADR-0019's own two categories rather than for the two input
 *  devices, because the category is the part a third caller would have to get
 *  right. Pressing the footer button is an **operation**: the user asked for the
 *  next page, so a page that cannot be fetched is news they are owed. Reaching
 *  the bottom of the graph is **browsing** —「捲到底是瀏覽:使用者什麼都沒要
 *  求」— so there is no request to refuse and nobody to tell, and an error
 *  dialog raised over a scroll is exactly the operation-level side effect that
 *  ADR's title forbids.
 *
 *  Until now the two paths shared every effect they had. The ADR's 後果 section
 *  is sometimes read as an earlier divergence, but it is not one: it took
 *  `hideCommitDetails()` off *both* paths, which is the two of them going on
 *  agreeing about everything. How the refusal is delivered is the first thing
 *  they genuinely do not share — hence a named distinction rather than a
 *  boolean, so the next reader sees a claim rather than a flag. */
type LoadMoreTrigger = "operation" | "browsing";

/**
 * A commit or branch a rebase is aimed at, in the two spellings its dialog
 * needs: `value` is what git is handed and what travels on the wire, `label`
 * how that same object is written for the user — an abbreviated hash for a
 * commit, its own name for a branch.
 *
 * They are two values, not one: an abbreviated hash is not the hash the
 * message carries. Keeping them apart is also what makes the escaping
 * decidable — **both are raw text**. The printed command escapes the whole
 * line it builds (`rebasePickCommandHtml`), and the confirmation escapes
 * `label` at the point it interpolates it, so no caller has to remember which
 * form it owes. Passing pre-escaped HTML in here is the bug this shape exists
 * to prevent: it printed `fix&amp;bug` in a command line that runs against
 * `fix&bug`, which ADR-0022 requires to be the same string.
 */
type RebaseTarget = { value: string; label: string };

/** The rebase target a commit is: git takes the full hash, the user reads the
 *  abbreviated one. */
const commitTarget = (hash: string): RebaseTarget => ({ value: hash, label: abbrevCommit(hash) });

/** The rebase target a local branch is — git and the user read the same name.
 *  Only local branches reach this: rebase is a `refKinds: "local"` action, so
 *  the display ref and the canonical ref are the one string (CONTEXT.md,
 *  "Ref 的兩種形"). */
const branchTarget = (refName: string): RebaseTarget => ({ value: refName, label: refName });

class GitGraphView {
  private gitRepos: GG.GitRepoSet;
  // Whether the Source Control view is in multi-select mode. Only then does the
  // graph offer a repo dropdown — see `repoDropdownRepos`.
  private scmMultiRepoSelection = true;
  private gitBranches: string[] = [];
  private gitBranchHead: string | null = null;
  private remotes: string[] = [];
  private pushDefault: string | null = null;
  private findActive = false;
  private findMatches: FindMatch[] = [];
  private findCurrent = -1;
  /** The {@link findIdentity} the last pass over the matches resolved — every
   *  pass claims it, whether or not that pass moved the viewport, and whether
   *  or not the target had a row to move to. Null while Find points at nothing,
   *  and reset when the widget closes.
   *
   *  {@link cdvBroughtIntoView} is the same idea one misuse over, and is named
   *  for the scroll because it only ever records one it performed. This one
   *  cannot borrow that name: what it stands for is where Find is pointing, not
   *  where the viewport has been. */
  private findSettledOn: string | null = null;
  // When on, navigating find matches also opens each one's details view.
  private findOpenCommitDetails = false;
  private branchSearchToken = 0;
  private branchSearchIndex: BranchSearchEntry[] = [];
  private findDirection: -1 | 1 = 1;
  private pendingFindTargetHash: string | null = null;
  private pendingFindNavigation: PendingFindNavigation | null = null;
  private commits: GitCommitNode[] = [];
  private commitHead: string | null = null;
  private commitLookup: { [hash: string]: number } = {};
  private avatars: AvatarImageCollection = {};
  // The branch filter, owned by the extension host (the Branches side-view) and
  // pushed in via `loadBranches`/`setBranchFilter`. The refs to show; an empty
  // list means "show all branches". null until the first load resolves it.
  // Write it only through `setCurrentBranches`, which redraws the toolbar chip.
  private currentBranches: string[] | null = null;
  // Refs the host says to render dimmed: merged into the default branch and not
  // exempt. Sent in `loadBranches` format (`main`, `remotes/origin/main`) and
  // kept verbatim for change detection and state persistence; `dimmedRefs` holds
  // the same set normalised to the names the graph's chips carry (`origin/main`).
  private dimmedBranches: string[] = [];
  private dimmedRefs = new Set<string>();
  // Refs the cleanup dialog would propose, normalised to the chips' names. Not
  // the same set as `dimmedRefs` — the exemptions differ by the branch filter —
  // and it affects nothing that is drawn: it gates one context-menu item, which
  // is how the graph comes to know about inactive branches without expressing
  // them anywhere (ADR-0017).
  private cleanupCandidateRefs = new Set<string>();
  private currentRepo!: string;
  // The last branch-deletion request, so a failed non-force delete can offer a
  // one-click force delete.
  private pendingDeleteBranch: {
    repo: string;
    branchName: string;
    deleteOnRemotes: boolean;
  } | null = null;
  // A branch action delegated by the Branches side-view, held until this view
  // shows the right repo with its data loaded. lastRefActionSeq dedupes the
  // host's two delivery paths (direct post + post-reload flush).
  private pendingRefAction:
    | GG.ResponseRunRefAction
    | GG.ResponseRunRefBatchAction
    | GG.ResponseShowBranchCleanup
    | null = null;
  private lastRefActionSeq = 0;
  // The one batch run in flight (at most): rounds, retry offer and summary all
  // live behind its interface — the adapters below only execute its commands.
  private batchRun = new BatchRun<BatchActionKind>();
  /** A summary an ended run could not show, because the dialog slot was taken
   *  at the moment it ended. Held until there is a screen for it; see
   *  {@link abandonBatchRun} and {@link deliverOwedBatchSummary}. */
  private owedSummary: { results: BatchRefResult[]; action: BatchActionKind } | null = null;

  private graph: Graph;
  private config: Config;
  private moreCommitsAvailable: boolean = false;
  // Scroll offset to restore once the next load re-renders the table, so an
  // action / manual refresh keeps the user's place rather than jumping.
  private pendingScrollRestore: number | null = null;
  private showRemoteBranches: boolean = true;
  private expandedCommit: ExpandedCommit | null = null;
  // The CDV identity already scrolled into view, so a redraw of the same view
  // does not scroll again. Null whenever no CDV is open.
  private cdvBroughtIntoView: string | null = null;
  private maxCommits: number;
  // Whether the *next commit load to land* may take the viewport with it when
  // it puts focus back. Set by the one operation that shrinks the loaded set on
  // purpose, and spent in loadCommits — deliberately not in restoreGraphFocus,
  // which every redraw reaches. `renderTable` has upstreams that owe nothing to
  // a commit load (a remote list arriving, a column toggled) and none of them
  // is held back by one in flight, so hanging it on "the next redraw" loses
  // both ways: that redraw scrolls though the user asked for nothing, and the
  // reset's own redraw finds the permission already spent.
  private pendingFocusScroll = false;
  private hasScrolledToHeadOnLoad = false;
  // Cached `document.body.offsetHeight` for the near-the-bottom threshold; null
  // means "not measured since the last change that could have moved the bottom".
  // See getPageHeight / observePageHeight.
  private pageHeight: number | null = null;
  private columnVisibility = { date: true, author: true, commit: true };
  private currentStashScroll = -1;
  private alwaysAcceptCheckoutCommit = false;

  private tableElem: HTMLElement;
  private footerElem: HTMLElement;
  private scrollShadowElem: HTMLElement;

  /** Which of the {@link FOOTER_CONTROLS} held focus when the footer was last
   *  redrawn, or null when focus was not there to lose. It is state and not a
   *  local because a Load More press takes two redraws to answer — the spinner
   *  goes in when the request leaves, the button comes back when the page
   *  lands — and there is nothing in the footer to hold focus in between. See
   *  {@link rememberFooterFocus}. */
  private footerFocusId: string | null = null;

  // The graph and the Commit Details View's file list are each one roving-
  // tabindex group, so Tab crosses each in a single press and the arrow keys
  // move within them. Two groups, not one: they are separate widgets, and
  // arrowing through files must not walk out into the commits behind them.
  private graphTabStop = new RovingTabStop();
  private cdvFileTabStop = new RovingTabStop();

  private loadBranchesCallback: ((changes: boolean, isRepo: boolean) => void) | null = null;
  private loadCommitsCallback: ((changes: boolean) => void) | null = null;
  /** Which navigation the panel is on. Stamped onto every branch/commit request
   *  and echoed back on the response, so an answer that belongs to a navigation
   *  the user has left is recognisable on arrival — see
   *  {@link abandonLoadsInFlight}, which is what puts two of them in the air. */
  private loadToken = 0;

  constructor(
    repos: GG.GitRepoSet,
    lastActiveRepo: string | null,
    config: Config,
    prevState: WebViewState | null
  ) {
    this.gitRepos = repos;
    this.scmMultiRepoSelection = viewState.scmMultiRepoSelection !== false;
    this.config = config;
    this.columnVisibility = viewState.defaultColumnVisibility;
    this.showRemoteBranches = config.showRemoteBranches;
    this.maxCommits = config.initialLoadCommits;
    // Reference-label alignment: CSS hooks for the chosen layout.
    document.body.classList.toggle("branchLabelsAlignedToGraph", config.branchLabelsAlignedToGraph);
    document.body.classList.toggle("tagLabelsRightAligned", config.tagLabelsRightAligned);
    this.graph = new Graph("commitGraph", this.config);
    this.tableElem = document.getElementById("commitTable")!;
    this.footerElem = document.getElementById("footer")!;
    this.scrollShadowElem = <HTMLInputElement>document.getElementById("scrollShadow")!;
    const refreshBtn = document.getElementById("refreshBtn")!;
    refreshBtn.innerHTML = svgIcons.refresh;
    refreshBtn.addEventListener("click", () => {
      this.refresh(true, true); // manual refresh keeps the user's scroll position
    });
    const fetchBtn = document.getElementById("fetchBtn");
    if (fetchBtn) {
      fetchBtn.innerHTML = svgIcons.download;
      fetchBtn.addEventListener("click", () => {
        if (!this.currentRepo) return;
        sendMessage({ command: "fetch", repo: this.currentRepo });
        showActionRunningDialog(l10n.fetching);
      });
    }
    const blinkBtn = document.getElementById("blinkHeadBtn");
    if (blinkBtn) {
      blinkBtn.innerHTML = svgIcons.locate;
      blinkBtn.addEventListener("click", () => {
        this.scrollToHead();
      });
    }
    const findBtn = document.getElementById("findBtn");
    if (findBtn) {
      findBtn.innerHTML = svgIcons.search;
      findBtn.addEventListener("click", () => this.showFind());
    }
    const terminalBtn = document.getElementById("terminalBtn");
    if (terminalBtn) {
      terminalBtn.innerHTML = svgIcons.terminal;
      terminalBtn.addEventListener("click", () => {
        if (this.currentRepo) {
          sendMessage({ command: "openTerminal", repo: this.currentRepo });
        }
      });
    }
    const repoTitle = document.getElementById("repoTitle");
    if (repoTitle) {
      const chevron = document.getElementById("repoTitleChevron");
      if (chevron) chevron.innerHTML = svgIcons.chevronDown;
      repoTitle.addEventListener("click", (e) => {
        // Only swallow the click when it actually opens the dropdown: it would
        // otherwise reach the document listener below and close what it just
        // opened. As a plain label the block is inert, and the click must carry
        // on to the document — that is what dismisses an open context menu.
        if (!this.repoDropdownOnOffer()) return;
        e.stopPropagation();
        this.toggleRepoDropdown();
      });
      repoTitle.addEventListener("keydown", (e) => {
        if (!this.repoDropdownOnOffer()) return;
        const key = (<KeyboardEvent>e).key;
        if (key === "Enter" || key === " " || key === "ArrowDown") {
          e.preventDefault();
          this.toggleRepoDropdown();
        } else if (key === "Escape") {
          this.closeRepoDropdown(true);
        }
      });
    }
    const repoList = document.getElementById("repoDropdownList");
    if (repoList) {
      repoList.addEventListener("click", (e) => e.stopPropagation());
      repoList.addEventListener("keydown", (e) => this.repoDropdownKeydown(<KeyboardEvent>e));
    }
    document.addEventListener("click", () => this.closeRepoDropdown());
    // A right-click anywhere is about to raise a context menu; the two popups
    // must not share the screen.
    document.addEventListener("contextmenu", () => this.closeRepoDropdown());
    const filterIcon = document.getElementById("branchFilterIcon");
    if (filterIcon) filterIcon.innerHTML = svgIcons.filter;
    const filterClear = document.getElementById("branchFilterClear");
    if (filterClear) {
      filterClear.innerHTML = svgIcons.close;
      // The host owns the filter, so this only asks. The chip disappears when
      // the resulting `setBranchFilter` comes back — no optimistic clear, which
      // would show "all branches" over a graph still rendering the subset.
      filterClear.addEventListener("click", () => sendMessage({ command: "clearBranchFilter" }));
    }
    const findInput = <HTMLInputElement | null>document.getElementById("findInput");
    if (findInput) {
      findInput.addEventListener("keyup", (e) => {
        if (e.key === "Enter") this.findStep(e.shiftKey ? -1 : 1);
        else if (e.key === "Escape") this.hideFind();
        else this.runFind(findInput.value);
      });
    }
    document.getElementById("findPrev")?.addEventListener("click", () => this.findStep(-1));
    document.getElementById("findNext")?.addEventListener("click", () => this.findStep(1));
    document.getElementById("findOpenCdv")?.addEventListener("click", () => {
      // Toggle opening the current match's details view as you navigate.
      this.findOpenCommitDetails = !this.findOpenCommitDetails;
      document
        .getElementById("findOpenCdv")
        ?.classList.toggle("active", this.findOpenCommitDetails);
      if (this.findOpenCommitDetails) this.applyFindHighlights(true);
    });
    document.getElementById("findClose")?.addEventListener("click", () => this.hideFind());
    this.observeWindowSizeChanges();
    this.observeWebviewStyleChanges();
    this.observeWebviewScroll();

    this.renderShowLoading();
    // The extension may have retargeted the view while the webview was dead
    // (e.g. following a Source Control repo switch with the panel hidden):
    // lastActiveRepo then names a different repo than the saved state, and the
    // saved per-repo state must not win over it — loadRepos below only consults
    // lastActiveRepo when no current repo was restored. On ordinary reloads the
    // two match (selectRepo persists both), so restores keep working.
    const repoRetargeted =
      prevState !== null &&
      lastActiveRepo !== null &&
      lastActiveRepo !== prevState.currentRepo &&
      typeof this.gitRepos[lastActiveRepo] !== "undefined";
    if (prevState) {
      this.showRemoteBranches = prevState.showRemoteBranches;
      if (prevState.columnVisibility) this.columnVisibility = prevState.columnVisibility;
      this.alwaysAcceptCheckoutCommit = prevState.alwaysAcceptCheckoutCommit === true;
      if (!repoRetargeted && typeof this.gitRepos[prevState.currentRepo] !== "undefined") {
        this.setCurrentBranches(prevState.currentBranches);
        this.currentRepo = prevState.currentRepo;
        this.maxCommits = prevState.maxCommits;
        this.expandedCommit = deserializeExpandedCommit(prevState.expandedCommit);
        this.avatars = prevState.avatars;
        // Restore remotes before rendering the saved commits: folding a remote
        // branch label into its local head needs the remote names to split
        // "<remote>/<branch>", otherwise the labels render separately.
        this.remotes = prevState.remotes ?? [];
        this.pushDefault = prevState.pushDefault ?? null;
        this.loadBranches(
          prevState.gitBranches,
          prevState.gitBranchHead,
          true,
          true,
          prevState.currentBranches ?? [],
          // Restore the dimmed set too: without it the saved commits render
          // undimmed until the next load resolves, a visible flash.
          prevState.dimmedBranches ?? []
        );
        this.loadCommits(
          prevState.commits,
          prevState.commitHead,
          prevState.moreCommitsAvailable,
          true
        );
      }
    }
    this.loadRepos(this.gitRepos, lastActiveRepo);
    this.applyShowRemoteBranchesForRepo();
    this.requestLoadBranchesAndCommits(false);
  }

  /** Switch the graph to another known repository (a sub-repo clicked in the
   *  file tree, #155). No-op if already on it. */
  private switchToRepo(repo: string) {
    if (repo === this.currentRepo) return;
    this.currentRepo = repo;
    this.shrinkLoadedCommitWindow();
    this.clearExpandedCommit();
    this.setCurrentBranches(null);
    this.applyShowRemoteBranchesForRepo();
    this.updateRepoTitle();
    this.saveState();
    sendMessage({ command: "selectRepo", repo });
    this.navigateReload();
  }

  /** The absolute path of the known sub-repository at `filePath` within the
   *  current repo, or null if none — used to load a clicked submodule. */
  private subrepoForPath(filePath: string): string | null {
    if (this.currentRepo === undefined) return null;
    const candidate = this.currentRepo.replace(/\/$/, "") + "/" + filePath;
    return candidate !== this.currentRepo && this.gitRepos[candidate] !== undefined
      ? candidate
      : null;
  }

  /** Resolve the "Show Remote Branches" state for the current repo: a per-repo
   *  override wins over the global setting. The toggle now lives in the Branches
   *  side-view; the graph just consumes the resolved value. */
  private applyShowRemoteBranchesForRepo() {
    const override = this.gitRepos[this.currentRepo]?.showRemoteBranches;
    this.showRemoteBranches =
      typeof override === "boolean" ? override : this.config.showRemoteBranches;
  }

  /** Record the branch filter and redraw the chip that reports it. Every write
   *  to `currentBranches` goes through here: the chip is the only outward sign
   *  that the graph is showing a subset, so any path that changed the filter
   *  without redrawing it would leave the toolbar quietly lying. `null` means
   *  "not resolved yet" (a repo switch) and reads the same as "show all". */
  private setCurrentBranches(branches: string[] | null) {
    this.currentBranches = branches;
    this.renderBranchFilterChip();
  }

  /** Redraw the toolbar's branch-filter chip from the current filter. */
  private renderBranchFilterChip() {
    const chip = document.getElementById("branchFilterChip");
    const text = document.getElementById("branchFilterText");
    if (chip === null || text === null) return;
    const label = branchFilterLabel(this.currentBranches ?? [], l10n.branchFilterTooltip);
    chip.classList.toggle("active", label !== null);
    text.textContent = label?.text ?? "";
    chip.title = label?.tooltip ?? "";
  }

  /** The name the toolbar and repo dropdown show for a repo: its custom name
   *  when one is set, else its folder name. */
  private repoDisplayName(repo: string): string {
    return this.gitRepos[repo]?.customName || repo.substring(repo.lastIndexOf("/") + 1);
  }

  /** Apply a change to VSCode's Source Control repo-selection mode: leaving
   *  multi-select takes the dropdown away, so an open list is stale. */
  public setScmMultiRepoSelection(enabled: boolean) {
    if (this.scmMultiRepoSelection === enabled) return;
    this.scmMultiRepoSelection = enabled;
    this.closeRepoDropdown();
    this.updateRepoTitle();
  }

  /** The repos the dropdown offers. Empty unless the Source Control view is in
   *  multi-select mode: in single-select mode that view is itself the repo
   *  switcher, and the graph's title is just a label for what it shows. Which
   *  repos are ticked there is not knowable — only the mode is. */
  private repoDropdownRepos(): string[] {
    return this.scmMultiRepoSelection ? Object.keys(this.gitRepos) : [];
  }

  /** Whether the title block is currently a dropdown trigger rather than a
   *  plain label — one repo to choose from is a label, not a choice. */
  private repoDropdownOnOffer(): boolean {
    return this.repoDropdownRepos().length > 1;
  }

  /** Refresh the toolbar's title block: the repo's display name (custom name,
   *  else its folder name), with the checked-out branch beside it. Where the
   *  dropdown is on offer the block becomes its select-style trigger (#16);
   *  otherwise it stays a plain label naming the repo on screen. */
  private updateRepoTitle() {
    const titleElem = document.getElementById("repoTitle");
    const nameElem = document.getElementById("repoTitleName");
    const branchElem = document.getElementById("repoTitleBranch");
    if (titleElem === null || nameElem === null || branchElem === null) return;
    const multipleRepos = this.repoDropdownOnOffer();
    titleElem.classList.toggle("multipleRepos", multipleRepos);
    titleElem.title = multipleRepos ? l10n.switchRepo : "";
    if (multipleRepos) {
      titleElem.setAttribute("role", "button");
      titleElem.setAttribute("aria-haspopup", "listbox");
      // Keyboard-reachable whenever it acts as a control, so the dropdown can
      // be opened without a mouse and closing can hand focus back to it.
      titleElem.tabIndex = 0;
      if (titleElem.getAttribute("aria-expanded") === null) {
        titleElem.setAttribute("aria-expanded", "false");
      }
    } else {
      titleElem.removeAttribute("role");
      titleElem.removeAttribute("aria-haspopup");
      titleElem.removeAttribute("aria-expanded");
      titleElem.removeAttribute("tabindex");
      // A repo may have vanished while the list was open (loadRepos).
      this.closeRepoDropdown();
    }
    // Falsy, not `undefined`: "none selected" arrives as the empty string when
    // the host had no live repo to offer ({@link loadRepos}), and as
    // `undefined` only in the moment before the first handshake. Tested for
    // `undefined` alone, the empty string walked past and left the *previous*
    // repo's branch name standing next to an empty repo name.
    const repo: string | undefined = this.currentRepo;
    if (!repo) {
      nameElem.textContent = "";
      branchElem.textContent = "";
      return;
    }
    const branch = this.gitBranchHead ?? "";
    nameElem.textContent = this.repoDisplayName(repo);
    // As a trigger the block owns the tooltip: a nested one here would win over
    // it across most of the control, hiding what the click does. The full path
    // is still a tooltip on each item of the open list.
    if (multipleRepos) nameElem.removeAttribute("title");
    else nameElem.title = repo;
    branchElem.textContent = branch;
    branchElem.title = branch;
  }

  /* The repo dropdown (#16): a select-style listbox of the workspace's repos,
   * from which the user switches the graph. Offered only when the Source
   * Control view is in multi-select mode and there is more than one repo —
   * otherwise the title is a plain label and clicks no-op. */

  private toggleRepoDropdown() {
    const list = document.getElementById("repoDropdownList");
    if (list === null) return;
    if (list.classList.contains("active")) {
      this.closeRepoDropdown(true);
    } else {
      this.openRepoDropdown();
    }
  }

  private openRepoDropdown() {
    const repoPaths = this.repoDropdownRepos();
    if (repoPaths.length < 2) return;
    const list = document.getElementById("repoDropdownList");
    const trigger = document.getElementById("repoTitle");
    if (list === null || trigger === null) return;
    // The click that opens this never reaches the document listener that would
    // dismiss a context menu, so retire one here rather than stacking popups.
    hideContextMenu();
    list.innerHTML = "";
    for (const repo of repoPaths) {
      const current = repo === this.currentRepo;
      const item = document.createElement("li");
      item.className = "repoDropdownItem" + (current ? " current" : "");
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(current));
      item.tabIndex = -1;
      // The item shows only the display name; the full path rides along as a
      // tooltip so same-named folders stay tellable apart.
      item.title = repo;
      item.textContent = this.repoDisplayName(repo);
      item.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.closeRepoDropdown(true);
        this.setRepo(repo);
      });
      list.appendChild(item);
    }
    list.classList.add("active");
    trigger.setAttribute("aria-expanded", "true");
    // Nothing is focused within the list yet: matching native selects, the
    // first arrow key is what moves onto an item.
    list.focus({ preventScroll: true });
  }

  private closeRepoDropdown(returnFocus: boolean = false) {
    const list = document.getElementById("repoDropdownList");
    const trigger = document.getElementById("repoTitle");
    if (list === null || !list.classList.contains("active")) return;
    const hadFocus = list.contains(document.activeElement) || document.activeElement === trigger;
    list.classList.remove("active");
    list.innerHTML = "";
    if (trigger !== null) {
      trigger.setAttribute("aria-expanded", "false");
      // The trigger keeps its tabindex (updateRepoTitle owns it), so focusing
      // it here sticks — dropping the attribute after focus() would blur it.
      if (returnFocus && hadFocus) trigger.focus({ preventScroll: true });
    }
  }

  private repoDropdownKeydown(e: KeyboardEvent) {
    const list = document.getElementById("repoDropdownList");
    if (list === null || !list.classList.contains("active")) return;
    const items = Array.from(list.querySelectorAll<HTMLElement>(".repoDropdownItem"));
    if (items.length === 0) return;
    const focused = items.indexOf(<HTMLElement>document.activeElement);
    let next: number | null = null;
    // No wrap-around: like a native select, the ends are hard stops.
    if (e.key === "ArrowDown") next = focused < 0 ? 0 : Math.min(focused + 1, items.length - 1);
    else if (e.key === "ArrowUp") next = focused < 0 ? items.length - 1 : Math.max(focused - 1, 0);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "Escape" || e.key === "Tab") {
      // Tab dismisses rather than walking out of the popup — the same rule the
      // context menu follows.
      this.closeRepoDropdown(true);
    } else if ((e.key === "Enter" || e.key === " ") && focused > -1) {
      items[focused].click();
    } else {
      return;
    }
    if (next !== null) {
      const target = items[next];
      target.focus({ preventScroll: true });
      // The list scrolls once it outgrows its max-height, so walk the viewport
      // along with the focus — otherwise arrowing past the fold moves focus to
      // an item nobody can see. (jsdom has no scrollIntoView.)
      if (typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "nearest" });
    }
    e.preventDefault();
    e.stopPropagation();
  }

  /** Apply a "Show Remote Branches" change driven by the Branches side-view's
   *  toggle, keeping the local per-repo copy in sync and reloading the graph. */
  public setShowRemoteBranches(value: boolean) {
    if (this.showRemoteBranches === value) return;
    this.showRemoteBranches = value;
    if (typeof this.gitRepos[this.currentRepo] !== "undefined") {
      this.gitRepos[this.currentRepo].showRemoteBranches = value;
    }
    this.shrinkLoadedCommitWindow();
    this.saveState();
    this.navigateReload();
  }

  /** Send a branch-deletion request, remembering its parameters so a failed
   *  non-force delete can offer a one-click force delete. */
  private sendDeleteBranch(
    repo: string,
    branchName: string,
    forceDelete: boolean,
    deleteOnRemotes: boolean
  ) {
    this.pendingDeleteBranch = { repo, branchName, deleteOnRemotes };
    sendMessage({
      command: "deleteBranch",
      repo,
      branchName,
      forceDelete,
      deleteOnRemotes
    });
  }

  /** Handle a deleteBranch response: if it failed only because the branch isn't
   *  fully merged, offer a force delete; otherwise refresh or show the error.
   *  `notFullyMerged` is classified by the host — `status` carries only git's
   *  primary error line, which does not say a force delete would work. */
  public handleDeleteBranchResponse(status: string | null, notFullyMerged: boolean) {
    const pending = this.pendingDeleteBranch;
    if (notFullyMerged && pending !== null) {
      // Bound at consent like every other confirmation ({@link confirmForRepo}),
      // only earlier: the repository this question is about is the one the
      // refused delete went to, and currentRepo has had the host's whole
      // round-trip to move since. So the pending record carries it.
      showConfirmationDialog(
        l10n.dialogForceDeleteBranchConfirm.replace(
          "{0}",
          "<b><i>" + escapeHtml(pending.branchName) + "</i></b>"
        ),
        () =>
          this.sendDeleteBranch(pending.repo, pending.branchName, true, pending.deleteOnRemotes),
        null
      );
    } else {
      refreshGraphOrDisplayError(status, l10n.unableToDeleteBranch);
    }
  }

  /** Switch the visible repo: driven by the toolbar's repo dropdown or by an
   *  extension-side message (e.g. user clicked a repo in the sidebar). */
  public setRepo(repo: string) {
    if (this.currentRepo === repo) return;
    if (typeof this.gitRepos[repo] === "undefined") return;
    this.currentRepo = repo;
    this.shrinkLoadedCommitWindow();
    this.clearExpandedCommit();
    this.setCurrentBranches(null);
    this.applyShowRemoteBranchesForRepo();
    this.updateRepoTitle();
    this.saveState();
    sendMessage({ command: "selectRepo", repo: this.currentRepo });
    this.navigateReload();
  }

  /* Loading Data */
  public loadRepos(repos: GG.GitRepoSet, lastActiveRepo: string | null) {
    // Captured before the incoming set replaces it. The comparison at the end
    // asks whether the state this panel has been loading under has moved, and
    // `this.gitRepos` stops being that state on the very next line.
    const previousState = this.gitRepos[this.currentRepo];
    this.gitRepos = repos;
    this.saveState();

    let changedRepo = false;
    if (typeof repos[this.currentRepo] === "undefined") {
      // `lastActiveRepo` is the host's seed, already resolved against the file
      // system — the webview no longer picks one itself. It used to fall back
      // to `repoPaths[0]`, and `repos` is persisted state that can still name
      // directories that are gone; the webview cannot tell, and the host can.
      // The old fallback selected a deleted repo whenever it sorted first, and
      // `<root>/.claude/worktrees/…` sorts ahead of every alphanumeric sibling
      // once the workspace root is not itself a repo. Selecting it threw in the
      // host, unhandled, with the spinner never cleared.
      //
      // Empty string when the host has no live repo to offer — and *only*
      // then, which is why `pickBootRepo` requires the seed to be a member of
      // this very set. Without that, a seed that had merely stayed on disk
      // after leaving the set landed the panel here with live repos sitting in
      // `repos`: blank title, no graph, and no way back short of closing the
      // tab. The empty string says "none selected" and nothing else — the
      // guards that must read it that way are in {@link updateRepoTitle} and
      // {@link requestLoadBranchesAndCommits}, both of which take a falsy repo
      // as an answer rather than as a path.
      this.currentRepo =
        lastActiveRepo !== null && typeof repos[lastActiveRepo] !== "undefined"
          ? lastActiveRepo
          : "";
      this.saveState();
      changedRepo = true;
    }

    if (changedRepo) {
      this.applyShowRemoteBranchesForRepo();
      // The repo moved without anyone navigating to it — it vanished from the
      // set — so this reload cannot be dropped either. It is the one navigation
      // that does not also reset the panel around the switch (no shrunken
      // window, no cleared filter, no closed details): the three that do are
      // acting on a repo the user chose, and can say what the new repo starts
      // from; this one is landing somewhere by elimination.
      this.navigateReload();
      // Landing nowhere, in fact — the host had no live repository to offer.
      // {@link navigateReload} still runs: the loads out belong to the repo
      // that vanished and have to be abandoned. What it does not do is send
      // anything, so nothing is coming to replace the graph on screen. See
      // {@link renderNoRepo} for why that has to be said rather than left.
      if (!this.currentRepo) this.renderNoRepo();
    } else if (this.commitScopeChanged(previousState, repos[this.currentRepo])) {
      // Same repository, different question — the fifth navigation, and the
      // only one that arrives as a fact rather than as a call. Hiding a remote
      // becomes `--exclude=<remote>/*` on the `git log`, so the commits on
      // screen stop being the ones that belong there; but the command that
      // does it (`toggleRemoteVisibility`) only writes the repo state and asks
      // for a plain refresh, and a plain refresh is droppable. Recognising the
      // change in the state that arrives is what makes it a navigation without
      // the host having to say so — and it is why this is a comparison rather
      // than a fifth kind of message: the next field that steers the query is
      // covered the day it is named in {@link commitScopeChanged}, by whoever
      // adds it.
      //
      // The loaded commit window is left where the user put it — by *this
      // route*, whichever field moved, and not by the navigation's identity
      // (ADR-0024). The commit ordering shrinks it when the panel's own menu
      // changes it and does not when it arrives here already decided, and that
      // is deliberate rather than an oversight: the reason is the route, not
      // the field. This path fires for changes made outside this panel (the
      // shareable config file, a second graph panel), where collapsing a
      // widened graph would be a loss the user cannot account for and can only
      // undo one Load More at a time — and "navigate, do not shrink" is the
      // only safe default for a generalisation, because the alternative hands
      // every field added to {@link commitScopeChanged} a destructive side
      // effect nobody chose for it. Hiding a remote is not a new repository or
      // a longer read either, so it has no cost argument to answer.
      this.navigateReload();
    }
    // Unconditional: a repo's customName may have changed without a repo switch.
    this.updateRepoTitle();
  }

  /** Whether a repo's state moved in a way that changes *which* commits a
   *  `loadCommits` request brings back. Compared field by field and normalised
   *  the way {@link requestLoadCommits} reads them, so a difference here is
   *  exactly a difference in the request that would go out; the graph never
   *  reloads over a field the host would have ignored anyway.
   *
   *  `before` is undefined when the panel held no state for this repo yet — a
   *  boot, or a repo that has just appeared. There is nothing to have moved
   *  away from then, and whatever arrived is what the opening load is already
   *  asking with, so it is not a change.
   *
   *  Only the fields the request carries. `showRemoteBranches` steers the same
   *  query, but the host resolves it from the repo's own state and it never
   *  rides on the request (ADR-0013); catching it here would also mean
   *  re-syncing the copy the side-view's toggle draws itself from, which is a
   *  different fix from this one. */
  private commitScopeChanged(
    before: GG.GitRepoState | undefined,
    after: GG.GitRepoState | undefined
  ): boolean {
    if (before === undefined || after === undefined) return false;
    // A missing `commitOrdering` and an explicit null both mean "use the global
    // setting", which is the `?? undefined` the request sends.
    if ((before.commitOrdering ?? null) !== (after.commitOrdering ?? null)) return true;
    // Sorted, because these names become `--exclude` arguments and `git log`
    // does not care what order they arrive in. The one writer that can reorder
    // them without adding or removing any is the shareable config file, which
    // a user edits by hand; reloading the graph over a reordered line would be
    // work nobody asked for.
    const hiddenBefore = (before.hiddenRemotes ?? []).toSorted();
    const hiddenAfter = (after.hiddenRemotes ?? []).toSorted();
    return !arraysEqual(hiddenBefore, hiddenAfter, (a, b) => a === b);
  }

  /** Reload commits after the branch selection changed: reset paging, close any
   *  open details, show the loading state, and request the new commit set.
   *
   *  A filter change is a navigation, so the request must go out — none of the
   *  state reset below survives a dropped one: the loaded commit window would
   *  sit silently back at the opening count, the search index would be gone and
   *  the busy indicator would spin, for a graph that never reloaded (ADR-0019).
   *  It used to refuse the whole thing when a load was already out, which left
   *  the graph showing commits from a filter the user had replaced (#84).
   *
   *  The branch half is abandoned along with the commit half, and it is the
   *  half worth naming: its answer carries the filter the host resolved
   *  *before* this change, and applying it would push the old selection back
   *  over the new one. The branch list itself has not moved — a filter decides
   *  which branches are drawn, not which exist — so nothing is lost by letting
   *  that read go. */
  private reloadForBranchChange() {
    // No repository, no reload. This one does not go through
    // {@link requestLoadBranchesAndCommits}, so it needs the guard of its own —
    // without it the filter push arrived, the reset below ran, and a
    // `loadCommits` went out naming a repository that is the empty string.
    if (!this.currentRepo) return;
    this.abandonLoadsInFlight();
    this.shrinkLoadedCommitWindow();
    this.clearExpandedCommit();
    this.saveState();
    // Keep the current graph on screen and show the busy indicator while the new
    // commits load, rather than blanking to a loading screen (which flickers on
    // every branch toggle/switch). render() replaces the table atomically.
    this.beginBusyLoad();
    this.requestLoadCommits(true, () => this.endBusyLoad());
  }

  public loadBranches(
    branchOptions: string[],
    branchHead: string | null,
    hard: boolean,
    isRepo: boolean,
    filter: string[],
    dimmedBranches: string[] = [],
    cleanupCandidates: string[] = []
  ) {
    if (!isRepo) {
      this.triggerLoadBranchesCallback(false, isRepo);
      return;
    }
    // Not part of the change comparison below, and not saved with the view
    // state: it decides nothing that is drawn, only whether a context-menu item
    // is offered, so a stale set has nothing to flash and self-corrects on the
    // next load.
    this.cleanupCandidateRefs = new Set(cleanupCandidates.map(displayRef));
    const dimmedUnchanged = arraysEqual(this.dimmedBranches, dimmedBranches, (a, b) => a === b);
    const branchesUnchanged =
      arraysEqual(this.gitBranches, branchOptions, (a, b) => a === b) &&
      this.gitBranchHead === branchHead;
    const filterUnchanged = arraysEqual(this.currentBranches ?? [], filter, (a, b) => a === b);
    if (!hard && branchesUnchanged && filterUnchanged && dimmedUnchanged) {
      this.triggerLoadBranchesCallback(false, isRepo);
      return;
    }

    this.gitBranches = branchOptions;
    this.gitBranchHead = branchHead;
    this.setDimmedBranches(dimmedBranches);
    this.updateRepoTitle();
    // The branch filter is owned by the extension host (the Branches side-view);
    // apply whatever it resolved for this repo. An empty list means "show all".
    this.setCurrentBranches(filter);
    this.saveState();

    this.triggerLoadBranchesCallback(true, isRepo);
  }

  /** Store the dimmed-branch set, normalising the host's `remotes/origin/x` to
   *  the `origin/x` form the graph's ref chips carry. Without this the remote
   *  chips would silently never match and never dim. */
  private setDimmedBranches(dimmedBranches: string[]) {
    this.dimmedBranches = dimmedBranches;
    this.dimmedRefs = new Set(dimmedBranches.map(displayRef));
  }

  /** Apply a branch filter pushed from the extension host — a selection change
   *  in the Branches side-view, or its "Show All" action. An empty list means
   *  show all. Deduped against the current filter to avoid a redundant reload. */
  public setBranchFilter(branches: string[]) {
    if (arraysEqual(this.currentBranches ?? [], branches, (a, b) => a === b)) return;
    // No guard ahead of this one, deliberately. Unlike the webview's own
    // gestures, this is a fire-and-forget push from the host with no follow-up
    // and no retry: refusing it would leave the side-view showing a filter the
    // graph has never heard of, and nothing would ever correct that. Neither
    // half can be dropped now — the reload abandons whatever is out rather than
    // standing down for it (#84).
    this.setCurrentBranches(branches);
    this.reloadForBranchChange();
  }
  private triggerLoadBranchesCallback(changes: boolean, isRepo: boolean) {
    if (this.loadBranchesCallback !== null) {
      this.loadBranchesCallback(changes, isRepo);
      this.loadBranchesCallback = null;
    }
  }

  public loadCommits(
    commits: GitCommitNode[],
    commitHead: string | null,
    moreAvailable: boolean,
    hard: boolean
  ) {
    // Spent here, at the top: this load owns the permission, and it owns it
    // whichever way the function leaves — including the short-circuit below and
    // the throw the try/finally further down exists to survive. Reading it any
    // later would leave it set for a redraw that has nothing to do with it.
    const focusMayScroll = this.pendingFocusScroll;
    this.pendingFocusScroll = false;
    if (
      !hard &&
      this.moreCommitsAvailable === moreAvailable &&
      this.commitHead === commitHead &&
      arraysEqual(
        this.commits,
        commits,
        (a, b) =>
          a.hash === b.hash &&
          arraysEqual(a.refs, b.refs, (ra, rb) => ra.name === rb.name && ra.type === rb.type) &&
          arraysEqual(a.parentHashes, b.parentHashes, (pa, pb) => pa === pb)
      )
    ) {
      if (this.commits.length > 0 && this.commits[0].hash === "*") {
        this.commits[0] = commits[0];
        this.saveState();
        this.renderUncommitedChanges();
      }
      if (this.findActive) this.requestBranchSearchIndex();
      this.triggerLoadCommitsCallback(false);
      return;
    }

    this.moreCommitsAvailable = moreAvailable;
    this.commits = commits;
    this.commitHead = commitHead;
    if (this.commits.length > 0 && this.commits[0].hash === "*") {
      const match = this.commits[0].message.match(/\((\d+)\)$/);
      const count = match ? match[1] : "?";
      this.commits[0].message = l10n.uncommittedChanges.replace("{0}", count);
    }
    this.commitLookup = {};
    this.saveState();

    let i: number,
      expandedCommitVisible = false,
      avatarsNeeded: { [email: string]: string[] } = {};
    for (i = 0; i < this.commits.length; i++) {
      this.commitLookup[this.commits[i].hash] = i;
      if (this.expandedCommit !== null && this.expandedCommit.hash === this.commits[i].hash)
        expandedCommitVisible = true;
      if (
        this.config.fetchAvatars &&
        typeof this.avatars[this.commits[i].email] !== "string" &&
        this.commits[i].email !== ""
      ) {
        if (typeof avatarsNeeded[this.commits[i].email] === "undefined") {
          avatarsNeeded[this.commits[i].email] = [this.commits[i].hash];
        } else {
          avatarsNeeded[this.commits[i].email].push(this.commits[i].hash);
        }
      }
    }

    // Building the graph layout and rendering the table must never leave the
    // refresh callback unfired: if anything in here throws, loadCommitsCallback
    // would stay set and every later refresh/commit would be silently dropped
    // (the busy indicator never clears), freezing the view until the tab is
    // reopened. The finally guarantees the callback always runs.
    try {
      this.graph.loadCommits(this.commits, this.commitHead, this.commitLookup);

      if (this.expandedCommit !== null && !expandedCommitVisible) {
        this.clearExpandedCommit();
        this.saveState();
      }
      this.render(focusMayScroll);

      if (this.findActive) {
        this.refreshFind("redraw", this.pendingFindTargetHash);
        this.pendingFindTargetHash = null;
        this.requestBranchSearchIndex();
      }

      // Restore the pre-refresh scroll offset now the table has its full height
      // back; this takes precedence over the one-time scroll-to-head.
      if (this.pendingScrollRestore !== null) {
        window.scrollTo(0, this.pendingScrollRestore);
        this.pendingScrollRestore = null;
      } else if (
        // Scroll to HEAD once after the first load that contains it, if configured.
        this.config.onLoadScrollToHead &&
        !this.hasScrolledToHeadOnLoad &&
        this.commitHead !== null &&
        this.commitLookup[this.commitHead] !== undefined
      ) {
        this.hasScrolledToHeadOnLoad = true;
        this.scrollToHead(false);
      }

      this.fetchAvatars(avatarsNeeded);
    } finally {
      this.triggerLoadCommitsCallback(true);
    }
  }
  private triggerLoadCommitsCallback(changes: boolean) {
    if (this.loadCommitsCallback !== null) {
      this.loadCommitsCallback(changes);
      this.loadCommitsCallback = null;
    }
    // A side-view-delegated action may have been waiting for this load.
    this.tryRunPendingRefAction();
  }

  public loadAvatar(email: string, image: string) {
    this.avatars[email] = image;
    this.saveState();
    let avatarsElems = <HTMLCollectionOf<HTMLElement>>document.getElementsByClassName("avatar"),
      escapedEmail = escapeHtml(email);
    for (let i = 0; i < avatarsElems.length; i++) {
      if (avatarsElems[i].dataset.email === escapedEmail) {
        avatarsElems[i].innerHTML = '<img class="avatarImg" src="' + image + '">';
      }
    }
  }

  /* Refresh */
  public refresh(hard: boolean, preserveScroll: boolean = false) {
    if (hard) {
      // Keep the current graph on screen while reloading (the busy indicator is
      // shown by requestLoadBranchesAndCommits, and render() swaps the table
      // atomically) rather than blanking to a loading screen, which flickers.
      // preserveScroll keeps the scroll offset; repo/branch changes pass false.
      this.pendingScrollRestore = preserveScroll ? window.scrollY : null;
      if (this.expandedCommit !== null) {
        this.clearExpandedCommit();
        this.saveState();
      }
    }
    this.requestLoadBranchesAndCommits(hard);
  }

  /** Whether an answer stamped with `token` is still wanted — i.e. whether it
   *  belongs to the navigation the panel is on, rather than to one abandoned
   *  under it ({@link abandonLoadsInFlight}). Asked at the wire, which is the
   *  only place a token arrives from outside. */
  public isCurrentNavigation(token: number): boolean {
    return token === this.loadToken;
  }

  /** Reload because the user changed *which* commits belong on screen — the
   *  repository, whether remote branches count, the branch filter.
   *
   *  A navigation cannot be dropped, which is what separates it from
   *  {@link refresh}. A refresh that loses its race has nothing to correct:
   *  the load it was dropped onto is asking the same question and its answer
   *  will be right. A navigation dropped onto that same load is left with the
   *  *previous* repo's graph under the new repo's title, and nothing is coming
   *  to fix it — the load in flight has never heard of the repo the user is now
   *  looking at, and the panel's own gate refuses every later attempt to ask.
   *  That is the freeze that only closing the tab could clear (#84): a worktree
   *  switch mid-load, then a graph that never reloads again.
   *
   *  So the loads out are abandoned rather than waited for. Their answers still
   *  arrive — nothing here can stop a git read already running — and are
   *  dropped on the doorstep by {@link loadToken}. */
  private navigateReload() {
    this.abandonLoadsInFlight();
    this.refresh(true);
  }

  /** Give up on the loads in flight, so the next request is not refused by the
   *  panel's one-load-at-a-time gate (ADR-0019).
   *
   *  The two halves are given up differently, and the asymmetry is the whole
   *  of this function.
   *
   *  The commit half's callback is **run**, with no changes to report — the
   *  same "a load that never ran brought no changes with it" this file already
   *  uses for a dropped request. Running it is what settles the busy ledger
   *  without anyone tracking it: a callback releases exactly the claim its own
   *  caller raised, and the callers that raise none pass one that does nothing
   *  ({@link beginBusyLoad}). It also discharges what that reload owed the
   *  action behind it — the progress dialog it was going to dismiss is
   *  dismissed now rather than waiting on a load the user has walked away from.
   *
   *  The branch half's callback is **dropped**, because running it would send
   *  the commit request for the repo the user just left: its tail is the other
   *  half of the load, not a close-out. Dropping it means taking over what it
   *  owed, and it owes two things, not one. The busy claim is the obvious one —
   *  the only caller that asks for branches always raises one. The other is the
   *  dismissal: the close-out the branch callback would have built is where
   *  {@link hideReloadOwnedOverlays} is called from, and nothing else builds
   *  one, so dropping the callback silently dropped that too. A checkout's
   *  progress dialog then sat on screen with Escape as its only exit, while the
   *  graph reloaded correctly underneath it and the indicator went out.
   *
   *  Unconditionally, and not only for an abandoned *hard* reload. The
   *  close-out's rule is "hard, or something changed", and the tempting reading
   *  is that a soft reload's dismissal was never owed — but the rule belongs to
   *  the load that finishes, and here that is the navigation's own reload,
   *  which is always hard (both callers reload with `hard: true`). The soft
   *  case is not hypothetical either: the host's `refresh` push is soft, and it
   *  is sent by the auto-fetch timer, the Fetch command, a remote change and an
   *  error dialog's dismissal — none of them muted while a progress dialog
   *  stands. Testing `hard` left exactly that case stranded.
   *
   *  This dismissal can reach a dialog the reload does not own — the existence
   *  check in {@link hideReloadOwnedOverlays} cannot tell them apart, which is
   *  tracked on #127 and predates this — and through {@link reloadForBranchChange}
   *  that is a way in the panel did not have before: a filter pushed from the
   *  side-view can now take down a Branch Cleanup deep scan (its dismissal hook
   *  sends `branchCleanupScanCancel`) or a "Check for Unmerged Changes" whose
   *  answer is then dropped on arrival. It is the same trade #127 already
   *  names, made once more: a dialog that closes early beats one that never
   *  closes at all, and both end when the dialog is correlated with the reload
   *  that owns it.
   *
   *  Deliberately not routed through {@link triggerLoadCommitsCallback}: that
   *  one also retries a delegated ref action, and here the gate is about to be
   *  taken again by the navigation's own load, so the action must go on waiting.
   *
   *  Bumping the token here rather than in {@link navigateReload} keeps the two
   *  halves of the same fact together: the loads are abandoned, and the token
   *  is how their answers are recognised as abandoned when they land. */
  private abandonLoadsInFlight() {
    this.loadToken++;
    if (this.branchLoadInFlight) {
      this.loadBranchesCallback = null;
      this.endBusyLoad();
      hideReloadOwnedOverlays();
    }
    if (this.commitLoadInFlight) {
      const abandoned = this.loadCommitsCallback!;
      this.loadCommitsCallback = null;
      abandoned(false);
    }
  }

  /** How many loads are currently claiming the busy indicator on the Refresh
   *  button.
   *
   *  Counted rather than set, because the indicator is one class on one button
   *  and three separate things raise it: a refresh, a branch-change reload, and
   *  a Find step that has to page. ADR-0019's "at most one commit load in
   *  flight" is what makes the overlap easy to miss — it holds, and it is not
   *  the whole story. A refresh's branch half is out well before its commit
   *  half exists, so a second refresh starting in that window is a second live
   *  refresh; and a refresh whose own commit request is dropped runs its
   *  close-out immediately, while the load it was dropped onto is still going.
   *
   *  Set rather than counted, it let whichever load ended first answer "idle"
   *  on behalf of one that was still running. The wrong answer was corrected by
   *  the real load landing, which is why it read as a flicker rather than as a
   *  lie — but the indicator is the only thing on screen that says a load is
   *  under way, and one number costs less than a rule every caller has to
   *  remember. */
  private busyLoads = 0;

  /** Claim the busy indicator for a load that is starting.
   *
   *  Pairs with exactly one {@link endBusyLoad} on every path that load can end
   *  on — including the paths where the request was dropped and no load ever
   *  happened. That pairing is the whole invariant: a claim that is never
   *  dropped leaves the button spinning for the life of the panel, and one
   *  dropped twice takes another load's claim with it. */
  private beginBusyLoad() {
    this.busyLoads++;
    this.updateBusyIndicator();
  }

  /** Drop this load's claim. The indicator goes out with the last claim only —
   *  a load that ends while another is still out has finished, but the panel
   *  has not. */
  private endBusyLoad() {
    this.busyLoads--;
    this.updateBusyIndicator();
  }

  /** Repaint the indicator from the count. The one place the class is written. */
  private updateBusyIndicator() {
    document.getElementById("refreshBtn")?.classList.toggle("refreshing", this.busyLoads > 0);
  }

  /* Requests */
  /** Whether a branch load is in flight — the branch-side twin of
   *  {@link commitLoadInFlight}, and likewise the answer to "would a request
   *  sent now be dropped?". */
  private get branchLoadInFlight(): boolean {
    return this.loadBranchesCallback !== null;
  }
  /** Request the branch list, reporting whether it was actually sent. Dropped
   *  while {@link branchLoadInFlight}, on the same terms as
   *  {@link requestLoadCommits}: nothing is sent and `loadedCallback` never
   *  runs. */
  private requestLoadBranches(
    hard: boolean,
    loadedCallback: (changes: boolean, isRepo: boolean) => void
  ): boolean {
    if (this.branchLoadInFlight) return false;
    this.loadBranchesCallback = loadedCallback;
    sendMessage({ command: "selectRepo", repo: this.currentRepo });
    sendMessage({ command: "loadRemotes" });
    // No showRemoteBranches: the host resolves the repo's own state, which is
    // what this copy echoes anyway (ADR-0013).
    sendMessage({ command: "loadBranches", hard: hard, token: this.loadToken });
    return true;
  }
  public loadRemotes(remotes: string[], pushDefault: string | null) {
    const changed = !arraysEqual(this.remotes, remotes, (a, b) => a === b);
    this.remotes = remotes;
    this.pushDefault = pushDefault;
    // Branch labels are laid out using the remote names (to fold a remote into
    // its matching local head), so commits rendered with stale remotes need a
    // re-render. loadCommits won't do it: an unchanged commit list short-circuits.
    if (changed && this.commits.length > 0) {
      this.saveState();
      this.render();
    }
  }
  /** Render (or clear) the conflict-resolution banner for an in-progress
   *  operation. Handlers close over `conflictedFiles`, so a `data-index`
   *  (never the path) is all that goes into the markup. */
  public showConflictBanner(operation: GitOperation | null, conflictedFiles: string[]) {
    const banner = document.getElementById("conflictBanner");
    if (banner === null) return;
    if (operation === null) {
      banner.className = "";
      banner.innerHTML = "";
      return;
    }
    const opLabel = {
      merge: l10n.conflictOpMerge,
      rebase: l10n.conflictOpRebase,
      cherrypick: l10n.conflictOpCherryPick,
      revert: l10n.conflictOpRevert
    }[operation];
    const hasConflicts = conflictedFiles.length > 0;
    let html =
      '<div class="conflictBannerHeader"><span class="conflictBannerTitle">' +
      escapeHtml(l10n.conflictBannerTitle.replace("{0}", opLabel)) +
      '</span><span class="conflictBannerButtons">' +
      '<div id="conflictContinue" class="roundedBtn' +
      (hasConflicts ? " disabled" : "") +
      '">' +
      escapeHtml(l10n.conflictContinue) +
      '</div><div id="conflictAbort" class="roundedBtn">' +
      escapeHtml(l10n.conflictAbort) +
      "</div></span></div>";
    if (hasConflicts) {
      html +=
        '<ul class="conflictBannerList">' +
        conflictedFiles
          .map(
            (f, i) =>
              '<li><span class="conflictFile" data-index="' +
              i +
              '" title="' +
              escapeHtml(l10n.conflictOpenInMergeEditor) +
              '">' +
              escapeHtml(f) +
              '</span><span class="conflictResolveBtn" data-index="' +
              i +
              '">' +
              escapeHtml(l10n.conflictMarkResolved) +
              "</span></li>"
          )
          .join("") +
        "</ul>";
    } else {
      html +=
        '<div class="conflictBannerAllResolved">' + escapeHtml(l10n.conflictAllResolved) + "</div>";
    }
    banner.className = "active";
    banner.innerHTML = html;

    // innerHTML wiped any previous listeners; (re)attach.
    const repo = this.currentRepo!;
    if (!hasConflicts) {
      document
        .getElementById("conflictContinue")
        ?.addEventListener("click", () => sendMessage({ command: "continueOperation", repo }));
    }
    document
      .getElementById("conflictAbort")
      ?.addEventListener("click", () => sendMessage({ command: "abortOperation", repo }));
    banner.querySelectorAll(".conflictFile").forEach((el) => {
      el.addEventListener("click", () => {
        const i = parseInt((el as HTMLElement).dataset.index!);
        sendMessage({ command: "openMergeEditor", repo, filePath: conflictedFiles[i] });
      });
    });
    banner.querySelectorAll(".conflictResolveBtn").forEach((el) => {
      el.addEventListener("click", () => {
        const i = parseInt((el as HTMLElement).dataset.index!);
        sendMessage({ command: "markResolved", repo, filePath: conflictedFiles[i] });
      });
    });
  }
  /** Whether a commit load is in flight. At most one ever is: ADR-0019 declined
   *  queueing the extra one, because delegated ref actions schedule themselves
   *  off that single fact. It is therefore also the answer to "would a request
   *  sent now be dropped?", which is how every caller that must not act on a
   *  dropped request decides whether to act at all.
   *
   *  Every caller *that can be dropped*, which is no longer all of them: a
   *  navigation abandons the load in flight rather than standing down for it
   *  (ADR-0024), so it reads false by the time it asks. The invariant is
   *  untouched — the abandonment comes first, so one is still the most that is
   *  ever out. */
  private get commitLoadInFlight(): boolean {
    return this.loadCommitsCallback !== null;
  }
  /** Request a page of commits, reporting whether it was actually sent. A
   *  request arriving while {@link commitLoadInFlight} is dropped: nothing is
   *  sent and `loadedCallback` never runs.
   *
   *  Callers whose request carries state they must mutate first (the loaded
   *  commit window, a persisted preference) cannot act on the return value —
   *  by then the state would already be wrong — so they check
   *  {@link commitLoadInFlight} up front instead. The return value is for the
   *  one caller that requests from inside a callback and so has nowhere
   *  earlier to stand: {@link requestLoadBranchesAndCommits}. */
  private requestLoadCommits(hard: boolean, loadedCallback: (changes: boolean) => void): boolean {
    if (this.commitLoadInFlight) return false;
    this.loadCommitsCallback = loadedCallback;
    sendMessage({
      command: "loadCommits",
      repo: this.currentRepo!,
      branchNames: this.currentBranches !== null ? this.currentBranches : [""],
      maxCommits: this.maxCommits,
      hard: hard,
      token: this.loadToken,
      commitOrder: this.gitRepos[this.currentRepo!]?.commitOrdering ?? undefined,
      hiddenRemotes: this.gitRepos[this.currentRepo!]?.hiddenRemotes ?? undefined
    });
    return true;
  }
  private requestLoadBranchesAndCommits(hard: boolean) {
    // No repository, so no load — the panel is not waiting on anything and
    // nothing that came back could be about it. Ahead of the busy claim
    // deliberately: a load that was never started has no claim to drop, and the
    // indicator would otherwise spin for a panel with nothing in flight.
    //
    // `currentRepo` is falsy exactly when the host offered no live repository
    // ({@link loadRepos}), plus the moment before the first handshake lands.
    // Sending regardless is what put `selectRepo` with an empty path on the
    // wire, and simple-git reads an empty `baseDir` as absent and falls back to
    // the extension host's own working directory — so the panel could end up
    // drawing an unrelated repository. The host refuses that path too; this is
    // the near side of the same refusal, and it is the one that also keeps the
    // ledger straight.
    //
    // The dismissal is the same debt {@link abandonLoadsInFlight} settles, and
    // for the same reason: the close-out that takes down an action's progress
    // dialog is built inside the branch callback, and a load that never goes
    // out has no callback. Every action closes out through
    // `refreshGraphOrDisplayError`, which is a hard refresh — so without this,
    // an action dispatched from a graph the panel has since lost its repository
    // for completes and leaves its dialog standing.
    if (!this.currentRepo) {
      if (hard) hideReloadOwnedOverlays();
      return;
    }
    this.beginBusyLoad();
    // Refresh the conflict banner alongside every (re)load so it tracks the
    // repo's operation state (.git changes trigger a refresh via the watcher).
    sendMessage({ command: "operationState", repo: this.currentRepo });
    const branchesSent = this.requestLoadBranches(
      hard,
      (branchChanges: boolean, isRepo: boolean) => {
        if (isRepo) {
          const finish = (commitChanges: boolean) => {
            this.endBusyLoad();
            // Dismiss what this reload owns once it finishes — see
            // {@link hideReloadOwnedOverlays} for why that is the progress
            // dialog and the context menu but not a confirmation. Hard
            // refreshes follow an action (checkout, merge, …) so always close;
            // soft refreshes only close when something changed.
            //
            // Not held back when this refresh's own request was dropped, unlike
            // the claim above, and the two part company on what is left to do
            // rather than on how loud to be. The claim reports this panel's
            // state, and a load is still running, so it goes back to being the
            // other refresh's to drop. The dismissal discharges a debt to an
            // action that has already finished — and there is no one to hand it
            // to: the refresh still out may be a soft one that finds nothing
            // changed, and it would then close nothing. Deferring it is how the
            // action-running dialog came to sit there with Escape as its only
            // exit.
            if (hard || branchChanges || commitChanges) {
              hideReloadOwnedOverlays();
            }
          };
          // A load that never ran brought no changes with it, so finish it as
          // one. Letting the dropped request take the callback with it left the
          // Refresh button spinning until the panel was reopened.
          if (!this.requestLoadCommits(hard, finish)) finish(false);
        } else {
          this.endBusyLoad();
          sendMessage({ command: "loadRepos", check: true });
        }
      }
    );
    // The same asymmetry one level out: a dropped branches request takes the
    // whole reload with it, callback included, so this refresh has to drop its
    // own claim. Only its own — the request was dropped onto another refresh's
    // branch load (nothing else asks for one), so that refresh is still out and
    // the indicator is still telling the truth.
    if (!branchesSent) this.endBusyLoad();
  }
  private fetchAvatars(avatars: { [email: string]: string[] }) {
    let emails = Object.keys(avatars);
    for (let i = 0; i < emails.length; i++) {
      sendMessage({
        command: "fetchAvatar",
        repo: this.currentRepo!,
        email: emails[i],
        commits: avatars[emails[i]]
      });
    }
  }

  /* State */
  private saveState() {
    vscode.setState({
      gitRepos: this.gitRepos,
      gitBranches: this.gitBranches,
      gitBranchHead: this.gitBranchHead,
      dimmedBranches: this.dimmedBranches,
      remotes: this.remotes,
      pushDefault: this.pushDefault,
      commits: this.commits,
      commitHead: this.commitHead,
      avatars: this.avatars,
      currentBranches: this.currentBranches,
      currentRepo: this.currentRepo,
      moreCommitsAvailable: this.moreCommitsAvailable,
      maxCommits: this.maxCommits,
      showRemoteBranches: this.showRemoteBranches,
      expandedCommit: serializeExpandedCommit(this.expandedCommit),
      columnVisibility: this.columnVisibility,
      alwaysAcceptCheckoutCommit: this.alwaysAcceptCheckoutCommit
    });
  }

  /* Renderers */
  /** `focusMayScroll` is passed rather than read from the instance so that it
   *  describes *this* redraw: every other caller redraws without it, which is
   *  the default and the rule (ADR-0019 — a redraw is not a move). */
  /** Draws the table, then the graph, then the one write `renderTable` handed
   *  back instead of doing itself.
   *
   *  Running that write last is the point of handing it back. Layout is
   *  computed lazily: a write dirties it and the next read of a geometric
   *  property computes all of it. Done where it was measured, this write sat
   *  between that measurement and the heights `renderGraph` derives `grid.y`
   *  from, so the redraw stopped a second time for a full layout of the table.
   *
   *  It does not make that layout go away, and this does not claim it does: the
   *  write still dirties the table and the browser still lays it out before it
   *  paints. What changes is who waits for it — the browser's own rendering
   *  step rather than this task. Re-measured on the shipped bundle at 3000
   *  rows, `reusedDense`, Chromium 148, median of 9: the two forced layouts
   *  were 245.5ms and 77.3ms and are now 251.0ms and 0.00ms; the redraw's task
   *  fell from 508ms to 413ms; and settling the page afterwards, which the
   *  browser does either way, rose from 25.0ms to 100.5ms — the same work, on
   *  the other side of the return. (`docs/perf/2026-08-webview-large-window.md`
   *  put the same two layouts at 237.9ms and 80.7ms using a stand-in for
   *  `renderTable`. These are a fresh run against the real one, not those.)
   *
   *  The `finally` covers `renderGraph` only. A throw inside `renderTable`
   *  loses the write with it, and nothing here can reach that — which is the
   *  one thing handing it back costs. It costs little: the window it leaves
   *  open spans the rest of `renderTable`, listener registration included, so
   *  a throw in there already means the rows have no click or context menu.
   *  A missing column padding is the smallest loss in that pile. */
  private render(focusMayScroll: boolean = false) {
    const applyGraphColumnWidth = this.renderTable(focusMayScroll);
    try {
      this.renderGraph();
    } finally {
      applyGraphColumnWidth();
    }
  }
  /**
   * Set of commit hashes reachable from HEAD by following parent links (HEAD
   * included), restricted to the commits currently loaded. Used to mute commits
   * that are not ancestors of HEAD.
   */
  private parentsOf(hash: string): string[] | undefined {
    const idx = this.commitLookup[hash];
    return idx === undefined ? undefined : this.commits[idx].parentHashes;
  }
  private ancestorsOfHead(): Set<string> {
    if (this.commitHead === null || this.commitLookup[this.commitHead] === undefined) {
      return new Set();
    }
    return commitsReachableFrom([this.commitHead], (h) => this.parentsOf(h));
  }
  /** Whether the commit referenced by tag `tagName` is reachable from any loaded
   *  remote branch. Returns true (no warning) when it can't be determined. */
  private tagCommitOnRemote(tagName: string): boolean {
    const tagCommit = this.commits.find((c) =>
      c.refs.some((r) => r.type === "tag" && r.name === tagName)
    )?.hash;
    if (tagCommit === undefined) return true;
    const remoteTips = this.commits
      .filter((c) => c.refs.some((r) => r.type === "remote"))
      .map((c) => c.hash);
    if (remoteTips.length === 0) return true;
    return commitsReachableFrom(remoteTips, (h) => this.parentsOf(h)).has(tagCommit);
  }
  private renderGraph() {
    let colHeadersElem = document.getElementById("tableColHeaders");
    if (colHeadersElem === null) return;
    // A docked Commit Details View floats over the bottom of the window, so it
    // doesn't push the graph down — treat it as having no inline expansion.
    const inlineExpanded = this.isCdvDocked() ? null : this.expandedCommit;
    let headerHeight = colHeadersElem.clientHeight + 1,
      expandedCommitElem =
        inlineExpanded !== null ? document.getElementById("commitDetails") : null;
    this.config.grid.expandY =
      expandedCommitElem !== null
        ? expandedCommitElem.getBoundingClientRect().height
        : this.config.grid.expandY;
    this.config.grid.y =
      this.commits.length > 0
        ? (this.tableElem.children[0].clientHeight -
            headerHeight -
            (inlineExpanded !== null ? this.config.grid.expandY : 0)) /
          this.commits.length
        : this.config.grid.y;
    this.config.grid.offsetY = headerHeight + this.config.grid.y / 2;
    this.graph.render(inlineExpanded);
  }

  /** Bind `event` on every element under `root` carrying `className`. The one
   *  implementation behind both scoped families — {@link addGraphListenerToClass}
   *  for the graph's table, {@link addCdvListenerToClass} for the Commit Details
   *  View — which exist to name a root, not to bind differently.
   *
   *  **`root` is required, and that is the whole of the difference from
   *  `addListenerToClass`.** The exported helper keeps its signature on purpose,
   *  and the argument for that (in `utils/dom.ts`) is narrower than it first
   *  reads: a root parameter *there* would have to default to `document`,
   *  because nothing else could be added without changing every remaining call
   *  site at once — so the wrong scope would stay the **default**, and the next
   *  class family rendered in two places would repeat #128 and #144 while
   *  reading exactly like the calls around it. A *private* helper that cannot be
   *  called without a root carries none of that: there is no default left to be
   *  wrong. So the objection was always to a defaulted root on a shared exported
   *  helper, never to scoping itself, and this is where the two scoped families
   *  stop being two copies of one loop.
   *
   *  Two differences from `addListenerToClass` that do not bite today and are
   *  written down so they go on not biting: `querySelectorAll` never matches the
   *  root itself, so a class on `#commitTable` or on `#commitDetails` would not
   *  be bound; and `className` is interpolated into a selector, so a
   *  space-separated pair would read as a descendant combinator rather than as
   *  both classes.
   *
   *  The two families differ in one thing only, and it is why just one of them
   *  checks for a missing root: `tableElem` is non-nullable and set in the
   *  constructor, so the graph always has a table, while {@link cdvPanel} returns
   *  `null` whenever no panel is open. */
  private addScopedListenerToClass(
    root: HTMLElement,
    className: string,
    event: string,
    listener: EventListener
  ) {
    root
      .querySelectorAll<HTMLElement>("." + className)
      .forEach((elem) => elem.addEventListener(event, listener));
  }

  /** Wire a context-menu handler within `root` to both ways of raising one — the
   *  scoped counterpart of `addContextMenuListener`. Both, not just the
   *  pointer's: the keyboard's `MENU_KEY_EVENT` is dispatched at whatever holds
   *  focus, and focus reaches the branch-redundancy dialog's rows the moment
   *  anything gives them a tab stop (#141, #145). */
  private addScopedContextMenuListener(
    root: HTMLElement,
    className: string,
    listener: EventListener
  ) {
    this.addScopedListenerToClass(root, className, "contextmenu", listener);
    this.addScopedListenerToClass(root, className, MENU_KEY_EVENT, listener);
  }

  /** The graph's root, named: the only binder {@link renderTable} may use for a
   *  class the graph's *rows* carry, binding within `#commitTable` instead of
   *  across the whole document.
   *
   *  **A class name is never proof of the graph.** The branch-redundancy dialog
   *  builds its own commit list out of `redundancyCommitRow`, which emits
   *  `<tr class="commit" data-hash="…">` — the same shape the graph's rows have
   *  and the same shape both handlers here read a hash out of. Bound
   *  document-wide, every redraw behind a standing dialog wired the graph's
   *  click and context menu onto rows for commits the graph never loaded (#144).
   *
   *  Scope belongs to the caller that knows what it renders, and the scope this
   *  one needs already existed: `this.tableElem` is `#commitTable`, which
   *  {@link graphRows} has drawn for the focus path all along. Not a second
   *  scoping rule — the same one named once more.
   *
   *  `tableElem` is read live rather than captured because `renderTable`
   *  replaces its `innerHTML`, never the element, so the boundary outlives every
   *  redraw that runs through here.
   *
   *  **Not every binding the graph makes goes through here.** What is left, and
   *  what each one's safety rests on, is listed once beside `addListenerToClass`
   *  in `utils/dom.ts` — next to the unscoped helper, which is where someone
   *  adding a call site is actually looking. `tr.commit` was on that list until
   *  the redundancy dialog started drawing commit rows.
   *
   *  **Binding was only half of it, and #150 took the other half.** The reads
   *  that go looking for a commit row are scoped to the same `#commitTable`
   *  now, through {@link graphRowByHash} and {@link graphRowById} — see there
   *  for what each one was one markup change away from doing. */
  private addGraphListenerToClass(className: string, event: string, listener: EventListener) {
    this.addScopedListenerToClass(this.tableElem, className, event, listener);
  }

  /** {@link addGraphListenerToClass}'s context-menu pair, wiring both ways of
   *  raising one within `#commitTable`. */
  private addGraphContextMenuListener(className: string, listener: EventListener) {
    this.addScopedContextMenuListener(this.tableElem, className, listener);
  }

  /** The graph's commit row carrying `hash`, or `null` when the graph has not
   *  drawn one — the read side of {@link addGraphListenerToClass}'s boundary,
   *  and the reason no lookup that *means the graph's row* starts at `document`
   *  any more. Lookups that mean the dialog's still do, and say so in the
   *  selector; see the last paragraph.
   *
   *  **A class name is no more proof of the graph when reading than when
   *  binding.** `redundancyCommitRow` emits `<tr class="commit" data-hash="…">`
   *  for the branch-redundancy dialog's own list, so `document.querySelector`
   *  has had two candidates for every one of these lookups all along and
   *  answered with whichever came first in the page. What made it answer with
   *  the graph's is that `buildWebviewMarkup` writes `#commitTable` before
   *  `#dialog` — a fact about the markup, not about any of the reads, and one
   *  nothing records as load-bearing. Moving `#dialog` up, or drawing a future
   *  dialog inside `#content`, would have turned every one of them over at once
   *  (#150). Counted by what they do rather than by a total, because a total is
   *  the one thing a later reader cannot check: the **row lookups** listed
   *  below, all of which resolve one row and live in this file; the two
   *  **class sweeps** in {@link clearFindHighlights}, which resolve no row and
   *  carry their own note; and `blinkRow` in `utils/dom.ts`, which was neither —
   *  it re-derived from the hash a row its caller had already resolved.
   *
   *  The row lookups, and what each was one markup change away from doing:
   *
   *  - `renderTable`'s re-attach picks the row an inline Commit Details View is
   *    `insertAfter`'d onto, so a dialog row put the **panel inside the modal**,
   *    and set `expandedCommit.id` to the `NaN` a row with no `data-id` parses
   *    to. The worst of them. It resolves *two* rows, and the second is the
   *    easiest of all of these to overlook: the panel only ever goes after the
   *    primary, so where the panel lands says nothing about where the compared
   *    row came from — it shows instead in which row the comparison anchors
   *    itself to, and it wants a test of its own for exactly that reason;
   *  - {@link commitDetailsNavigateGraph} (by id) and the `commitBodyHash` chip
   *    both hand what they find to `loadCommitDetails`, which is the same wound
   *    one step earlier: it takes the row as the panel's new source;
   *  - {@link applyFindHighlights}, twice — the match and the current one —
   *    would paint the mark, and the bring-into-view scroll, onto the dialog's
   *    copy, leaving the graph's row unmarked while the counter went on saying a
   *    match was current; {@link clearFindHighlights} is the other half of that
   *    and carries its own note;
   *  - {@link scrollToHead} and {@link scrollToStash} would centre and flash a
   *    row inside the dialog, so the graph would not move at all — which reads
   *    as a dead command rather than as one that found the wrong tree.
   *
   *  Scope belongs to the caller that knows what it renders, and this is the
   *  same `this.tableElem` the binders and {@link graphRows} already name — not
   *  a second scoping rule, the one rule named on the other side of the
   *  read/write line. `tableElem` is read live for the reason given at
   *  {@link addGraphListenerToClass}: `renderTable` replaces its `innerHTML`,
   *  never the element.
   *
   *  Left document-wide on purpose, and correct there: the redundancy dialog's
   *  own reads (`#dialog .commitList tr.commit`, `redundancyDetailsCell`), which
   *  name their surface in the selector and want the rows this one refuses. */
  private graphRowByHash(hash: string): HTMLElement | null {
    return this.tableElem.querySelector<HTMLElement>('tr.commit[data-hash="' + hash + '"]');
  }

  /** The graph's row for the loaded-commit index `id`, or `null`.
   *
   *  {@link graphRowByHash}'s sibling rather than a delegation through some
   *  `graphRowBy(attribute, value)`: the two selectors differ only in an
   *  attribute name, and hiding that behind a parameter would cost the one
   *  property this whole family exists for — that you can grep a selector and
   *  see which tree it reads. Two one-line siblings that each name
   *  `this.tableElem` are not two rules; a parameterised selector *is* a second
   *  thing to get wrong.
   *
   *  Worth its own name because `data-id` is an index into `this.commits`, and
   *  so means nothing at all on a row the graph did not draw — which is exactly
   *  what the scope now guarantees and exactly what a document-wide read could
   *  not. */
  private graphRowById(id: number): HTMLElement | null {
    return this.tableElem.querySelector<HTMLElement>('tr.commit[data-id="' + id + '"]');
  }

  /** Rebuilds the commit table and hands back the one write it deliberately did
   *  not do — see {@link makeTableResizable} and {@link render}. Whoever calls
   *  this must run that write, and must run it after the last layout read of
   *  the same redraw. {@link render} is the only caller, and that is not an
   *  accident: a second one would be a second place to get it wrong, and
   *  ignoring the returned value is not a type error. */
  private renderTable(focusMayScroll: boolean = false): () => void {
    // Read before a single row is replaced; `restoreGraphFocus` at the end puts
    // the keyboard back on the same commit once the new rows are in place.
    const focusedKey = this.focusedRowKey();
    // The Commit Details View's file list is the other roving group a redraw
    // destroys, and it is read here for the same reason — one capture point
    // covers both layouts, because this runs before the table an inline panel
    // lives in is replaced and before a docked one is rebuilt further down.
    // At most one of the two keys is non-null: a file row is never inside a
    // commit row.
    const focusedFileKey = this.focusedCdvFileKey();
    const hiddenDate = this.columnVisibility.date ? "" : " hidden";
    const hiddenAuthor = this.columnVisibility.author ? "" : " hidden";
    const hiddenCommit = this.columnVisibility.commit ? "" : " hidden";
    // The header row and its cells are part of the grid: Up from the first
    // commit lands here, which is what makes the column/ordering menu reachable
    // without a mouse. Each `th` carries its own tabindex so Left/Right can walk
    // to the one whose menu the user wants.
    const colHeader = 'role="columnheader" tabindex="-1"';
    let html = `<tr id="tableColHeaders" role="row" tabindex="-1"><th id="tableHeaderGraphCol" class="tableColHeader" ${colHeader}></th><th class="tableColHeader" ${colHeader}>${l10n.description}</th><th class="tableColHeader${hiddenDate}" ${colHeader} data-col="date">${l10n.date}</th><th class="tableColHeader${hiddenAuthor}" ${colHeader} data-col="author">${l10n.author}</th><th class="tableColHeader${hiddenCommit}" ${colHeader} data-col="commit">${l10n.commit}</th></tr>`,
      i,
      currentHash = this.commits.length > 0 && this.commits[0].hash === "*" ? "*" : this.commitHead;
    // Only mute by ancestry when HEAD is actually within the loaded commits;
    // otherwise ancestry is unknown and nothing should be muted on that basis.
    const ancestors =
      this.config.muteCommitsNotAncestorsOfHead &&
      this.commitHead !== null &&
      this.commitLookup[this.commitHead] !== undefined
        ? this.ancestorsOfHead()
        : null;
    // Branch labels can be aligned to their graph vertex; precompute the
    // per-vertex x-offsets only when that layout is active.
    const widthsAtVertices = this.config.branchLabelsAlignedToGraph
      ? this.graph.getWidthsAtVertices()
      : [];
    // Whether a branch ref chip should read as dimmed. The host has already
    // applied the exemptions (head, filter selection, "always show" patterns),
    // so this is a plain lookup — replicating that rule here is exactly how the
    // two surfaces would drift apart.
    const isDimmedRef = (name: string) => this.dimmedRefs.has(name);
    // A bare `<span class="gitRef …">`; `dataName`/`label` are pre-escaped.
    const refSpan = (
      type: string,
      dataName: string,
      label: string,
      active: boolean,
      dimmed = false
    ) =>
      '<span class="gitRef ' +
      type +
      (active ? " active" : "") +
      (dimmed ? " dimmedRef" : "") +
      // Focusable so its menu — the only place a branch/tag/stash's actions
      // live — can be raised from the keyboard. Left/Right reach it from the row.
      '" tabindex="-1" data-name="' +
      dataName +
      '">' +
      (type === "tag" ? svgIcons.tag : type === "stash" ? svgIcons.stash : svgIcons.branch) +
      '<span class="gitRefName">' +
      label +
      "</span></span>";
    for (i = 0; i < this.commits.length; i++) {
      // Classify refs first so labels can be laid out by alignment and so
      // a remote branch can be folded into its matching local head label.
      let message = escapeHtml(
          replaceEmojiShortcodes(this.commits[i].message, this.config.customEmojiShortcodeMappings)
        ),
        date = getCommitDate(this.commits[i].date),
        refTags = "",
        stashHtml = "";
      const heads: { name: string; active: boolean }[] = [];
      const remotes: { name: string; remote: string; branch: string }[] = [];
      for (const ref of this.commits[i].refs) {
        if (ref.type === "tag") {
          if (this.config.showTags)
            refTags += refSpan("tag", escapeHtml(ref.name), escapeHtml(ref.name), false);
        } else if (ref.type === "stash") {
          stashHtml += refSpan("stash", escapeHtml(ref.name), escapeHtml(ref.name), false);
        } else if (ref.type === "remote") {
          // Split "<remote>/<branch>" using the known remote names.
          const remote = this.remotes.find((r) => ref.name === r || ref.name.startsWith(r + "/"));
          remotes.push({
            name: ref.name,
            remote: remote ?? "",
            branch: remote !== undefined ? ref.name.slice(remote.length + 1) : ref.name
          });
        } else {
          heads.push({ name: ref.name, active: ref.name === this.gitBranchHead });
        }
      }
      // Fold each remote into a matching head when combining is enabled.
      const consumed = new Set<string>();
      const combine = this.config.combineLocalAndRemoteBranchLabels;
      let refBranches = "";
      for (const head of heads) {
        let badges = "";
        if (combine) {
          for (const r of remotes) {
            if (r.branch !== head.name || consumed.has(r.name)) continue;
            consumed.add(r.name);
            // Nested .gitRef.remote so the existing context-menu / double-click
            // handlers resolve a click on the badge to the remote branch.
            badges +=
              '<span class="gitRef remote gitRefCombined' +
              (isDimmedRef(r.name) ? " dimmedRef" : "") +
              '" data-name="' +
              escapeHtml(r.name) +
              '">' +
              escapeHtml(r.remote) +
              "</span>";
          }
        }
        const headHtml =
          '<span class="gitRef head' +
          (head.active ? " active" : "") +
          (isDimmedRef(head.name) ? " dimmedRef" : "") +
          '" data-name="' +
          escapeHtml(head.name) +
          '">' +
          svgIcons.branch +
          '<span class="gitRefName">' +
          escapeHtml(head.name) +
          "</span>" +
          badges +
          "</span>";
        refBranches = head.active ? headHtml + refBranches : refBranches + headHtml;
      }
      for (const r of remotes) {
        if (!consumed.has(r.name)) {
          refBranches += refSpan(
            "remote",
            escapeHtml(r.name),
            escapeHtml(r.name),
            false,
            isDimmedRef(r.name)
          );
        }
      }
      refBranches += stashHtml;
      const mergeMuted = this.config.muteMergeCommits && this.commits[i].parentHashes.length > 1;
      const ancestorMuted = ancestors !== null && !ancestors.has(this.commits[i].hash);
      const muted = mergeMuted || ancestorMuted;
      const tooltip = commitNodeTooltip(
        this.commits[i].refs,
        this.commits[i].hash === this.commitHead,
        {
          head: l10n.tooltipCommitNodeHead,
          branches: l10n.tooltipCommitNodeBranches,
          tags: l10n.tooltipCommitNodeTags
        }
      );
      const sigCategory = signatureCategory(this.commits[i].signatureStatus);
      const signatureHtml =
        sigCategory === null
          ? ""
          : '<span class="commitSignature ' +
            sigCategory +
            '" title="' +
            (sigCategory === "good"
              ? l10n.signatureGood
              : sigCategory === "unverified"
                ? l10n.signatureUnverified
                : l10n.signatureBad) +
            '">' +
            (sigCategory === "bad" ? "✗" : sigCategory === "good" ? "✓" : "?") +
            "</span> ";
      // Lay out the graph + description cells per the reference-label alignment
      //. Tags either trail the message ("right") or sit with the branches.
      const headDot =
        this.commits[i].hash === this.commitHead
          ? '<span class="commitHeadDot" title="' + l10n.tooltipCommitHead + '"></span>'
          : "";
      const messageBold = this.commits[i].hash === currentHash ? "<b>" + message + "</b>" : message;
      const msgAndSig = signatureHtml + messageBold;
      const descCore = this.config.tagLabelsRightAligned
        ? msgAndSig + refTags
        : refTags + msgAndSig;
      // When aligned, branches live in the (otherwise-empty) graph cell, indented
      // to their vertex; otherwise the graph cell is empty and branches sit inline
      // ahead of the message in the description cell.
      const aligned = this.config.branchLabelsAlignedToGraph;
      const graphCell =
        aligned && refBranches !== ""
          ? '<td role="gridcell"><span style="margin-left:' +
            (widthsAtVertices[i] - 4) +
            'px"' +
            refBranches.substring(5) +
            "</td>"
          : '<td role="gridcell"></td>';
      const descCell =
        '<td role="gridcell">' + headDot + (aligned ? "" : refBranches) + descCore + "</td>";
      html +=
        "<tr " +
        (this.commits[i].hash !== "*"
          ? 'class="commit' +
            (muted ? " muted" : "") +
            '" data-hash="' +
            this.commits[i].hash +
            '"' +
            (tooltip !== "" ? ' title="' + escapeHtml(tooltip) + '"' : "")
          : 'class="unsavedChanges"') +
        // Focusable, but never a tab stop of its own: the table hands its single
        // tabindex="0" to one row at a time (see `graphTabStop`), so Tab steps
        // over the graph rather than through every commit in it.
        ' role="row" tabindex="-1" data-id="' +
        i +
        '" data-color="' +
        this.graph.getVertexColour(i) +
        '">' +
        graphCell +
        descCell +
        '<td role="gridcell" class="' +
        (hiddenDate ? "hidden" : "") +
        '" title="' +
        date.title +
        '">' +
        date.value +
        '</td><td role="gridcell" class="' +
        (hiddenAuthor ? "hidden" : "") +
        '" title="' +
        escapeHtml(this.commits[i].author + " <" + this.commits[i].email + ">") +
        '">' +
        this.avatarHtml(this.commits[i].email) +
        escapeHtml(this.commits[i].author) +
        '</td><td role="gridcell" class="' +
        (hiddenCommit ? "hidden" : "") +
        '" title="' +
        escapeHtml(this.commits[i].hash) +
        '">' +
        abbrevCommit(this.commits[i].hash) +
        "</td></tr>";
    }
    // `role="grid"` rather than the implicit `table`: the rows are interactive
    // and keyboard-navigable, which is the distinction between the two roles.
    this.tableElem.innerHTML =
      '<table role="grid" aria-label="' + escapeHtml(l10n.commitGraph) + '">' + html + "</table>";
    // Re-apply find highlighting to the freshly-rendered rows (without scrolling).
    if (this.findActive) this.applyFindHighlights(false);
    this.renderFooter();
    const applyGraphColumnWidth = this.makeTableResizable();

    if (this.expandedCommit !== null) {
      // The graph's row, and this is the read the dialog's copy hurt most:
      // `elem` becomes the row an inline panel is `insertAfter`'d onto a few
      // lines down, so answering with a dialog row moved the Commit Details View
      // into the modal — and, the row carrying no `data-id`, set the expanded
      // commit's id to `NaN` on the way. See {@link graphRowByHash}.
      const elem = this.graphRowByHash(this.expandedCommit.hash);
      if (elem === null) {
        // The expanded commit is no longer loaded. An inline panel was already
        // discarded with the re-rendered table, but a docked panel lives in
        // <body> and must be removed explicitly.
        this.clearExpandedCommit();
        this.saveState();
      } else {
        this.expandedCommit.id = parseInt(elem.dataset.id!);
        this.expandedCommit.srcElem = elem;
        if (this.expandedCommit.compareWithHash !== null) {
          // Re-bind the compared commit's row too; if it scrolled out of
          // the loaded set, fall back to the primary commit's own details.
          // Known gap in the "a redraw moves nothing" guarantee: that fallback
          // reopens a different CDV, so it does scroll into view. Appending
          // pages cannot reach it (nothing leaves the loaded set), but a soft
          // refresh that drops the compared commit can.
          const compareElem = this.graphRowByHash(this.expandedCommit.compareWithHash);
          this.expandedCommit.compareWithSrcElem = compareElem;
          this.saveState();
          if (compareElem === null) {
            this.loadCommitDetails(elem);
          } else if (
            this.expandedCommit.compareFileChanges !== null &&
            this.expandedCommit.fileTree !== null &&
            this.expandedCommit.compareFromHash !== null &&
            this.expandedCommit.compareToHash !== null
          ) {
            this.showCommitComparison(
              this.expandedCommit.compareFromHash,
              this.expandedCommit.compareToHash,
              this.expandedCommit.compareFileChanges,
              this.expandedCommit.fileTree
            );
          } else {
            this.loadCommitComparison(compareElem);
          }
        } else {
          this.saveState();
          if (this.expandedCommit.commitDetails !== null && this.expandedCommit.fileTree !== null) {
            this.showCommitDetails(this.expandedCommit.commitDetails, this.expandedCommit.fileTree);
          } else {
            this.loadCommitDetails(elem);
          }
        }
      }
    }
    // Both restores run after the expanded commit has been re-bound to its new
    // row: the panel is by now either redrawn from cache, with file rows to be
    // found, or gone pending a re-request, which restoreCdvFileFocus documents
    // as its one reachable miss. The graph's tab stop can likewise land back on
    // the expanded commit rather than on the top of the graph.
    this.restoreCdvFileFocus(focusedFileKey);
    this.restoreGraphFocus(focusedKey, focusMayScroll);

    addContextMenuListener("tableColHeader", (e: Event) => {
      const headerElem = <HTMLElement>(<Element>e.target).closest(".tableColHeader")!;
      // Only the Date/Author/Commit headers carry a data-col and can be toggled.
      if (headerElem.dataset.col === undefined) return;
      e.stopPropagation();
      const toggle = (col: "date" | "author" | "commit") => {
        this.columnVisibility[col] = !this.columnVisibility[col];
        this.saveState();
        // Every redraw goes through render(): it is the only place the write
        // renderTable hands back is run, and a path that spells out renderTable
        // + renderGraph for itself drops that write without saying so.
        this.render();
      };
      const item = (col: "date" | "author" | "commit", label: string) => ({
        title: label,
        checked: this.columnVisibility[col],
        onClick: () => toggle(col)
      });
      // Per-repo commit-ordering override (null = use the global setting).
      const currentOrder = this.gitRepos[this.currentRepo!]?.commitOrdering ?? null;
      const setOrder = (order: CommitOrdering | null) => {
        // Nothing below survives a dropped reload: the preference would be
        // persisted, the loaded commit window snapped back to the opening
        // count and the branch search index thrown away for a graph that never
        // reloads — and the shrunken window would then silently collapse the
        // graph at some later refresh. Either the whole change happens or none
        // of it does.
        //
        // And "none of it" has to be said out loud. This is a menu item the
        // user picked: the menu closes, the tick does not move, no error, and
        // the next attempt works — which is the shape of a dead menu item, not
        // of a refusal. The precedent is `dialogBatchBusy` and the three
        // refusals that followed it (`dialogHeadMoved`, `dialogStashMoved`,
        // `dialogPushRemoteGone`): state moved under an action the user asked
        // for, so the action is refused *visibly*. Silence is only right where
        // there is nothing left to do — the Find step whose match was amended
        // away while its question stood, a few thousand lines down, which has
        // no match to step onto at all. Here there is something left: the very
        // same click, a moment later.
        if (this.commitLoadInFlight) {
          showErrorDialog(l10n.dialogCommitOrderBusy, null, null);
          return;
        }
        const repoState = this.gitRepos[this.currentRepo!];
        if (repoState === undefined) return;
        repoState.commitOrdering = order;
        sendMessage({
          command: "saveRepoState",
          repo: this.currentRepo!,
          state: repoState
        });
        this.shrinkLoadedCommitWindow();
        this.requestLoadCommits(true, () => {});
      };
      const orderItem = (order: CommitOrdering | null, label: string) => ({
        title: label,
        checked: currentOrder === order,
        onClick: () => setOrder(order)
      });
      showContextMenu(
        <MouseEvent>e,
        [
          item("date", l10n.date),
          item("author", l10n.author),
          item("commit", l10n.commit),
          null,
          orderItem(null, l10n.commitOrderDefault),
          orderItem("date", l10n.commitOrderDate),
          orderItem("author-date", l10n.commitOrderAuthorDate),
          orderItem("topo", l10n.commitOrderTopo)
        ],
        headerElem
      );
    });
    // Scoped, like the click below: `.commit` is the dialog's shape too, and
    // this menu is where that cost the most — 11 items, Checkout and Reset among
    // them, aimed at whatever hash the clicked row carried (#144).
    this.addGraphContextMenuListener("commit", (e: Event) => {
      e.stopPropagation();
      let sourceElem = <HTMLElement>(<Element>e.target).closest(".commit")!;
      let hash = sourceElem.dataset.hash!;
      // Drop is only offered when the topological check passes.
      const canDrop = dropCommitPossible(hash, this.commits, this.commitLookup, this.commitHead);
      // Two CTRL-selected commits bound the range `rebase --onto` replays, and
      // the right-clicked commit is the new base.
      const ontoRange = this.comparedRangeOnto(hash);
      const cmv = viewState.contextMenuActionsVisibility.commit; // per-action visibility
      showContextMenu(
        <MouseEvent>e,
        [
          {
            title: l10n.addTag + ELLIPSIS,
            icon: "tag",
            visible: cmv.addTag,
            onClick: () => {
              const hasRemotes = this.remotes.length > 0;
              const pushRemote = hasRemotes ? this.defaultPushRemote() : "";
              const addTagInputs: DialogInput[] = [
                { type: "text-ref", name: l10n.dialogAddTagName, default: "" },
                {
                  type: "select",
                  name: l10n.dialogAddTagType,
                  default: this.config.dialogAddTagType,
                  options: [
                    { name: l10n.dialogAddTagTypeAnnotated, value: "annotated" },
                    { name: l10n.dialogAddTagTypeLightweight, value: "lightweight" }
                  ]
                },
                {
                  type: "text",
                  name: l10n.dialogAddTagMessage,
                  default: "",
                  placeholder: l10n.dialogAddTagOptional
                }
              ];
              if (hasRemotes) {
                addTagInputs.push({
                  type: "checkbox",
                  name: l10n.dialogAddTagPushToRemote,
                  value: false
                });
              }
              const latestTag = latestTagName(this.commits);
              showFormDialog(
                l10n.dialogAddTagTitle.replace("{0}", "<b><i>" + abbrevCommit(hash) + "</i></b>") +
                  (latestTag !== null
                    ? "<br>" +
                      l10n.dialogAddTagLatest.replace("{0}", "<b>" + escapeHtml(latestTag) + "</b>")
                    : ""),
                addTagInputs,
                l10n.dialogAddTagSubmit,
                (values) => {
                  const tagName = values[0];
                  const send = (repo: string, force: boolean) => {
                    sendMessage({
                      command: "addTag",
                      repo,
                      tagName,
                      commitHash: hash,
                      lightweight: values[1] === "lightweight",
                      message: values[2],
                      pushToRemote: hasRemotes && values[3] === "checked" ? pushRemote : null,
                      force
                    });
                  };
                  // A tag with this name already exists: confirm replacing it.
                  const tagExists = this.commits.some((c) =>
                    c.refs.some((r) => r.type === "tag" && r.name === tagName)
                  );
                  if (tagExists) {
                    this.confirmForRepo(
                      l10n.dialogAddTagExists.replace(
                        "{0}",
                        "<b><i>" + escapeHtml(tagName) + "</i></b>"
                      ),
                      (repo) => send(repo, true),
                      null
                    );
                  } else {
                    send(this.currentRepo!, false);
                  }
                },
                sourceElem
              );
            }
          },
          {
            title: l10n.createBranch + ELLIPSIS,
            icon: "branch",
            visible: cmv.createBranch,
            onClick: () => {
              showFormDialog(
                l10n.dialogCreateBranchTitle.replace(
                  "{0}",
                  "<b><i>" + abbrevCommit(hash) + "</i></b>"
                ),
                [
                  { type: "text-ref", name: l10n.dialogCreateBranchName, default: "" },
                  {
                    type: "checkbox",
                    name: l10n.dialogCreateBranchCheckout,
                    value: this.config.dialogCreateBranchCheckOut
                  }
                ],
                l10n.dialogCreateBranchSubmit,
                (values) => {
                  const branchName = values[0];
                  const checkout = values[1] === "checked";
                  const send = (repo: string, force: boolean) => {
                    sendMessage({
                      command: "createBranch",
                      repo,
                      branchName,
                      commitHash: hash,
                      checkout,
                      force
                    });
                  };
                  // A local branch with this name already exists: confirm replacing it.
                  if (this.gitBranches.includes(branchName)) {
                    this.confirmForRepo(
                      l10n.dialogCreateBranchExists.replace(
                        "{0}",
                        "<b><i>" + escapeHtml(branchName) + "</i></b>"
                      ),
                      (repo) => send(repo, true),
                      null
                    );
                  } else {
                    send(this.currentRepo!, false);
                  }
                },
                sourceElem
              );
            }
          },
          null,
          {
            visible: cmv.checkout,
            title: l10n.checkout + ELLIPSIS,
            icon: "arrowSwitch",
            onClick: () => {
              const doCheckout = () => {
                sendMessage({
                  command: "checkoutCommit",
                  repo: this.currentRepo!,
                  commitHash: hash
                });
              };
              // "Always Accept" suppresses this confirmation in future (persisted).
              if (this.alwaysAcceptCheckoutCommit) {
                doCheckout();
                return;
              }
              showFormDialog(
                l10n.dialogCheckoutConfirm.replace(
                  "{0}",
                  "<b><i>" + abbrevCommit(hash) + "</i></b>"
                ),
                [{ type: "checkbox", name: l10n.dialogCheckoutAlwaysAccept, value: false }],
                l10n.dialogYes,
                (values) => {
                  if (values[0] === "checked") {
                    this.alwaysAcceptCheckoutCommit = true;
                    this.saveState();
                  }
                  doCheckout();
                },
                sourceElem
              );
            }
          },
          {
            visible: cmv.cherrypick,
            title: l10n.cherryPick + ELLIPSIS,
            icon: "cherryPick",
            onClick: () => {
              const confirmMsg = l10n.dialogCherryPickConfirm.replace(
                "{0}",
                "<b><i>" + abbrevCommit(hash) + "</i></b>"
              );
              if (this.commits[this.commitLookup[hash]].parentHashes.length === 1) {
                showFormDialog(
                  confirmMsg,
                  [
                    {
                      type: "checkbox",
                      name: l10n.dialogCherryPickNoCommit,
                      value: this.config.dialogCherryPickNoCommit,
                      remember: true
                    },
                    {
                      type: "checkbox",
                      name: l10n.dialogCherryPickRecordOrigin,
                      value: false,
                      remember: true
                    }
                  ],
                  l10n.dialogYesCherryPick,
                  (values) => {
                    sendMessage({
                      command: "cherrypickCommit",
                      repo: this.currentRepo!,
                      commitHash: hash,
                      parentIndex: 0,
                      noCommit: values[0] === "checked",
                      recordOrigin: values[1] === "checked"
                    });
                  },
                  sourceElem,
                  "cherryPick"
                );
              } else {
                let options = this.commits[this.commitLookup[hash]].parentHashes.map(
                  (parentHash, index) => ({
                    name:
                      abbrevCommit(parentHash) +
                      (typeof this.commitLookup[parentHash] === "number"
                        ? ": " + this.commits[this.commitLookup[parentHash]].message
                        : ""),
                    value: (index + 1).toString()
                  })
                );
                showFormDialog(
                  confirmMsg,
                  [
                    { type: "select", name: l10n.dialogCherryPickParent, options, default: "1" },
                    {
                      type: "checkbox",
                      name: l10n.dialogCherryPickNoCommit,
                      value: this.config.dialogCherryPickNoCommit,
                      remember: true
                    },
                    {
                      type: "checkbox",
                      name: l10n.dialogCherryPickRecordOrigin,
                      value: false,
                      remember: true
                    }
                  ],
                  l10n.dialogYesCherryPick,
                  (values) => {
                    sendMessage({
                      command: "cherrypickCommit",
                      repo: this.currentRepo!,
                      commitHash: hash,
                      parentIndex: parseInt(values[0]),
                      noCommit: values[1] === "checked",
                      recordOrigin: values[2] === "checked"
                    });
                  },
                  sourceElem,
                  "cherryPick"
                );
              }
            }
          },
          {
            visible: cmv.revert,
            title: l10n.revert + ELLIPSIS,
            icon: "undo",
            onClick: () => {
              if (this.commits[this.commitLookup[hash]].parentHashes.length === 1) {
                this.confirmForRepo(
                  l10n.dialogRevertConfirm.replace(
                    "{0}",
                    "<b><i>" + abbrevCommit(hash) + "</i></b>"
                  ),
                  (repo) => {
                    sendMessage({
                      command: "revertCommit",
                      repo,
                      commitHash: hash,
                      parentIndex: 0
                    });
                  },
                  sourceElem
                );
              } else {
                let options = this.commits[this.commitLookup[hash]].parentHashes.map(
                  (parentHash, index) => ({
                    name:
                      abbrevCommit(parentHash) +
                      (typeof this.commitLookup[parentHash] === "number"
                        ? ": " + this.commits[this.commitLookup[parentHash]].message
                        : ""),
                    value: (index + 1).toString()
                  })
                );
                showSelectDialog(
                  l10n.dialogRevertConfirm.replace(
                    "{0}",
                    "<b><i>" + abbrevCommit(hash) + "</i></b>"
                  ),
                  "1",
                  options,
                  l10n.dialogYesRevert,
                  (parentIndex) => {
                    sendMessage({
                      command: "revertCommit",
                      repo: this.currentRepo!,
                      commitHash: hash,
                      parentIndex: parseInt(parentIndex)
                    });
                  },
                  sourceElem
                );
              }
            }
          },
          null,
          {
            visible: cmv.merge,
            title: l10n.merge + ELLIPSIS,
            icon: "gitMerge",
            onClick: () => {
              showFormDialog(
                l10n.dialogMergeConfirm
                  .replace("{0}", `<b><i>${abbrevCommit(hash)}</i></b>`)
                  .replace("{1}", this.currentBranchLabel()) +
                  conflictPredictionPlaceholder(this.currentRepo!, hash),
                [
                  {
                    type: "checkbox",
                    name: l10n.dialogMergeNoFastForward,
                    value: this.config.dialogMergeNoFastForward,
                    remember: true
                  },
                  {
                    type: "checkbox",
                    name: l10n.dialogMergeSquash,
                    value: this.config.dialogMergeSquash,
                    remember: true
                  },
                  { type: "checkbox", name: l10n.dialogMergeNoCommit, value: false, remember: true }
                ],
                l10n.dialogYesMerge,
                (values) => {
                  sendMessage({
                    command: "mergeCommit",
                    repo: this.currentRepo!,
                    commitHash: hash,
                    createNewCommit: values[0] === "checked",
                    squash: values[1] === "checked",
                    noCommit: values[2] === "checked"
                  });
                },
                null,
                "merge"
              );
            }
          },
          {
            visible: cmv.reset,
            title: l10n.reset + ELLIPSIS,
            icon: "history",
            onClick: () => {
              showSelectDialog(
                l10n.dialogResetConfirm
                  .replace("{0}", this.currentBranchLabel())
                  .replace("{1}", "<b><i>" + abbrevCommit(hash) + "</i></b>"),
                this.config.dialogResetMode,
                [
                  { name: l10n.dialogResetSoft, value: "soft" },
                  { name: l10n.dialogResetMixed, value: "mixed" },
                  { name: l10n.dialogResetHard, value: "hard" }
                ],
                l10n.dialogYesReset,
                (mode) => {
                  sendMessage({
                    command: "resetToCommit",
                    repo: this.currentRepo!,
                    commitHash: hash,
                    resetMode: <GitResetMode>mode
                  });
                },
                sourceElem,
                "resetMode"
              );
            }
          },
          // One rebase entry, whichever rebase is on offer (#173): with a range
          // to replay it says so and replays it, otherwise it replays the
          // current branch. Two entries would have asked the user to pick
          // between them, and the gesture that decides it — CTRL-comparing two
          // commits — is already made by the time the menu opens.
          {
            visible: cmv.rebase,
            title: (ontoRange === null ? l10n.rebaseOnCommit : l10n.rebaseRangeOnCommit) + ELLIPSIS,
            icon: "rebase",
            onClick: () =>
              ontoRange === null
                ? this.rebaseOnAction(commitTarget(hash), hash, sourceElem)
                : this.rebaseOntoAction(commitTarget(hash), ontoRange, sourceElem)
          },
          ...(canDrop
            ? <ContextMenuElement[]>[
                {
                  title: l10n.drop + ELLIPSIS,
                  icon: "trash",
                  visible: cmv.drop,
                  onClick: () => {
                    // A HEAD site, though it names no branch in its own
                    // message: `git rebase --onto <hash>~1 <hash>` omits
                    // git's `<branch>`, so git supplies HEAD. Its own
                    // availability test says so too — `dropCommitPossible`
                    // requires a linear path from the commit down to
                    // `commitHead`, computed when the menu opened. Let HEAD
                    // move and the replayed range becomes `<hash>..HEAD` on a
                    // branch nobody agreed to, silently and without a git
                    // error. The dialog says it: "rewrites the history of the
                    // current branch".
                    this.confirmForRepoAndHead(
                      l10n.dialogDropConfirm.replace(
                        "{0}",
                        "<b><i>" + abbrevCommit(hash) + "</i></b>"
                      ),
                      (repo) => {
                        sendMessage({
                          command: "dropCommit",
                          repo,
                          commitHash: hash
                        });
                        showActionRunningDialog(l10n.dropping);
                      },
                      sourceElem
                    );
                  }
                }
              ]
            : []),
          {
            visible: true,
            title: l10n.exportPatch + ELLIPSIS,
            onClick: () => {
              sendMessage({ command: "exportPatch", repo: this.currentRepo!, commitHash: hash });
            }
          },
          null,
          {
            visible: cmv.copyHash,
            title: l10n.copyCommitHash,
            onClick: () => {
              sendMessage({ command: "copyToClipboard", type: "Commit Hash", data: hash });
            }
          },
          {
            visible: cmv.copySubject,
            title: l10n.copyCommitSubject,
            onClick: () => {
              const commit = this.commits[this.commitLookup[hash]];
              if (commit !== undefined) {
                sendMessage({
                  command: "copyToClipboard",
                  type: "Commit Subject",
                  data: commit.message
                });
              }
            }
          }
        ],
        sourceElem
      );
    });
    // The `!`s below rest on the scope, not on luck: every row this reaches was
    // rendered by the loop above, so it has both a `data-id` and a `data-hash`.
    // Unscoped, this also reached the redundancy dialog's rows, which have a
    // hash but no id — `loadCommitDetails` parsed `NaN` for one, asked the host
    // for a commit the graph had never loaded, and closed the panel standing
    // behind the dialog before it did (#144).
    this.addGraphListenerToClass("commit", "click", (e: Event) => {
      const mouseEvent = e as MouseEvent;
      let sourceElem = <HTMLElement>(<Element>e.target).closest(".commit")!;
      const hash = sourceElem.dataset.hash!;
      if (
        (mouseEvent.ctrlKey || mouseEvent.metaKey) &&
        this.expandedCommit !== null &&
        this.expandedCommit.hash !== hash
      ) {
        // CTRL/CMD-click a second commit to compare it with the expanded one;
        // clicking the already-compared commit again toggles back to details.
        if (this.expandedCommit.compareWithHash === hash) {
          this.hideCommitComparison();
        } else {
          this.loadCommitComparison(sourceElem);
        }
      } else if (this.expandedCommit !== null && this.expandedCommit.hash === hash) {
        // Clicking the anchored (primary) row again closes the view, whether a
        // single-commit details or a comparison is open.
        this.hideCommitDetails();
      } else {
        this.loadCommitDetails(sourceElem);
      }
    });
    addContextMenuListener("unsavedChanges", (e: Event) => {
      e.stopPropagation();
      const sourceElem = <HTMLElement>(<Element>e.target).closest(".unsavedChanges")!;
      const ucv = viewState.contextMenuActionsVisibility.uncommittedChanges; // #198
      showContextMenu(
        <MouseEvent>e,
        [
          {
            title: l10n.openScmView,
            visible: ucv.openSourceControlView,
            onClick: () => sendMessage({ command: "openScmView" })
          },
          null,
          {
            title: l10n.resetUncommitted + ELLIPSIS,
            icon: "history",
            visible: ucv.reset,
            onClick: () => {
              this.confirmForRepo(
                l10n.dialogResetUncommittedConfirm,
                (repo) => sendMessage({ command: "resetUncommittedChanges", repo }),
                null
              );
            }
          },
          {
            title: l10n.cleanUntracked + ELLIPSIS,
            icon: "trash",
            visible: ucv.clean,
            onClick: () => {
              this.confirmForRepo(
                l10n.dialogCleanUntrackedConfirm,
                (repo) => sendMessage({ command: "cleanUntrackedFiles", repo }),
                null
              );
            }
          }
        ],
        sourceElem
      );
    });
    addContextMenuListener("gitRef", (e: Event) => {
      e.stopPropagation();
      const sourceElem = <HTMLElement>(<Element>e.target).closest(".gitRef")!;
      const refName = unescapeHtml(sourceElem.dataset.name!);
      // Classified once, here at the DOM boundary: menuFor decides the menu's
      // content from this typed target instead of reading classes back off the
      // DOM. The precedence mirrors the chip markup — a combined remote badge
      // is a .remote chip nested inside a .head chip, and closest() has
      // already resolved to the innermost one.
      const target: RefTarget = sourceElem.classList.contains("stash")
        ? { kind: "stash", name: refName }
        : sourceElem.classList.contains("tag")
          ? { kind: "tag", name: refName }
          : sourceElem.classList.contains("head")
            ? { kind: "branch", name: refName, isHead: this.gitBranchHead === refName }
            : { kind: "remoteBranch", name: refName };
      const isRemote = target.kind === "remoteBranch";
      // The range this branch's rebase entry would replay onto it, or null for
      // the plain "rebase the current branch onto this branch" the entry
      // always was (#173). Only local branches can be a `--onto` target here;
      // rebase is a `refKinds: "local"` action, so no other kind of chip
      // carries the entry at all.
      const ontoRange =
        target.kind === "branch" ? this.comparedRangeOnto(this.commitOfRef(refName)) : null;
      const issueUrl = firstIssueUrl(
        refName,
        this.config.issueLinkingRegex,
        this.config.issueLinkingUrl
      );
      const applyOrPop = (command: "applyStash" | "popStash", title: string) => {
        showFormDialog(
          title.replace("{0}", "<b><i>" + escapeHtml(refName) + "</i></b>"),
          [
            {
              type: "checkbox",
              name: l10n.dialogStashReinstateIndex,
              value: false,
              remember: true
            }
          ],
          command === "popStash" ? l10n.stashPop : l10n.stashApply,
          (values) => {
            sendMessage({
              command,
              repo: this.currentRepo!,
              selector: refName,
              reinstateIndex: values[0] === "checked"
            });
          },
          sourceElem,
          "stashApplyPop"
        );
      };
      // What activating each item does. The behaviour stays here — dialogs
      // anchor on the chip, messages carry this.currentRepo — while menuFor
      // owns which items appear.
      const actions: RefMenuActions = {
        applyStash: () => applyOrPop("applyStash", l10n.dialogStashApplyConfirm),
        popStash: () => applyOrPop("popStash", l10n.dialogStashPopConfirm),
        dropStash: () => {
          // `stash@{n}` is a position on the stack, not a name: any
          // `git stash push` — the terminal, the SCM view, a
          // `pull --autostash` — pushes onto the top and renumbers everything
          // below it. So the number the user is agreeing to stops naming this
          // stash the moment another one lands, and the reload that lands it no
          // longer takes the question away with it. Bound at consent like the
          // repo it is sent to ({@link confirmForRepo}) and re-read on the far
          // side: the premise is not the number, it is what the number pointed
          // at. Never undefined here — the menu was opened on a row this
          // lookup's own list drew.
          const stashHash = this.stashNodeFor(refName)?.hash;
          this.confirmForRepo(
            l10n.dialogStashDropConfirm.replace("{0}", "<b><i>" + escapeHtml(refName) + "</i></b>"),
            (repo) => {
              // Refused out loud, and not redirected at the captured stash.
              // Redirecting is *possible* — the captured hash could be looked
              // back up to whatever `stash@{m}` it wears now — and it is still
              // the wrong answer: the number in that message is the whole of
              // what the dialog said, so acting on a different one acts on
              // something the user was never shown. A drop leaves no ref
              // behind, and the only way back is hunting for a dangling commit,
              // so this is {@link confirmForRepoAndHead}'s case rather than
              // `confirmForRepo`'s — fail safe, and say so.
              if (this.stashNodeFor(refName)?.hash !== stashHash) {
                showErrorDialog(
                  l10n.dialogStashMoved.replace("{0}", escapeHtml(refName)),
                  null,
                  null
                );
                return;
              }
              sendMessage({ command: "dropStash", repo, selector: refName });
            },
            sourceElem
          );
        },
        renameStash: () => {
          // Pre-fill with the stash's current displayed name (its commit
          // subject), taken from the loaded stash node for this ref.
          const currentMessage = this.stashNodeFor(refName)?.message ?? "";
          showFormDialog(
            l10n.dialogStashRenameTitle.replace("{0}", "<b><i>" + escapeHtml(refName) + "</i></b>"),
            [{ type: "text", name: "", default: currentMessage, placeholder: null }],
            l10n.dialogStashRenameSubmit,
            (values) => {
              const message = values[0].trim();
              if (message === "") return; // empty message: treat as cancel
              sendMessage({
                command: "renameStash",
                repo: this.currentRepo!,
                selector: refName,
                message
              });
            },
            sourceElem
          );
        },
        viewTagDetails: () => {
          sendMessage({ command: "tagDetails", repo: this.currentRepo!, tagName: refName });
        },
        deleteTag: () => {
          const confirmMsg = l10n.dialogDeleteConfirm
            .replace("{0}", l10n.labelTag)
            .replace("{1}", "<b><i>" + escapeHtml(refName) + "</i></b>");
          if (this.remotes.length === 0) {
            this.confirmForRepo(
              confirmMsg,
              (repo) => {
                sendMessage({
                  command: "deleteTag",
                  repo,
                  tagName: refName,
                  deleteOnRemote: null
                });
              },
              null
            );
          } else {
            // Offer to also delete the tag from a remote.
            showSelectDialog(
              confirmMsg + "<br>" + l10n.dialogDeleteTagOnRemote,
              "",
              [
                { name: l10n.dialogDeleteTagLocalOnly, value: "" },
                ...this.remotes.map((r) => ({ name: r, value: r }))
              ],
              l10n.deleteTag,
              (remote) => {
                sendMessage({
                  command: "deleteTag",
                  repo: this.currentRepo!,
                  tagName: refName,
                  deleteOnRemote: remote === "" ? null : remote
                });
                if (remote !== "") showActionRunningDialog(l10n.deletingTag);
              },
              null
            );
          }
        },
        pushTag: () => this.pushTagAction(refName),
        checkout: () => this.checkoutBranchAction(refName, isRemote),
        rename: () => this.renameBranchAction(refName),
        push: () => this.pushBranchAction(refName),
        createArchive: () => {
          sendMessage({ command: "createArchive", repo: this.currentRepo!, ref: refName });
        },
        delete: () => this.deleteBranchAction(refName),
        merge: () => this.mergeBranchAction(refName),
        // `refName` stands as the new base as well as its label. A display ref
        // is normally barred from flowing back as an identity (CONTEXT.md,
        // "Ref 的兩種形"), but `kind: "branch"` has already carried that
        // identity: this is a local branch, whose two forms are the same
        // string. It is the spelling `rebaseOn` has always sent for the same
        // chip.
        rebase: () =>
          ontoRange === null
            ? this.rebaseOnBranchAction(refName)
            : this.rebaseOntoAction(branchTarget(refName), ontoRange, sourceElem),
        fastForward: () => this.fastForwardBranchAction(refName),
        pull: () => this.pullRemoteBranchAction(refName),
        fetchIntoLocal: () => this.fetchIntoLocalBranchAction(refName, sourceElem),
        deleteRemote: () => this.deleteRemoteBranchAction(refName),
        checkRedundancy: () => requestBranchRedundancy(this.currentRepo!, refName),
        cleanupBranches: () => requestBranchCleanup(this.currentRepo!),
        createPullRequest: () => this.createPullRequestAction(refName, isRemote),
        // Only reachable when menuFor put the item on the menu, which it does
        // solely for a non-null issueUrl.
        viewIssue: () => sendMessage({ command: "openExternalUrl", url: issueUrl! }),
        copyName: (type) => sendMessage({ command: "copyToClipboard", type, data: refName })
      };
      showContextMenu(
        e,
        menuFor(target, {
          cmv: viewState.contextMenuActionsVisibility, // per-action visibility
          hasRemotes: this.remotes.length > 0,
          isCleanupCandidate: this.cleanupCandidateRefs.has(refName),
          issueUrl,
          rebaseReplaysRange: ontoRange !== null,
          actions
        }),
        sourceElem
      );
    });
    addListenerToClass("gitRef", "click", (e: Event) => e.stopPropagation());
    addListenerToClass("gitRef", "dblclick", (e: Event) => {
      e.stopPropagation();
      hideDialogAndContextMenu();
      let sourceElem = <HTMLElement>(<Element>e.target).closest(".gitRef")!;
      // Only branches are checkout-able; tag/stash refs share the gitRef class.
      if (sourceElem.classList.contains("head") || sourceElem.classList.contains("remote")) {
        this.checkoutBranchAction(
          unescapeHtml(sourceElem.dataset.name!),
          sourceElem.classList.contains("remote")
        );
      }
    });

    return applyGraphColumnWidth;
  }
  private renderUncommitedChanges() {
    let date = getCommitDate(this.commits[0].date);
    document.getElementsByClassName("unsavedChanges")[0].innerHTML =
      '<td role="gridcell"></td><td role="gridcell"><b>' +
      escapeHtml(this.commits[0].message) +
      '</b></td><td role="gridcell" title="' +
      date.title +
      '">' +
      date.value +
      '</td><td role="gridcell" title="* <>">*</td><td role="gridcell" title="*">*</td>';
  }
  /** The footer under the graph: Load More while there is more history to
   *  fetch — or the spinner that stands in for it while its page is on the way
   *  — and, only once the loaded commit window has been widened past the
   *  opening count, what that window stands at with the way back to it.
   *
   *  **The one place that writes the footer.** It used to have three, and the
   *  other two took the whole element: Load More replaced `btn.parentNode`,
   *  which is the footer and not the button, so every press wiped the line for
   *  the duration of the load — the moment the user most wants it, having just
   *  widened the window another page. Reading the state here, once, is what
   *  stops the footer describing a window the graph does not have.
   *
   *  The line reads `maxCommits`: the loaded commit window is the cap the graph
   *  is currently asking the backend for, so it moves when the request goes
   *  out, not when the page comes back. One quantity, one reading.
   *
   *  Its two conditions are independent, deliberately. The footer is empty when
   *  no more commits are available, and that is exactly the moment the window
   *  is most worth resetting: the user got there by widening it until the whole
   *  history was in. Hanging the line off "is Load More showing?" would hide it
   *  precisely there. At the opening count the footer gains nothing at all —
   *  the default view carries no chrome describing a state it is already in.
   *
   *  Both controls are real `<button>`s (#88). They were `div.roundedBtn` with
   *  neither a tabindex nor a role, which left ADR-0019's condition for keeping
   *  automatic loading — the loaded commit window must be visible *and* have a
   *  way back — half empty: the line is text and reads fine, but the way back
   *  was reachable only with a mouse. The alternative, a tabindex and a role on
   *  the `div`, would have meant wiring up Enter and Space by hand, and that is
   *  the half of a fake button most often forgotten. Being one tag rather than
   *  three attributes plus a key handler is the whole argument.
   *
   *  Writing the whole `innerHTML` is what costs focus, and
   *  {@link rememberFooterFocus} is what pays it back. */
  private renderFooter(loading: boolean = false) {
    // Read before the innerHTML below destroys whichever control holds focus;
    // restored at the end, once the replacements are in and listening.
    this.rememberFooterFocus();
    const widened = this.maxCommits > this.config.initialLoadCommits;
    this.footerElem.innerHTML =
      (loading
        ? '<h2 id="loadingHeader">' + svgIcons.loading + l10n.loading + "</h2>"
        : this.moreCommitsAvailable
          ? '<button type="button" id="loadMoreCommitsBtn" class="roundedBtn">' +
            l10n.loadMore +
            "</button>"
          : "") +
      (widened
        ? '<div id="loadedCommitWindow"><span id="loadedCommitWindowCount">' +
          l10n.loadedCommitWindow.replace("{0}", String(this.maxCommits)) +
          '</span><button type="button" id="resetLoadedCommitWindowBtn" class="roundedBtn">' +
          l10n.resetLoadedCommitWindow.replace("{0}", String(this.config.initialLoadCommits)) +
          "</button></div>"
        : "");

    if (!loading && this.moreCommitsAvailable) {
      document.getElementById("loadMoreCommitsBtn")!.addEventListener("click", () => {
        this.loadMoreCommits("operation");
      });
    }
    if (widened) {
      document.getElementById("resetLoadedCommitWindowBtn")!.addEventListener("click", () => {
        this.resetLoadedCommitWindow();
      });
    }
    this.restoreFooterFocus(loading);
  }

  /** Note which footer control holds focus, so the redraw about to destroy it
   *  can put focus back on its replacement (#82). Without this a keyboard user
   *  who pressed Load More was left on `<body>` and had to Tab in from the top
   *  of the document to press it again — a silent loss, invisible to a mouse,
   *  which is why it went unreported for as long as it did.
   *
   *  Three readings of `document.activeElement`, and the second is the one
   *  that makes this state rather than a local:
   *
   *  - **A footer control.** The redraw is about to destroy it; hold its id.
   *  - **The footer itself.** Where an earlier redraw parked focus because the
   *    control it had was away — exactly what a Load More press leaves while
   *    the spinner stands in for the button. The held id stands, waiting for
   *    the redraw that brings the control back.
   *  - **Anywhere else, `<body>` included.** The user moved on, so there is
   *    nothing to put back and any held id is spent. This is what keeps a slow
   *    page from yanking focus out of wherever they went while it was out.
   *
   *  The third reading sees less than it sounds like it does, and deliberately
   *  no more is made of it: `renderTable` replaces the commit table *before* it
   *  calls `renderFooter`, so focus that was on a row, a ref chip or an inline
   *  Commit Details View file row has already fallen to `<body>` by the time
   *  this runs. That costs nothing, because those are precisely the groups
   *  {@link restoreGraphFocus} and {@link restoreCdvFileFocus} put back
   *  afterwards — and they run last, so whatever the footer did with focus, the
   *  group the user was actually in wins. What it does catch first-hand is
   *  everything outside the table: the toolbar, the Find input, a docked
   *  panel's file rows. */
  private rememberFooterFocus() {
    const active = document.activeElement;
    if (active instanceof HTMLElement && FOOTER_CONTROLS.has(active.id)) {
      this.footerFocusId = active.id;
    } else if (active !== this.footerElem) this.footerFocusId = null;
  }

  /** Put focus back on the control {@link rememberFooterFocus} named, now that
   *  the footer has been rewritten. When that control is not in the new footer,
   *  focus goes to the footer element itself.
   *
   *  **Why the footer and not the other control**, which is usually right there
   *  and pressable at once. Three reasons, any one of which decides it:
   *
   *  - A held Enter auto-repeats, and each repeat is another activation. A
   *    Load More held down until the history runs out would land on the way
   *    back and then press it, throwing away every page the user just waited
   *    for. Moving focus onto an action is moving it onto a *loaded gun*.
   *  - A screen reader announces the swap as though the user had navigated,
   *    when all they did was press the control they were already on — and the
   *    thing announced is the action that undoes theirs.
   *  - It is the only answer that covers the press which empties the footer
   *    outright (the window back at its opening count with the whole history
   *    already in). #82's complaint is `<body>`, and `<body>` is where a
   *    fallback naming the other control leaves that case.
   *
   *  The footer carries `tabindex="-1"`, so this is somewhere focus can be put
   *  but never somewhere Tab stops: Tab from here goes on to whatever follows
   *  the footer, and Shift+Tab back into the graph, exactly as it would have
   *  from the control that is gone.
   *
   *  The id is held through a *loading* redraw and spent on a settled one. The
   *  spinner has the button's place only until the page lands, so a control
   *  missing from a loading footer is coming back and focus is only parked;
   *  missing from a settled footer, it is gone and the parking is where focus
   *  stays.
   *
   *  `preventScroll`, the same as every other restoration in this file and for
   *  the same reason (ADR-0019): a redraw is not a focus *move*, so nothing may
   *  move on the user's behalf. The one redraw entitled to take the viewport
   *  with it — the loaded commit window reset — spends that in
   *  {@link restoreGraphFocus} on the row the graph now begins at, which is
   *  *not* where this leaves focus. That divergence is the trade-off
   *  {@link resetLoadedCommitWindow} already argues: the footer is at the
   *  bottom of the page, the bottom of the page is the near-the-bottom
   *  threshold, and following focus there would have automatic loading widen
   *  the window the press just shrank. A container holding no action is a
   *  cheap thing to leave off screen; a scroll that undoes the press is not. */
  private restoreFooterFocus(loading: boolean) {
    const held = this.footerFocusId;
    if (held === null) return;
    const back = document.getElementById(held);
    if (back !== null) this.footerFocusId = null;
    else if (!loading) this.footerFocusId = null;
    (back ?? this.footerElem).focus({ preventScroll: true });
  }
  /** Replace the graph with "no repositories", and drop the commits behind it.
   *
   *  Not cosmetic. {@link refresh} deliberately keeps the current graph on
   *  screen rather than blanking — it is reloading, and a blank flickers — but
   *  a panel that has just lost its repository is not reloading: nothing was
   *  requested, so nothing is coming to replace what is up. Left there, the
   *  previous repository's rows keep their listeners, and every context-menu
   *  action on them is dispatched with `repo: ""` against a host that resolves
   *  actions from its own binding rather than from the message — a live action
   *  surface aimed at a repository the panel says it is not on.
   *
   *  The state goes with the rows for the same reason: any later redraw (a
   *  remote list arriving, a column toggled) would put them straight back. */
  private renderNoRepo() {
    hideDialogAndContextMenu();
    this.commits = [];
    this.commitLookup = {};
    this.commitHead = null;
    this.moreCommitsAvailable = false;
    this.gitBranches = [];
    this.gitBranchHead = null;
    this.dimmedBranches = [];
    this.setCurrentBranches(null);
    this.invalidateBranchSearchIndex();
    this.saveState();
    this.graph.clear();
    this.tableElem.innerHTML = '<h2 id="loadingHeader">' + escapeHtml(l10n.noRepos) + "</h2>";
    this.renderFooter();
  }
  private renderShowLoading() {
    hideDialogAndContextMenu();
    this.graph.clear();
    this.tableElem.innerHTML =
      '<h2 id="loadingHeader">' + svgIcons.loading + l10n.loading + "</h2>";
    // Through renderFooter rather than blanking the element: this runs once, at
    // boot before any state is restored, where the window is still at the
    // opening count and nothing is known to be loadable — so it renders the
    // same empty footer, from the state, instead of asserting emptiness.
    this.renderFooter();
  }
  private checkoutBranchAction(refName: string, isRemote: boolean) {
    if (!isRemote) {
      showActionRunningDialog(l10n.checkoutBranch);
      sendMessage({
        command: "checkoutBranch",
        repo: this.currentRepo!,
        branchName: refName,
        remoteBranch: null,
        force: false
      });
    } else {
      // refName is "<remote>/<branch>"; strip only the remote prefix so the
      // local branch keeps the full branch path (e.g. "fix/something-1")
      // rather than just the segment after the last slash.
      const remote = this.remotes.find((r) => refName === r || refName.startsWith(r + "/"));
      const leaf = remote !== undefined ? refName.slice(remote.length + 1) : refName;
      const promptNewLocalBranch = () => {
        showRefInputDialog(
          l10n.dialogCreateBranchTitle.replace("{0}", "<b><i>" + escapeHtml(refName) + "</i></b>"),
          leaf,
          l10n.checkoutBranch,
          (newBranch) => {
            showActionRunningDialog(l10n.checkoutBranch);
            sendMessage({
              command: "checkoutBranch",
              repo: this.currentRepo!,
              branchName: newBranch,
              remoteBranch: refName,
              force: false
            });
          },
          null
        );
      };
      if (this.gitBranches.includes(leaf)) {
        // A local branch with the same name already exists: let the user check
        // it out directly, reset it to the remote (discarding local commits), or
        // create a new local branch under a different name.
        showSelectDialog(
          l10n.dialogCheckoutRemoteExists.replace("{0}", "<b><i>" + escapeHtml(leaf) + "</i></b>"),
          "existing",
          [
            { name: l10n.dialogCheckoutExistingLocal, value: "existing" },
            { name: l10n.dialogCheckoutResetLocal, value: "reset" },
            { name: l10n.dialogCheckoutNewLocal, value: "new" }
          ],
          l10n.checkoutBranch,
          (choice) => {
            if (choice === "existing") {
              showActionRunningDialog(l10n.checkoutBranch);
              sendMessage({
                command: "checkoutBranch",
                repo: this.currentRepo!,
                branchName: leaf,
                remoteBranch: null,
                force: false
              });
            } else if (choice === "reset") {
              // Destructive: confirm before discarding the local branch's commits.
              this.confirmForRepo(
                l10n.dialogCheckoutResetLocalConfirm.replace(
                  "{0}",
                  "<b><i>" + escapeHtml(leaf) + "</i></b>"
                ),
                (repo) => {
                  showActionRunningDialog(l10n.checkoutBranch);
                  sendMessage({
                    command: "checkoutBranch",
                    repo,
                    branchName: leaf,
                    remoteBranch: refName,
                    force: true
                  });
                },
                null
              );
            } else {
              promptNewLocalBranch();
            }
          },
          null,
          // Remembering "reset" is safe: that path keeps its own destructive
          // confirmation above.
          "checkoutRemoteExists"
        );
      } else {
        promptNewLocalBranch();
      }
    }
  }
  private renameBranchAction(refName: string) {
    showRefInputDialog(
      l10n.dialogRenameBranchTitle.replace("{0}", "<b><i>" + escapeHtml(refName) + "</i></b>"),
      refName,
      l10n.dialogRenameBranchSubmit,
      (newName) => {
        sendMessage({
          command: "renameBranch",
          repo: this.currentRepo!,
          oldName: refName,
          newName: newName
        });
      },
      null
    );
  }
  private deleteBranchAction(refName: string) {
    const confirmMsg = l10n.dialogDeleteConfirm
      .replace("{0}", l10n.labelBranch)
      .replace("{1}", "<b><i>" + escapeHtml(refName) + "</i></b>");
    if (this.remotes.length > 0) {
      // Offer to also delete the branch on the remote(s) it exists on.
      showFormDialog(
        confirmMsg,
        [
          {
            type: "checkbox",
            name: l10n.dialogDeleteForceDelete,
            value: this.config.dialogDeleteBranchForceDelete,
            remember: true
          },
          {
            type: "checkbox",
            name: l10n.dialogDeleteOnRemotes,
            value: false,
            remember: true
          }
        ],
        l10n.deleteBranch,
        (values) => {
          this.sendDeleteBranch(
            this.currentRepo!,
            refName,
            values[0] === "checked",
            values[1] === "checked"
          );
        },
        null,
        "deleteBranch"
      );
    } else {
      showCheckboxDialog(
        confirmMsg,
        l10n.dialogDeleteForceDelete,
        this.config.dialogDeleteBranchForceDelete,
        l10n.deleteBranch,
        (forceDelete) => {
          this.sendDeleteBranch(this.currentRepo!, refName, forceDelete, false);
        },
        null,
        "deleteBranch"
      );
    }
  }
  private rebaseOnBranchAction(refName: string) {
    this.rebaseOnAction(branchTarget(refName), this.commitOfRef(refName), null);
  }

  /**
   * The range a `rebase --onto` would replay onto `newBaseHash`, or null when
   * there is no such rebase to offer and the plain one stands (#173).
   *
   * Null on three counts: no two commits are being compared, so there is no
   * range; the new base is one of the two bounding it, and `--onto` aimed at
   * an end of its own range is a no-op or a self-copy (ADR-0022); or the new
   * base could not be placed among the loaded commits at all, so whether it is
   * one of the two cannot be told. Each leaves the menu entry saying and doing
   * what it always did, which is the answer a rebase menu owes when the range
   * is in doubt.
   *
   * The range's direction is the ancestry {@link rebaseOntoRange} reads, never
   * the order the two were CTRL-clicked.
   */
  private comparedRangeOnto(newBaseHash: string | null): RebaseOntoRange | null {
    const compared = this.comparedCommitPair();
    if (compared === null || newBaseHash === null) return null;
    if (compared[0] === newBaseHash || compared[1] === newBaseHash) return null;
    return rebaseOntoRange(compared[0], compared[1], this.commits, this.commitLookup);
  }

  /**
   * `git rebase <obj>` — replay the current branch onto `obj`, a commit the user
   * right-clicked or a branch whose label they did.
   *
   * The dialog lists `obj..HEAD`, the commits git would replay, and lets each be
   * unticked (#172). Untick nothing and the message sent is the one this action
   * always sent, field for field; untick some and the ticks pick the command
   * ({@link sendRebasePick}).
   *
   * `objHash` is where `obj` sits among the loaded commits, and null when it is
   * outside them — a branch the graph is not showing. The range is then unknown
   * rather than empty, which is what {@link RebaseReplay.incomplete} carries and
   * why a range that cannot be read leaves the rebase exactly as it was.
   *
   * `obj` arrives as raw text on both spellings ({@link RebaseTarget}); the
   * escaping each site needs is applied here.
   */
  private rebaseOnAction(
    obj: RebaseTarget,
    objHash: string | null,
    sourceElem: HTMLElement | null
  ) {
    const tipHash = this.commitHead;
    const replay: RebaseReplay =
      objHash === null || tipHash === null
        ? { commits: [], mergesSquashed: 0, strandedBranches: [], incomplete: true }
        : rebaseReplay(objHash, tipHash, this.commits, this.commitLookup);
    // `git rebase <obj>` replays `obj..HEAD` onto `obj`, so the range's lower
    // bound and its landing point are the same commit. The tip is the branch git
    // will move: the plain command names no branch and lets git use HEAD, but
    // the narrowed form has to name one, so it is resolved here and a detached
    // HEAD falls through to the interactive form.
    const range: RebasePickRange = {
      newBase: obj.value,
      upstream: obj.value,
      tip: this.gitBranchHead
    };
    // What the dialog prints, for whichever command the ticks make (ADR-0022).
    // Untouched, that is the one-argument `git rebase <obj>` this action has
    // always run; anything else is the `--onto` form, whose lower bound is
    // `obj` itself until narrowing replaces it with a commit off the list.
    const preview = (command: RebasePickCommand) =>
      rebasePickCommandHtml(
        command.kind === "none"
          ? null
          : "git rebase " +
              (this.config.signCommits ? "-S " : "") +
              (command.kind === "unchanged"
                ? obj.label
                : (command.kind === "interactive" ? "--interactive " : "") +
                  "--onto " +
                  obj.label +
                  " " +
                  (command.kind === "interactive" ? obj.label : abbrevCommit(command.upstream)) +
                  (command.tip === null ? "" : " " + command.tip))
      );
    this.confirmForRepoAndHead(
      l10n.dialogRebaseConfirm
        .replace("{0}", "<b><i>" + escapeHtml(obj.label) + "</i></b>")
        .replace("{1}", this.currentBranchLabel()) + openRebasePick(replay, range, preview),
      (repo) => {
        const command = rebasePickCommand(range.tip);
        // The list stands on a reading of `obj..HEAD` taken when the dialog
        // opened. Only a command that writes that range into itself depends on
        // it still holding — `unchanged` sends `git rebase <obj>`, which git
        // resolves for itself — so only those re-take the reading, and refuse
        // out loud when it has changed (ADR-0019).
        if (command.kind !== "unchanged" && this.commitHead !== tipHash) {
          showErrorDialog(
            l10n.dialogHeadMoved.replace("{0}", this.currentBranchLabel()),
            null,
            null
          );
          return;
        }
        sendRebasePick(repo, command, () => {
          sendMessage({ command: "rebaseOn", repo, obj: obj.value });
        });
      },
      sourceElem
    );
    bindRebasePickHandlers();
  }

  /** The loaded commit a *local* branch points at, or null when it is outside
   *  the loaded commits — which the side view's actions can reach, since its
   *  refs are not restricted to what the graph is showing.
   *
   *  Read the same way {@link branchPointsAt} reads it, `head` type included:
   *  a display ref is never an identity, because a local branch may genuinely
   *  be called `origin/main` (CONTEXT.md) and matching a remote ref by name
   *  would answer with the wrong commit — and so with the wrong replay list.
   *  Local-only costs nothing: rebase is a `refKinds: "local"` action. */
  private commitOfRef(refName: string): string | null {
    const commit = this.commits.find((c) =>
      c.refs.some((r) => r.type === "head" && r.name === refName)
    );
    return commit?.hash ?? null;
  }

  /**
   * `git rebase --onto <newBase> <upstream> <tip>` over the range the two
   * CTRL-selected commits bound (`range`), with the right-clicked commit as the
   * new base.
   *
   * The tip is handed to git as a branch name whenever a local branch points at
   * it, so that branch is what moves; with several to choose from the dialog
   * asks, and with none the rebase can only be spelled as a hash and the dialog
   * says so — git leaves HEAD detached in that case. The command is shown on
   * every path, since the range's direction was resolved for the user; while
   * the branch is still being picked it stands as a literal `<branch>`.
   *
   * `newBase` carries both spellings ({@link RebaseTarget}): an abbreviated
   * hash for a right-clicked commit, the branch's own name for a right-clicked
   * ref. Raw text on both, escaped here where a site needs HTML.
   */
  private rebaseOntoAction(
    newBase: RebaseTarget,
    range: RebaseOntoRange,
    sourceElem: HTMLElement | null
  ) {
    const replay = rebaseReplay(range.upstream, range.tip, this.commits, this.commitLookup);
    // Every branch that could stand in for the tip is a name, so this dialog
    // never reaches the detached-tip case `rebasePickCommand` guards against;
    // the tip stored here only has to be the same *kind* of tip as the one the
    // select settles on, which it is.
    const pickRange: RebasePickRange = {
      newBase: newBase.value,
      upstream: range.upstream,
      tip: range.tipBranches[0] ?? range.tip
    };
    const run = (repo: string, tip: string) => {
      sendRebasePick(repo, rebasePickCommand(tip), () => {
        sendMessage({
          command: "rebaseOnto",
          repo,
          newBase: newBase.value,
          upstream: range.upstream,
          tip
        });
      });
    };
    const confirmMsg = (tipLabel: string) =>
      fillTemplate(
        l10n.dialogRebaseOntoConfirm,
        "<b><i>" + abbrevCommit(range.from) + "</i></b>",
        "<b><i>" + tipLabel + "</i></b>",
        "<b><i>" + escapeHtml(newBase.label) + "</i></b>"
      );
    // The printed command is the whole of what is agreed to (ADR-0022), so it
    // is a function of the command the ticks make rather than a fixed line: an
    // interactive rebase and a moved lower bound are different commands, and an
    // emptied list is no command at all. The tip is the caller's, not the
    // command's, because while several branches are still in the running the
    // line carries git's `<branch>` placeholder instead of a name.
    const commandPreview = (tip: string) => (command: RebasePickCommand) =>
      rebasePickCommandHtml(
        command.kind === "none"
          ? null
          : "git rebase " +
              (this.config.signCommits ? "-S " : "") +
              (command.kind === "interactive" ? "--interactive " : "") +
              "--onto " +
              newBase.label +
              " " +
              abbrevCommit(command.kind === "onto" ? command.upstream : range.upstream) +
              " " +
              tip
      );

    if (range.tipBranches.length > 1) {
      // Several local branches sit on the tip commit and only one of them can be
      // the branch git moves, so the preview carries git's own `<branch>`
      // placeholder — the select below is what fills it.
      showSelectDialog(
        confirmMsg(abbrevCommit(range.tip)) +
          openRebasePick(replay, pickRange, commandPreview("<branch>")),
        range.tipBranches[0],
        [
          ...range.tipBranches.map((branch) => ({ name: branch, value: branch })),
          { name: l10n.dialogRebaseOntoDetachedNone, value: "" }
        ],
        l10n.dialogYesRebase,
        (branch) => run(this.currentRepo!, branch === "" ? range.tip : branch),
        sourceElem
      );
      bindRebasePickHandlers();
      return;
    }
    const branch = range.tipBranches[0];
    const tip = branch ?? range.tip;
    this.confirmForRepo(
      confirmMsg(branch !== undefined ? escapeHtml(branch) : abbrevCommit(range.tip)) +
        openRebasePick(
          replay,
          pickRange,
          commandPreview(branch !== undefined ? branch : abbrevCommit(range.tip))
        ) +
        (branch === undefined
          ? '<span class="dialogNote">' +
            escapeHtml(fillTemplate(l10n.dialogRebaseOntoDetached, abbrevCommit(range.tip))) +
            "</span>"
          : ""),
      (repo) => {
        // This dialog prints the command verbatim, branch name included, and
        // that line is the whole of what was agreed to. git resolves the name
        // when the command runs, not when it was printed, so a branch that
        // moved while the question was on screen replays a different range than
        // the one on screen. Unlike the repository, nothing here can be
        // re-aimed — the printed command would simply be false — so this one
        // refuses, and says so (ADR-0019).
        if (branch !== undefined && !this.branchPointsAt(branch, range.tip)) {
          showErrorDialog(
            l10n.dialogRebaseOntoTipMoved.replace(
              "{0}",
              "<b><i>" + escapeHtml(branch) + "</i></b>"
            ),
            null,
            null
          );
          return;
        }
        run(repo, tip);
      },
      sourceElem
    );
    bindRebasePickHandlers();
  }

  /** Whether `branch` still points at `hash`, read off the loaded commits the
   *  same way {@link rebaseOntoRange} read the tip's branches in the first
   *  place. A commit that has left the loaded window answers false: what a
   *  consent check owes is proof the premise still holds, and "cannot tell" is
   *  not that. */
  private branchPointsAt(branch: string, hash: string): boolean {
    const index = this.commitLookup[hash];
    return (
      index !== undefined &&
      this.commits[index].refs.some((r) => r.type === "head" && r.name === branch)
    );
  }
  private fastForwardBranchAction(refName: string) {
    this.confirmForRepo(
      l10n.dialogFastForwardConfirm.replace("{0}", "<b><i>" + escapeHtml(refName) + "</i></b>"),
      (repo) => {
        sendMessage({
          command: "fastForwardBranch",
          repo,
          branchName: refName
        });
      },
      null
    );
  }
  private pullRemoteBranchAction(refName: string) {
    const parts = splitDisplayRemoteRef(refName);
    if (parts === null) return;
    this.confirmForRepoAndHead(
      l10n.dialogPullConfirm
        .replace("{0}", "<b><i>" + escapeHtml(refName) + "</i></b>")
        .replace("{1}", this.currentBranchLabel()),
      (repo) => {
        sendMessage({
          command: "pullBranch",
          repo,
          remote: parts.remote,
          branchName: parts.branchOnRemote
        });
        showActionRunningDialog(l10n.pulling);
      },
      null
    );
  }
  private fetchIntoLocalBranchAction(refName: string, sourceElem: HTMLElement | null = null) {
    const parts = splitDisplayRemoteRef(refName);
    if (parts === null) return;
    showFormDialog(
      l10n.dialogFetchIntoLocalBranchTitle.replace(
        "{0}",
        "<b><i>" + escapeHtml(refName) + "</i></b>"
      ),
      [
        {
          type: "text-ref",
          name: l10n.dialogFetchIntoLocalBranchName,
          default: parts.branchOnRemote
        },
        {
          type: "checkbox",
          name: l10n.dialogFetchIntoLocalBranchForce,
          value: false,
          remember: true
        }
      ],
      l10n.dialogFetchIntoLocalBranchSubmit,
      (values) => {
        sendMessage({
          command: "fetchIntoLocalBranch",
          repo: this.currentRepo!,
          remote: parts.remote,
          remoteBranch: parts.branchOnRemote,
          localBranch: values[0],
          force: values[1] === "checked"
        });
        showActionRunningDialog(l10n.fetchingIntoLocalBranch);
      },
      sourceElem,
      "fetchIntoLocalBranch"
    );
  }
  private deleteRemoteBranchAction(refName: string) {
    const parts = splitDisplayRemoteRef(refName);
    if (parts === null) return;
    this.confirmForRepo(
      l10n.dialogDeleteRemoteBranchConfirm.replace(
        "{0}",
        "<b><i>" + escapeHtml(refName) + "</i></b>"
      ),
      (repo) => {
        sendMessage({
          command: "deleteRemoteBranch",
          repo,
          remote: parts.remote,
          branchName: parts.branchOnRemote
        });
        showActionRunningDialog(l10n.deletingRemoteBranch);
      },
      null
    );
  }
  private createPullRequestAction(refName: string, isRemote: boolean) {
    let remote = this.defaultPushRemote();
    let branch = refName;
    if (isRemote) {
      // refName is "<remote>/<branch>"; split off the remote.
      const r = this.remotes.find((rm) => refName === rm || refName.startsWith(rm + "/"));
      if (r !== undefined) {
        remote = r;
        branch = refName.slice(r.length + 1);
      }
    }
    sendMessage({
      command: "createPullRequest",
      repo: this.currentRepo!,
      branchName: branch,
      remote
    });
  }
  /** Entry point for branch actions delegated by the Branches side-view: run
   *  the exact same flow (dialogs included) as the in-graph context menu. */
  public runRefAction(msg: GG.ResponseRunRefAction) {
    if (msg.seq <= this.lastRefActionSeq) return; // duplicate delivery
    this.pendingRefAction = msg;
    this.tryRunPendingRefAction();
  }
  /** Entry point for batch branch actions delegated by the Branches side-view.
   *  Shares the sequence counter and the wait-for-load queue with the single
   *  action above, so the host's two delivery paths dedupe the same way. */
  public runRefBatchAction(msg: GG.ResponseRunRefBatchAction) {
    if (msg.seq <= this.lastRefActionSeq) return; // duplicate delivery
    this.pendingRefAction = msg;
    this.tryRunPendingRefAction();
  }
  /** Entry point for the cleanup dialog the host built. Rides the same queue and
   *  seq counter as the two above: a panel still loading would otherwise drop
   *  the message, and the host delivers over two paths to cover that
   *  (ADR-0017). */
  public showBranchCleanup(msg: GG.ResponseShowBranchCleanup) {
    if (msg.seq <= this.lastRefActionSeq) return; // duplicate delivery
    this.pendingRefAction = msg;
    this.tryRunPendingRefAction();
  }
  /** Run the pending delegated action once this view shows its repo with no
   *  load in flight (a fresh panel / repo switch reloads branches+commits; the
   *  remotes for that repo arrive before them, as requests are handled in
   *  order). Re-tried after each load completes. */
  private tryRunPendingRefAction() {
    const pending = this.pendingRefAction;
    if (pending === null || pending.repo !== this.currentRepo) return;
    if (this.branchLoadInFlight || this.commitLoadInFlight) return;
    this.pendingRefAction = null;
    this.lastRefActionSeq = pending.seq;
    if (pending.command === "runRefBatchAction") this.dispatchRefBatchAction(pending);
    else if (pending.command === "showBranchCleanup") {
      openCleanupDialog(pending.repo, pending.payload);
    } else this.dispatchRefAction(pending);
  }
  /** One handler per delegated action, keyed by the catalogue-derived union —
   *  a new catalogue entry fails compilation here until it is handled, so a
   *  silent no-op cannot be expressed (ADR-0010). Handlers take the display
   *  ref (what the in-graph menu's actions eat); the remote/local split, where
   *  an action has one, comes off the canonical ref's prefix. The head guard
   *  is the host's, applied before the message was ever sent. */
  private readonly refActionHandlers: Record<
    GG.RefAction,
    (ref: string, isRemote: boolean, repo: string) => void
  > = {
    checkout: (ref, isRemote) => this.checkoutBranchAction(ref, isRemote),
    rename: (ref) => this.renameBranchAction(ref),
    delete: (ref, isRemote) =>
      isRemote ? this.deleteRemoteBranchAction(ref) : this.deleteBranchAction(ref),
    merge: (ref) => this.mergeBranchAction(ref),
    // Always the plain rebase, even while the graph has two commits compared
    // (#173). The side-view's own label is a static package.json title and
    // cannot change with the graph's selection, and the gesture that turns the
    // in-graph entry into a range replay — CTRL-comparing two rows — is only
    // visible in the graph. A menu raised where neither the label nor the
    // selection can be seen must do what its label says.
    rebase: (ref) => this.rebaseOnBranchAction(ref),
    fastForward: (ref) => this.fastForwardBranchAction(ref),
    push: (ref) => this.pushBranchAction(ref),
    createArchive: (ref, _isRemote, repo) => sendMessage({ command: "createArchive", repo, ref }),
    createPullRequest: (ref, isRemote) => this.createPullRequestAction(ref, isRemote),
    pull: (ref) => this.pullRemoteBranchAction(ref),
    fetchIntoLocal: (ref) => this.fetchIntoLocalBranchAction(ref),
    deleteRemote: (ref) => this.deleteRemoteBranchAction(ref),
    checkRedundancy: (ref, _isRemote, repo) => requestBranchRedundancy(repo, ref)
  };
  private dispatchRefAction(msg: GG.ResponseRunRefAction) {
    // Only this side knows the remotes, so this one guard cannot move to the host.
    if (REF_ACTION_CATALOGUE[msg.action].needsRemotes && this.remotes.length === 0) return;
    this.refActionHandlers[msg.action](
      displayRef(msg.ref),
      msg.ref.startsWith(REMOTE_PREFIX),
      msg.repo
    );
  }
  /** The batch counterpart of {@link refActionHandlers} — same total-record
   *  guarantee over the delegated batch actions. */
  private readonly refBatchActionHandlers: Record<
    GG.DelegatedBatchAction,
    (targets: string[], skipped: GG.BatchSkipped[]) => void
  > = {
    delete: (targets, skipped) => this.deleteBranchesAction(targets, skipped),
    push: (targets, skipped) => this.pushBranchesAction(targets, skipped),
    fastForward: (targets, skipped) => this.fastForwardBranchesAction(targets, skipped)
  };
  /** Run a batch action delegated by the Branches side-view. The dialogs are
   *  written for the batch rather than replaying a single-branch dialog N times:
   *  one confirmation for the whole set, and — for delete — one force round at
   *  the end instead of a prompt per branch (ADR-0009). */
  private dispatchRefBatchAction(msg: GG.ResponseRunRefBatchAction) {
    // The host reports an empty target set itself, and never sends one.
    if (msg.targets.length === 0) return;
    if (REF_ACTION_CATALOGUE[msg.action].needsRemotes && this.remotes.length === 0) return;
    this.refBatchActionHandlers[msg.action](msg.targets, msg.skipped);
  }
  /** Refs as the bolded, remote-prefix-free names the rest of the dialogs use. */
  private batchRefNames(refs: string[]): string {
    return refs.map((r) => "<b><i>" + escapeHtml(displayRef(r)) + "</i></b>").join(", ");
  }
  /** A batch confirmation body: the count-bearing question, every branch it will
   *  touch, and — never silently — the selected branches it will not. */
  private batchConfirmBody(
    template: string,
    targets: string[],
    skipped: GG.BatchSkipped[]
  ): string {
    const note = (noteTemplate: string, reason: GG.BatchSkipped["reason"]) => {
      const refs = skipped.filter((s) => s.reason === reason).map((s) => s.ref);
      return refs.length === 0
        ? ""
        : "<br><br>" + noteTemplate.replace("{0}", this.batchRefNames(refs));
    };
    return (
      template.replace("{0}", String(targets.length)) +
      "<br>" +
      this.batchRefNames(targets) +
      note(l10n.dialogBatchSkippedCheckedOut, "checkedOut") +
      note(l10n.dialogBatchSkippedRemote, "remote")
    );
  }
  /** What one batch action needs to execute its run's commands: how to send a
   *  round, what to show while it runs, how to title a failed summary, and —
   *  for actions with a retry round — the retry confirmation's body. */
  private batchSpec(action: BatchActionKind): {
    send: (refs: string[], round: 1 | 2, params: unknown) => void;
    running: string;
    errorTitle: string;
    retryBody?: (refs: string[]) => string;
  } {
    switch (action) {
      case "deleteBranches":
        return {
          send: (refs, round, params) => {
            const p = params as BatchParams & { forceDelete: boolean; deleteOnRemotes: boolean };
            sendMessage({
              command: "deleteBranches",
              repo: p.repo,
              refs,
              // The retry round exists to force what round 1 could not delete.
              forceDelete: round === 2 || p.forceDelete,
              deleteOnRemotes: p.deleteOnRemotes
            });
          },
          running: l10n.deletingBranches,
          errorTitle: l10n.unableToDeleteBranch,
          retryBody: (refs) =>
            l10n.dialogDeleteBatchForceConfirm.replace("{0}", String(refs.length)) +
            "<br>" +
            this.batchRefNames(refs)
        };
      case "pushBranches":
        return {
          send: (refs, _round, params) => {
            const p = params as BatchParams & {
              remotes: string[];
              forceMode: "normal" | "force" | "forceWithLease";
            };
            sendMessage({
              command: "pushBranches",
              repo: p.repo,
              branchNames: refs,
              remotes: p.remotes,
              forceMode: p.forceMode
            });
          },
          running: l10n.pushingBranch,
          errorTitle: l10n.unableToPushBranch
        };
      case "fastForwardBranches":
        return {
          send: (refs, _round, params) => {
            sendMessage({
              command: "fastForwardBranches",
              repo: (params as BatchParams).repo,
              branchNames: refs
            });
          },
          running: l10n.fastForwardingBranches,
          errorTitle: l10n.unableToFastForward
        };
    }
  }
  /** Start one batch run and execute its first command. The action tag feeds
   *  the run and the command executor from the one argument, so the two can
   *  never drift apart.
   *
   *  `repo` rides in the run's echoed `params` rather than being read at send
   *  time, because a run outlives two waits: the host round-trip for round 1,
   *  and the retry confirmation between the rounds. `params` exists for exactly
   *  this — "no adapter state has to survive between rounds" — and the
   *  repository is adapter state that must (ADR-0019, and see
   *  {@link confirmForRepo} for why it is carried rather than re-read).
   *
   *  There is deliberately no guard here for "a retry offer is still on
   *  screen", though `BatchRun.start` treating a standing `offeringRetry` as an
   *  ended run would otherwise make one look necessary — the reachability the
   *  guard would answer is the reason #127 and #141 were raised, and it is real
   *  as a *gesture*: the context menu sits above the dialog and stays
   *  clickable, and background controls stay tabbable behind it, so the user
   *  can absolutely reach for a second batch with the offer in front of them.
   *  What they cannot do is arrive *here* that way. Every caller below is
   *  inside a dialog's own action callback, because ADR-0009 sends exactly the
   *  batch actions that ask through the webview, so each one raises its
   *  question first — and raising it is what writes over the offer and
   *  abandons the run (see {@link abandonBatchRun}). By the time a start is
   *  reached the offer is gone and the run really is over, which is the state
   *  `BatchRun.start` then reads. A guard here would never fire. */
  private startBatchRun(
    action: BatchActionKind,
    repo: string,
    targets: string[],
    options: Omit<BatchRunOptions<BatchActionKind>, "action" | "params"> & { params?: object } = {}
  ) {
    this.runBatchCommand(
      this.batchRun.start(targets, { ...options, action, params: { ...options.params, repo } }),
      action
    );
  }
  /** Execute one BatchRun command, re-entering as the retry dialog resolves.
   *  All round state lives in the run; this only performs its side effects. */
  private runBatchCommand(command: BatchRunCommand<BatchActionKind>, action: BatchActionKind) {
    const spec = this.batchSpec(action);
    switch (command.kind) {
      case "send":
        spec.send(command.refs, command.round, command.params);
        showActionRunningDialog(spec.running);
        break;
      case "offerRetry":
        // No repo capture here: the run already carries the one its first round
        // was started for, and hands it back on the retry round's `send`.
        showConfirmationDialog(
          // `#batchRetryOffer` marks this dialog as an unanswered retry offer,
          // the way `#actionRunning` marks a progress dialog. It is a mark in
          // the dialog's own markup rather than a flag beside it because that
          // is what makes it un-stale-able: `showDialog` and `hideDialog` both
          // destroy it by destroying the dialog, so it is present exactly while
          // the question is on screen with neither answer given.
          '<span id="batchRetryOffer">' + (spec.retryBody?.(command.refs) ?? "") + "</span>",
          () => this.runBatchCommand(this.batchRun.onRetryConfirmed(), action),
          null,
          // Declining the retry round still ends a batch that did real work, so
          // report what the first round managed rather than closing in silence.
          () => this.runBatchCommand(this.batchRun.onRetryDeclined(), action)
        );
        break;
      case "summarise":
        this.reportBatchResults(command.results, spec.errorTitle);
        break;
      case "busy":
        showErrorDialog(l10n.dialogBatchBusy, null, null);
        break;
      case "none":
        break;
    }
  }
  /** Feed a batch action's response to the run in flight. */
  public handleBatchActionResponse(action: BatchActionKind, results: BatchRefResult[]) {
    this.runBatchCommand(this.batchRun.onResults(results, action), action);
  }
  /** End the run whose retry offer has just been written over, and keep what
   *  its first round did until there is a screen to say it on.
   *
   *  Called from {@link showDialog} whenever a dialog is raised over a standing
   *  `#batchRetryOffer` — the offer's two answers both close it themselves, so
   *  arriving here means neither was given and nobody is going to give one.
   *  Without this the run holds the single in-flight slot for the life of the
   *  panel (`BatchRun.start`'s backstop then catches it, but only by dropping
   *  these results on the floor).
   *
   *  The summary is *owed*, not shown. The dialog arriving over the offer keeps
   *  the screen, because the route this exists for is `tryRunPendingRefAction`,
   *  which has already taken its delegated action off `pendingRefAction` before
   *  dispatching it — writing over that confirmation would lose a request the
   *  user made outright, the same harm this ticket is about pointed the other
   *  way. But a summary shown into a slot that is about to be overwritten is a
   *  summary nobody reads, which is the silent drop this exists to prevent. So
   *  it waits: {@link deliverOwedBatchSummary} raises it at the first moment
   *  the slot is free. Only *why* each ref failed waits — the refresh below
   *  happens now, because the graph is worth putting right at the moment the
   *  run ends, and it can show which branches went but never why the rest
   *  stayed. */
  public abandonBatchRun() {
    const command = this.batchRun.abandon();
    // `none` is the ordinary case, not a defensive one: the offer's markup is
    // still up while its own summary is raised, so this re-enters once.
    if (command.kind !== "summarise" || command.action === null) return;
    this.owedSummary = { results: command.results, action: command.action };
    this.refresh(false);
  }
  /** Raise a summary that had nowhere to go when its run ended.
   *
   *  Queued from {@link hideDialog} — the one place the dialog slot is emptied
   *  — and run as a microtask, so that whatever the closing route does *next*
   *  has already had its turn: a Yes that fires off the next action and raises
   *  its progress dialog, a dismissal hook that opens a dialog of its own. If
   *  one of those claimed the slot, the summary stays owed and waits for the
   *  next close.
   *
   *  It is deliberately not hung off `dialogDismissAction`. That hook cannot
   *  tell a dialog the user dismissed from one the webview took away (#134),
   *  and a summary owed is owed whichever of those happened. What this waits
   *  for is the slot, not anyone's dismissal.
   *
   *  If the panel never frees the slot the summary is never shown, and it does
   *  not survive a reload. That is the accepted floor: the run is already
   *  ended, the graph was already refreshed, and what is lost is the reason
   *  each remaining ref failed — the same thing that was lost unconditionally
   *  before, now only in the case where the user never closes another dialog. */
  public deliverOwedBatchSummary() {
    const owed = this.owedSummary;
    if (owed === null || isDialogOpen()) return;
    this.owedSummary = null;
    this.reportBatchResults(owed.results, this.batchSpec(owed.action).errorTitle);
  }
  private deleteBranchesAction(targets: string[], skipped: GG.BatchSkipped[]) {
    const inputs: DialogInput[] = [
      {
        type: "checkbox",
        name: l10n.dialogDeleteForceDelete,
        value: this.config.dialogDeleteBranchForceDelete
      }
    ];
    // Only worth offering when there is a remote to delete on.
    if (this.remotes.length > 0) {
      inputs.push({ type: "checkbox", name: l10n.dialogDeleteOnRemotes, value: false });
    }
    // No remember key: a batch delete is confirmed from scratch every time.
    showFormDialog(
      this.batchConfirmBody(l10n.dialogDeleteBatchConfirm, targets, skipped),
      inputs,
      l10n.deleteBranches,
      (values) =>
        this.startBatchRun("deleteBranches", this.currentRepo!, targets, {
          // The one classification the host makes more reliably than us: a
          // refusal a force round can fix.
          retryWhen: (r) => (r as BatchDeleteResult).notFullyMerged,
          params: {
            forceDelete: values[0] === "checked",
            deleteOnRemotes: inputs.length > 1 && values[1] === "checked"
          }
        }),
      null
    );
  }
  /** The cleanup dialog's own confirmation is the only one (ADR-0017), so it
   *  starts the run directly — but through the same `BatchRun` and the same
   *  `deleteBranches` request as the side-view's batch delete, force round and
   *  summary included. Only the question in front of it differs. */
  public startCleanupDelete(
    repo: string,
    refs: string[],
    params: { forceDelete: boolean; deleteOnRemotes: boolean }
  ) {
    // The dialog carries the repo its candidates were computed for, and the
    // delete goes to that one — the shape every confirmation uses, see
    // {@link confirmForRepo}. This used to refuse instead, which left "pressed
    // Delete, nothing happened" whenever the host had posted `setRepo` in the
    // meantime.
    this.startBatchRun("deleteBranches", repo, refs, {
      retryWhen: (r) => (r as BatchDeleteResult).notFullyMerged,
      params
    });
  }
  /** Read by the cleanup dialog for its one delete option's default. */
  public dialogDeleteBranchForceDelete(): boolean {
    return this.config.dialogDeleteBranchForceDelete;
  }
  private pushBranchesAction(targets: string[], skipped: GG.BatchSkipped[]) {
    // No remember key: a force mode remembered from a single push must not
    // silently apply to a batch, where it would rewrite several branches at once.
    this.showPushForm(
      {
        oneRemote: this.batchConfirmBody(l10n.dialogPushBatchConfirm, targets, skipped),
        manyRemotes: this.batchConfirmBody(l10n.dialogPushBatchSelectRemote, targets, skipped)
      },
      undefined,
      (remotes, forceMode) => {
        if (remotes.length === 0) return;
        this.startBatchRun("pushBranches", this.currentRepo!, targets, {
          params: { remotes, forceMode }
        });
      }
    );
  }
  private fastForwardBranchesAction(targets: string[], skipped: GG.BatchSkipped[]) {
    this.confirmForRepo(
      this.batchConfirmBody(l10n.dialogFastForwardBatchConfirm, targets, skipped),
      (repo) => this.startBatchRun("fastForwardBranches", repo, targets),
      null
    );
  }
  /** Summarise a finished batch. Failures are collected into one dialog listing
   *  each ref and its git error — one dialog per failed ref would punish exactly
   *  the case the batch exists to make cheap. */
  public reportBatchResults(results: BatchRefResult[], errorTitle: string) {
    const failed = results.filter((r) => r.status !== null);
    if (failed.length === 0) {
      this.refresh(true, true); // keep the scroll position, as single actions do
      return;
    }
    showErrorDialog(
      errorTitle +
        "<br>" +
        l10n.dialogBatchResult
          .replace("{0}", String(results.length - failed.length))
          .replace("{1}", String(failed.length)),
      failed.map((r) => displayRef(r.ref) + ": " + r.status).join("\n"),
      null,
      () => this.refresh(false)
    );
  }
  /** Display label for the checked-out branch in dialogs: its actual name when
   *  on a branch, or the generic "current branch" wording when detached. */
  private currentBranchLabel(): string {
    return branchLabel(this.gitBranchHead);
  }

  /* Binding a dialog's premises to the moment of consent — ADR-0019 */

  /** The loaded commit a stash selector currently points at, if any.
   *
   *  One lookup for both readers of it, because they are two halves of the same
   *  fact: the rename dialog pre-fills from this node's message, and the drop
   *  confirmation carries this node's hash across the wait as the premise its
   *  `stash@{n}` stands on. Two copies would let the second reader drift off
   *  what the first one meant by "this stash". */
  private stashNodeFor(selector: string): GitCommitNode | undefined {
    return this.commits.find((c) => c.refs.some((r) => r.type === "stash" && r.name === selector));
  }

  /**
   * Open a confirmation whose deferred half acts on the repository the question
   * was *about*, rather than on whichever repository is current by the time it
   * is answered.
   *
   * `currentRepo` can move underneath an open dialog: the host posts `setRepo`
   * when the native Source Control view's focused repo changes, and that
   * dismisses nothing. A callback that reads `this.currentRepo` after the user
   * has answered is therefore reading a fact younger than the consent it acts
   * on — ADR-0019's "the guard and the state change must not have a wait
   * between them", seen from the other side: the reading has to be taken where
   * the consent was given, and carried across the wait.
   *
   * Sending to the captured repo rather than refusing is deliberate. The user
   * agreed to act on repo A, the dialog's own wording described A, and the
   * switch was not their doing; doing A is what honours the answer. Refusing
   * would leave "pressed Yes, nothing happened" — the half-done state the same
   * ADR rules out.
   *
   * Every confirmation whose action carries a repo goes through here, so the
   * next reader finds one shape rather than a captured one and a refusing one
   * side by side.
   */
  private confirmForRepo(
    message: string,
    confirmed: (repo: string) => void,
    sourceElem: HTMLElement | null
  ) {
    const repo = this.currentRepo!;
    showConfirmationDialog(message, () => confirmed(repo), sourceElem);
  }

  /**
   * The same, for the actions git aims at HEAD — pull, and the two rebases that
   * replay onto the current branch. Their dialogs name the checked-out branch
   * ({@link currentBranchLabel}) but the command carries no branch at all, so a
   * `git checkout` in the terminal — reaching the webview through the file
   * watcher, mid-dialog — silently repoints the whole action.
   *
   * These cannot use the capture above: you cannot pull into, or rebase, a
   * branch that is not checked out. Refusing is the only faithful answer, so it
   * has to be a refusal the user can *see* — the precedent is
   * `dialogBatchBusy`, an error dialog raised when state moved under an action.
   * A silent return here would be indistinguishable from a dead button, on an
   * action whose damage is history-rewriting.
   */
  private confirmForRepoAndHead(
    message: string,
    confirmed: (repo: string) => void,
    sourceElem: HTMLElement | null
  ) {
    const head = this.gitBranchHead;
    this.confirmForRepo(
      message,
      (repo) => {
        // The repo is checked *first*, and a repo that moved is itself a
        // refusal. `gitBranchHead` is one scalar for whichever repo is on
        // screen, not a per-repo fact: once the host has switched repos and the
        // new branch list has landed, it is another repository's answer, and it
        // agrees or disagrees with `head` by coincidence. Two repos both on
        // `main` would let this through having verified nothing at all.
        //
        // So this is the same rule as {@link branchPointsAt}: what cannot be
        // shown to still hold has not been shown to still hold. It is also why
        // these three sites do not follow `confirmForRepo`'s "send it to the
        // captured repo anyway" — that answer needs a premise about the
        // captured repo, and a repo switch is exactly what takes it away.
        if (this.currentRepo !== repo || this.gitBranchHead !== head) {
          showErrorDialog(l10n.dialogHeadMoved.replace("{0}", branchLabel(head)), null, null);
          return;
        }
        confirmed(repo);
      },
      sourceElem
    );
  }
  /** Merge `branchName` (a local or remote branch) into the current branch,
   *  prompting for the no-fast-forward / squash / no-commit options. */
  private mergeBranchAction(branchName: string) {
    showFormDialog(
      l10n.dialogMergeConfirm
        .replace("{0}", "<b><i>" + escapeHtml(branchName) + "</i></b>")
        .replace("{1}", this.currentBranchLabel()) +
        conflictPredictionPlaceholder(this.currentRepo!, branchName),
      [
        {
          type: "checkbox",
          name: l10n.dialogMergeNoFastForward,
          value: this.config.dialogMergeNoFastForward,
          remember: true
        },
        {
          type: "checkbox",
          name: l10n.dialogMergeSquash,
          value: this.config.dialogMergeSquash,
          remember: true
        },
        { type: "checkbox", name: l10n.dialogMergeNoCommit, value: false, remember: true }
      ],
      l10n.dialogYesMerge,
      (values) => {
        sendMessage({
          command: "mergeBranch",
          repo: this.currentRepo!,
          branchName,
          createNewCommit: values[0] === "checked",
          squash: values[1] === "checked",
          noCommit: values[2] === "checked"
        });
      },
      null,
      "merge"
    );
  }
  /** Push a local branch to a remote. Pushes directly when a single remote
   *  exists, otherwise prompts which remote to push to. Only invoked when at
   *  least one remote is configured. */
  /** Preferred default remote to push to: the repo's configured
   *  remote.pushDefault when it is one of the available remotes, otherwise
   *  "origin" if present, else the first remote. */
  private defaultPushRemote(): string {
    if (this.pushDefault !== null && this.remotes.includes(this.pushDefault)) {
      return this.pushDefault;
    }
    return this.remotes.includes("origin") ? "origin" : this.remotes[0];
  }
  /**
   * The push form: a force-mode select, preceded by one checkbox per remote when
   * there is more than one (the push-default remote pre-checked). `bodies` picks
   * the wording for each of those two shapes, since only the caller knows
   * whether it is pushing one branch or several.
   *
   * `rememberKey` is undefined for the batch, where a force mode remembered from
   * a single push must not silently apply to several branches at once.
   */
  private showPushForm(
    bodies: { oneRemote: string; manyRemotes: string },
    rememberKey: string | undefined,
    push: (remotes: string[], forceMode: "normal" | "force" | "forceWithLease") => void
  ) {
    const forceInput: DialogSelectInput = {
      type: "select",
      name: l10n.dialogPushForce,
      default: "normal",
      options: [
        { name: l10n.dialogPushForceNone, value: "normal" },
        { name: l10n.dialogPushForceForce, value: "force" },
        { name: l10n.dialogPushForceLease, value: "forceWithLease" }
      ],
      remember: rememberKey !== undefined
    };
    if (this.remotes.length === 1) {
      showFormDialog(
        bodies.oneRemote,
        [forceInput],
        l10n.pushBranch,
        (values) => push([this.remotes[0]], toPushForceMode(values[0])),
        null,
        rememberKey
      );
      return;
    }
    const remoteInputs: DialogInput[] = this.remotes.map((r) => ({
      type: "checkbox",
      name: r,
      value: r === this.defaultPushRemote()
    }));
    showFormDialog(
      bodies.manyRemotes,
      [...remoteInputs, forceInput],
      l10n.pushBranch,
      (values) =>
        push(
          this.remotes.filter((_, i) => values[i] === "checked"),
          toPushForceMode(values[this.remotes.length])
        ),
      null,
      rememberKey
    );
  }
  private pushBranchAction(branchName: string) {
    const boldName = "<b><i>" + escapeHtml(branchName) + "</i></b>";
    this.showPushForm(
      {
        oneRemote: l10n.dialogPushBranchConfirm.replace("{0}", boldName),
        manyRemotes: l10n.dialogPushBranchSelectRemote.replace("{0}", boldName)
      },
      "pushBranchForce",
      (remotes, forceMode) => {
        if (remotes.length === 0) return;
        sendMessage({
          command: "pushBranch",
          repo: this.currentRepo!,
          branchName,
          remotes,
          forceMode
        });
        showActionRunningDialog(l10n.pushingBranch);
      }
    );
  }
  /** Push a tag to a remote. Confirms when a single remote exists, otherwise
   *  prompts which remote to push to. Only invoked when a remote is configured. */
  private pushTagAction(tagName: string) {
    const push = (repo: string, remotes: string[]) => {
      if (remotes.length === 0) return;
      sendMessage({ command: "pushTag", repo, tagName, remotes });
      showActionRunningDialog(l10n.pushingTag);
    };
    const chooseRemoteAndPush = () => {
      if (this.remotes.length === 1) {
        this.confirmForRepo(
          l10n.dialogPushTagConfirm.replace("{0}", "<b><i>" + escapeHtml(tagName) + "</i></b>"),
          (repo) => {
            // Re-taken here rather than read into the closure above, because
            // the sole remote can be removed while this question is on screen
            // and `push`'s own emptiness check cannot catch what that leaves:
            // `[this.remotes[0]]` is `[undefined]`, which has length 1 and
            // sails through, pushing the tag to no remote at all (ADR-0019).
            //
            // Reported rather than returned silently. `push`'s own empty check
            // is silent because reaching it means the user unticked every
            // remote — they asked for nothing. Here they asked for something
            // and it cannot be delivered, which is the case
            // {@link confirmForRepoAndHead} refuses out loud.
            const remote = this.remotes[0];
            if (remote === undefined) {
              showErrorDialog(l10n.dialogPushRemoteGone, null, null);
              return;
            }
            push(repo, [remote]);
          },
          null
        );
      } else {
        // One checkbox per remote so the tag can be pushed to several.
        const remoteInputs: DialogInput[] = this.remotes.map((r) => ({
          type: "checkbox",
          name: r,
          value: r === this.defaultPushRemote()
        }));
        showFormDialog(
          l10n.dialogPushTagSelectRemote.replace(
            "{0}",
            "<b><i>" + escapeHtml(tagName) + "</i></b>"
          ),
          remoteInputs,
          l10n.pushTag,
          (values) =>
            push(
              this.currentRepo!,
              this.remotes.filter((_, i) => values[i] === "checked")
            ),
          null
        );
      }
    };
    // Warn first if the tagged commit isn't on any remote branch — pushing the
    // tag would publish a commit that isn't otherwise reachable on the remote.
    if (this.tagCommitOnRemote(tagName)) {
      chooseRemoteAndPush();
    } else {
      showConfirmationDialog(
        l10n.dialogPushTagNotOnRemote.replace("{0}", "<b><i>" + escapeHtml(tagName) + "</i></b>"),
        chooseRemoteAndPush,
        null
      );
    }
  }
  /**
   * Wires up column resizing on the freshly-rendered header row, and sizes the
   * graph column to the graph.
   *
   * Returns that sizing as a write to be run later rather than doing it here.
   * The auto-laid-out branch has to *measure* the column before it can size it,
   * and that measurement is the redraw's first layout — unavoidable, the table
   * has just entered the document. Doing the write here, though, dirtied layout
   * again before `renderGraph` measured the two heights it derives `grid.y`
   * from, so the browser laid every row out a second time.
   *
   * Holding it back changes what those two heights are only if they depend on
   * it, and they do not. Measured rather than argued, at 3000 rows and in both
   * label-alignment modes: with the padding and without it, `#tableColHeaders`
   * is 31px and the table body 36031px.
   *
   * Worth knowing *why*, because the obvious reason is wrong. `padding` is a
   * shorthand, so this write also zeroes the cell's vertical padding and the
   * cell genuinely changes height (30px to 18px). The row does not: its height
   * comes from the description header, which keeps its 6px and is the taller
   * cell either way. Nor does an expanded Commit Details View, whose row height
   * is fixed in CSS and whose panels are absolutely positioned — that row is
   * the one place cells are not `nowrap`. See {@link render}.
   */
  private makeTableResizable(): () => void {
    let colHeadersElem = document.getElementById("tableColHeaders")!,
      cols = <HTMLCollectionOf<HTMLElement>>document.getElementsByClassName("tableColHeader");
    // `?.`, because this runs on a redraw and a redraw does not imply a
    // repository: a panel the host could offer no live repo to keeps the graph
    // it had on screen ({@link refresh} does not blank), and there is then no
    // state to read widths from. Unguarded this threw here — inside
    // `renderTable`, *after* `innerHTML` had already been replaced — so the
    // rows were on screen with none of the listeners below this line attached,
    // and clicking one did nothing at all.
    let columnWidths = this.gitRepos[this.currentRepo]?.columnWidths ?? null,
      mouseX = -1,
      col = -1;

    const makeTableFixedLayout = () => {
      if (columnWidths !== null) {
        cols[0].style.width = columnWidths[0] + "px";
        cols[0].style.padding = "";
        cols[2].style.width = columnWidths[1] + "px";
        cols[3].style.width = columnWidths[2] + "px";
        cols[4].style.width = columnWidths[3] + "px";
        this.tableElem.className = "fixedLayout";
        this.graph.limitMaxWidth(columnWidths[0] + 16);
      }
    };
    const stopResizing = () => {
      if (col === -1 || columnWidths === null) return;
      // The drag ends either way — releasing the mouse must always put the
      // header back — and only the persistence depends on there being a repo
      // to persist against.
      col = -1;
      mouseX = -1;
      colHeadersElem.classList.remove("resizing");
      const repoState = this.gitRepos[this.currentRepo];
      if (repoState === undefined) return;
      repoState.columnWidths = columnWidths;
      sendMessage({
        command: "saveRepoState",
        repo: this.currentRepo,
        state: repoState
      });
    };

    for (let i = 0; i < cols.length; i++) {
      cols[i].innerHTML +=
        (i > 0 ? '<span class="resizeCol left" data-col="' + (i - 1) + '"></span>' : "") +
        (i < cols.length - 1 ? '<span class="resizeCol right" data-col="' + i + '"></span>' : "");
    }
    let applyGraphColumnWidth: () => void;
    if (columnWidths !== null) {
      makeTableFixedLayout();
      // Stored widths need no measurement, so this branch has nothing to hold
      // back — and never had the second layout the other branch paid for.
      applyGraphColumnWidth = () => {};
    } else {
      this.tableElem.className = "autoLayout";
      // On narrow auto-laid-out views, cap the graph column at a third of the
      // viewport so a wide graph doesn't crowd out the other columns.
      const maxGraphWidth = Math.round(window.innerWidth / 3);
      let graphWidth = this.graph.getWidth() + 16;
      if (graphWidth > maxGraphWidth) {
        this.graph.limitMaxWidth(maxGraphWidth);
        graphWidth = maxGraphWidth;
      } else {
        this.graph.limitMaxWidth(-1);
      }
      const graphColumn = cols[0];
      const padding =
        "0 " + Math.round((Math.max(graphWidth, 64) - (graphColumn.offsetWidth - 24)) / 2) + "px";
      applyGraphColumnWidth = () => {
        graphColumn.style.padding = padding;
      };
    }

    addListenerToClass("resizeCol", "mousedown", (e) => {
      col = parseInt((<HTMLElement>e.target).dataset.col!);
      mouseX = (<MouseEvent>e).clientX;
      if (columnWidths === null) {
        columnWidths = [
          cols[0].clientWidth - 24,
          cols[2].clientWidth - 24,
          cols[3].clientWidth - 24,
          cols[4].clientWidth - 24
        ];
        makeTableFixedLayout();
      }
      colHeadersElem.classList.add("resizing");
    });
    colHeadersElem.addEventListener("mousemove", (e) => {
      if (col > -1 && columnWidths !== null) {
        let mouseEvent = <MouseEvent>e;
        let mouseDeltaX = mouseEvent.clientX - mouseX;
        switch (col) {
          case 0:
            if (columnWidths[0] + mouseDeltaX < 40) mouseDeltaX = -columnWidths[0] + 40;
            if (cols[1].clientWidth - mouseDeltaX < 64) mouseDeltaX = cols[1].clientWidth - 64;
            columnWidths[0] += mouseDeltaX;
            cols[0].style.width = columnWidths[0] + "px";
            this.graph.limitMaxWidth(columnWidths[0] + 16);
            break;
          case 1:
            if (cols[1].clientWidth + mouseDeltaX < 64) mouseDeltaX = -cols[1].clientWidth + 64;
            if (columnWidths[1] - mouseDeltaX < 40) mouseDeltaX = columnWidths[1] - 40;
            columnWidths[1] -= mouseDeltaX;
            cols[2].style.width = columnWidths[1] + "px";
            break;
          default:
            if (columnWidths[col - 1] + mouseDeltaX < 40) mouseDeltaX = -columnWidths[col - 1] + 40;
            if (columnWidths[col] - mouseDeltaX < 40) mouseDeltaX = columnWidths[col] - 40;
            columnWidths[col - 1] += mouseDeltaX;
            columnWidths[col] -= mouseDeltaX;
            cols[col].style.width = columnWidths[col - 1] + "px";
            cols[col + 1].style.width = columnWidths[col] + "px";
        }
        mouseX = mouseEvent.clientX;
      }
    });
    colHeadersElem.addEventListener("mouseup", stopResizing);
    colHeadersElem.addEventListener("mouseleave", stopResizing);

    return applyGraphColumnWidth;
  }

  /* Observers */
  private observeWindowSizeChanges() {
    let windowWidth = window.outerWidth,
      windowHeight = window.outerHeight;
    window.addEventListener("resize", () => {
      if (windowWidth === window.outerWidth && windowHeight === window.outerHeight) {
        this.renderGraph();
      } else {
        windowWidth = window.outerWidth;
        windowHeight = window.outerHeight;
      }
    });
  }
  private observeWebviewStyleChanges() {
    let fontFamily = getVSCodeStyle("--vscode-editor-font-family");
    // Only honour the theme's text-selection colour when it actually defines one
    //; otherwise the browser default selection highlight is used.
    const updateSelectionBackground = () => {
      document.body.classList.toggle(
        "selection-background-color-exists",
        getVSCodeStyle("--vscode-selection-background") !== ""
      );
    };
    updateSelectionBackground();
    new MutationObserver(() => {
      let ff = getVSCodeStyle("--vscode-editor-font-family");
      if (ff !== fontFamily) {
        fontFamily = ff;
      }
      updateSelectionBackground();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
  }
  private observeWebviewScroll() {
    let active = window.scrollY > 0;
    this.scrollShadowElem.className = active ? "active" : "";
    document.addEventListener("scroll", () => {
      if (active !== window.scrollY > 0) {
        active = window.scrollY > 0;
        this.scrollShadowElem.className = active ? "active" : "";
      }
      // Infinite scroll: load the next page once the user nears the bottom.
      //
      // Neither throttled nor passive, in both cases deliberately: see
      // ADR-0020's rejected alternatives for the throttling measurement, which
      // is not restated here. `{ passive: true }` is the other one — `scroll`
      // is not cancelable, so it has nothing to promise; the cost was always
      // the measurement below, never the listener's right to block.
      //
      // Not while a dialog is up. `#dialogBacking` is an unscrollable
      // full-screen overlay, so a wheel over it chains to the document and
      // this fires — but a user reading a modal question is not browsing the
      // graph underneath it, which is the whole premise ADR-0019 keeps
      // automatic loading on. Its condition fails here twice over: the loaded
      // commit window would widen out of sight, and the footer carrying both
      // the count and the only control that shrinks it is behind the overlay.
      // A deferral, not a refusal — the next scroll after the dialog closes
      // loads as it always did.
      //
      // This closes the wheel and *only* the wheel, which is worth saying
      // plainly because the obvious reading of it is wrong. The footer's Load
      // More is a real `<button>` with a tabindex, and `showDialog` sets two
      // class names and an `innerHTML` — no `inert` on the background, no
      // focus trap. So Tab still reaches that button behind the overlay and
      // Space still activates it natively; the keydown handler's dialog branch
      // returns without `preventDefault`, which cannot stop an activation it
      // never saw. The window therefore still widens behind a dialog by
      // keyboard, out of sight, and ADR-0019's condition is still only half
      // restored.
      //
      // #141 is the other half, and it is deliberately not scoped to this
      // window: the defect it names is that `showDialog` provides no focus
      // containment at all, so *every* background control stays tabbable and
      // pressable while a dialog is up. Load More is the symptom that reaches
      // this listener's subject, not the size of the problem. Nothing here can
      // fix that — a term in this condition cannot make a dialog modal.
      //
      // `"browsing"` is what keeps a refused load silent on this path while the
      // footer button reports its own (#137). It is not a nicety: this listener
      // is gated on `isDialogOpen()` two lines up, so a dialog raised from here
      // would switch off the feature that raised it until the user cleared it.
      if (
        this.config.loadMoreAutomatically &&
        this.moreCommitsAvailable &&
        !isDialogOpen() &&
        window.innerHeight + window.scrollY >= this.getPageHeight() - 250
      ) {
        this.loadMoreCommits("browsing");
      }
    });
    // Nothing invalidates a height nobody reads, and only the branch above
    // reads one — so the watchers are the switch's dependents, not the panel's.
    if (this.config.loadMoreAutomatically) this.observePageHeight();
  }
  /** The page height the near-the-bottom threshold measures against.
   *
   *  Measuring it lays the document out synchronously, and the threshold sits
   *  on the scroll path — so the measurement is cached, and `pageHeight` is
   *  null exactly when something has happened that could have moved the bottom.
   *  The reflow window is therefore "once per change while more commits are
   *  still loadable" rather than "once per tick", and the three booleans in
   *  front still take it to nothing at all once the whole history is in.
   *
   *  Three since #124 added the dialog gate; two before it. Anything added to
   *  that condition belongs in front of this call if it is cheap, and the count
   *  here belongs in the same edit — ADR-0019 carries a bullet whose whole
   *  subject is this number going stale. */
  private getPageHeight() {
    if (this.pageHeight === null) this.pageHeight = document.body.offsetHeight;
    return this.pageHeight;
  }
  /** Drop the cached page height whenever the document changes at all.
   *
   *  Deliberately not a list of the places that change the height: such a list
   *  is right only until the next one is added, and the failure is silent and
   *  awful — a stale height that reads short loads pages nobody scrolled to,
   *  one that reads long strands the user at the bottom with a Load More they
   *  have to find. Mutations are watched from `documentElement` so a theme
   *  landing on `<html>` counts too, and `resize` is listened for separately
   *  because a viewport change moves the bottom without touching the DOM.
   *
   *  Ordering is what makes the cache safe rather than merely cheap: mutation
   *  records are delivered on a microtask, and a real scroll event is dispatched
   *  by the user agent from the rendering steps, so the invalidation has always
   *  run before the next scroll handler sees the cache. A ResizeObserver would
   *  be the more direct instrument and is the wrong one here — its broadcast is
   *  ordered *after* the frame's scroll events, leaving one tick of stale height
   *  right where it does the most damage, immediately after a load lands.
   *  loadMoreOnScrollLayoutCost.test.ts pins the microtask half of that; the
   *  frame-lifecycle half rests on the spec, because jsdom runs no rendering
   *  steps and so cannot exhibit it.
   *
   *  One exception to that guarantee, and it is in the scroll handler itself:
   *  the `scrollShadow` class is written the statement before the threshold is
   *  read, so within that tick the record has not been delivered and the read
   *  is of the pre-write cache. Harmless — `#scrollShadow.active` is
   *  `position: fixed; height: 0` (`media/main.css:33`), so it is not in flow
   *  and cannot move the bottom — but it is the one place the ordering above
   *  does not hold, so it is written down rather than left to be rediscovered.
   *
   *  What this does *not* cover: layout that settles after the mutation that
   *  caused it, where the record arrives while the height is still the old one.
   *  Nothing in this webview does that today — there is no `@font-face` and no
   *  height-affecting `transition` anywhere in `media/`, and the one late-
   *  decoding image, the avatar, is pinned to 18px in both axes
   *  (`media/main.css:548`) inside a row whose `line-height: 24px` is taller
   *  still. Adding either would want a ResizeObserver alongside this, as the
   *  second source rather than the first.
   *
   *  The watchers are a standing cost that those booleans do *not* gate: they
   *  keep queueing records after `moreCommitsAvailable` goes false, for a cache
   *  nobody will read again. Accepted rather than fixed, because gating them
   *  means a connect/disconnect state machine around an assignment in
   *  `loadCommits` for a state most repositories never reach. The bound is
   *  looser than "records only appear when the height could have moved", and
   *  `applyFindHighlights` is the counter-example that keeps that honest: it
   *  toggles a class per matching row on every keystroke, hundreds of records
   *  that cannot move the height by construction. Human-paced and bounded, so
   *  still the cheaper side of the trade — but not free, and not correlated. */
  private observePageHeight() {
    const invalidate = () => {
      this.pageHeight = null;
    };
    new MutationObserver(invalidate).observe(document.documentElement, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true
    });
    window.addEventListener("resize", invalidate);
  }
  /** Pull the loaded commit window back to the opening count — the one width it
   *  ever shrinks to, never an intermediate one.
   *
   *  The branch search index goes with it because the index is built over the
   *  loaded set: leaving the wider one standing would have Find offering to
   *  reach commits the graph no longer holds. The two have never moved apart in
   *  any caller, which is what makes them one action rather than two that keep
   *  turning up next to each other.
   *
   *  The state change only — every caller pairs it with a reload of its own.
   *  Three of them (switchToRepo, setRepo, setShowRemoteBranches) used to run
   *  it before knowing whether that reload could go out at all, and the window
   *  then sat back at the opening count for a graph that never reloaded (#84).
   *  They go through {@link navigateReload} now, which cannot be refused, so
   *  the shrink and the reload can no longer come apart. The fourth
   *  (the commit-ordering menu) never could: it refuses out loud, ahead of any
   *  state change (ADR-0024). */
  private shrinkLoadedCommitWindow() {
    this.maxCommits = this.config.initialLoadCommits;
    this.invalidateBranchSearchIndex();
  }

  /** Load the next page of commits. Guarded so concurrent scroll events (or a
   *  press during a pending load) don't stack multiple requests — and guarded
   *  *before* any state change, because a request that cannot go out must
   *  leave the footer, the loaded commit window and the saved state exactly as
   *  they were. The in-flight load itself is the guard: a separate flag was
   *  raised before the drop was known, so it never came back down and Load
   *  More stayed dead for the life of the panel.
   *
   *  How the refusal is delivered is the one thing the two callers do not
   *  share, and {@link LoadMoreTrigger} carries which of them is asking. A
   *  press is refused out loud — a button that answers with nothing is
   *  indistinguishable from a dead one ({@link confirmForRepoAndHead}), and the
   *  next press a moment later works, so there is something to say. A scroll is
   *  refused in silence, because it never asked: raising a dialog over browsing
   *  is the operation-level side effect ADR-0019 exists to forbid, and it would
   *  cost more than the page — the dialog takes the graph's keyboard, and while
   *  it stands this very listener is gated (#124), so one page too many would
   *  stop every page after it.
   *
   *  Speaking from behind a standing dialog costs that dialog — #141 is why the
   *  user can get here, #127 is why arriving destroys the standing question; the
   *  measurement and why silence is not the cure are in ADR-0019. */
  private loadMoreCommits(trigger: LoadMoreTrigger) {
    if (this.commitLoadInFlight) {
      if (trigger === "operation") showErrorDialog(l10n.dialogLoadMoreBusy, null, null);
      return;
    }
    this.maxCommits += this.config.loadMoreCount;
    // The expanded Commit Details View stays open: loading strictly appends, so
    // the expanded commit cannot vanish, and renderTable re-binds it to its new
    // row (clearing it itself if it really did fall out of the loaded set).
    // Closing it here moved content under the user, destroyed the keyboard
    // focus fallback anchor, and closed the panel nobody asked to close.
    // Re-binding it does not move the viewport either: renderCommitDetailsPanel
    // only scrolls a CDV into view when it is being opened, not redrawn.
    this.saveState();
    this.renderFooter(true);
    this.requestLoadCommits(true, () => {});
  }

  /** Shrink the loaded commit window back to the opening count and reload.
   *
   *  The only entry that does this on purpose. The four that already did it —
   *  switching repository, changing the branch filter, toggling remote
   *  branches, changing the commit ordering — do it as a side effect of doing
   *  something else, so a user who only wants the window back has to go and
   *  change something they did not want changed (ADR-0019).
   *
   *  Not every navigation, and the line is drawn by route rather than by
   *  kind: a change recognised through {@link commitScopeChanged} — hiding a
   *  remote, or an ordering arriving already decided from outside this panel —
   *  deliberately leaves the window alone, so that the generalisation does not
   *  hand every future field a side effect nobody chose for it (ADR-0024). The
   *  commit ordering therefore shrinks it from the column-header menu and not
   *  from that comparison, which is the same field on two routes.
   *
   *  Guarded before any state changes, on the same terms as Load More and the
   *  commit-ordering menu: a request sent while a load is in flight is dropped,
   *  and shrinking the window first would leave the graph still showing the
   *  wide page while the window says otherwise — with the line gone, so nothing
   *  on screen says the two came apart, and the next refresh silently
   *  collapsing the graph as the payment.
   *
   *  And refused out loud, on the same terms too. This is the *only* way back
   *  from a widened window, and ADR-0019 keeps automatic loading on the
   *  condition that such a way back exists — one that answers a press with
   *  nothing at all is indistinguishable from a dead button
   *  ({@link confirmForRepoAndHead}), which is the condition failing while
   *  appearing to hold. Nothing is lost by saying so: the same press works a
   *  moment later.
   *
   *  Speaking from behind a standing dialog costs that dialog — #141 is why the
   *  user can get here, #127 is why arriving destroys the standing question; the
   *  measurement and why silence is not the cure are in ADR-0019. It applies to
   *  this button as much as to Load More beside it: same footer, same overlay,
   *  same tab order. */
  private resetLoadedCommitWindow() {
    if (this.commitLoadInFlight) {
      showErrorDialog(l10n.dialogResetWindowBusy, null, null);
      return;
    }
    this.shrinkLoadedCommitWindow();
    // Viewport and focus must not end up contradicting each other, and here
    // they would: the page shrinks under the user, the browser clamps them to
    // its new bottom, and #73 puts focus back on a row that may be hundreds
    // above it — one arrow key later `scrollIntoView` hauls them back down.
    // With automatic loading on it is worse: the clamp is itself a scroll event
    // at the near-the-bottom threshold, so the window widens straight back out
    // and the reset visibly undoes half of itself. So the viewport follows the
    // restored focus (ADR-0014's "back to where the operation was", read
    // literally), or the row the graph now begins at when focus was dropped.
    //
    // A trade-off, not a treatment. The cause is that the threshold cannot tell
    // the browser's own clamping scroll from the user's, and nothing available
    // in a scroll handler distinguishes them cleanly. Reaching for a scroll
    // *offset* instead would be the compensation ADR-0019 refused; moving with
    // the anchor the user actually has is not.
    this.pendingFocusScroll = true;
    this.saveState();
    // The expanded Commit Details View is left to renderTable, which re-binds
    // it or clears it depending on whether its commit is still loaded. Unlike
    // Load More this reload can genuinely drop it — the window is shrinking —
    // but only renderTable knows which happened.
    this.renderFooter(true);
    this.requestLoadCommits(true, () => {});
  }

  /* Commit Details */
  private loadCommitDetails(sourceElem: HTMLElement) {
    this.hideCommitDetails();
    this.expandedCommit = {
      id: parseInt(sourceElem.dataset.id!),
      hash: sourceElem.dataset.hash!,
      srcElem: sourceElem,
      commitDetails: null,
      fileTree: null,
      compareWithHash: null,
      compareWithSrcElem: null,
      compareFromHash: null,
      compareToHash: null,
      compareFileChanges: null
    };
    this.saveState();
    const idx = this.commitLookup[sourceElem.dataset.hash!];
    const isStash = idx !== undefined && this.commits[idx].refs.some((r) => r.type === "stash");
    sendMessage({
      command: "commitDetails",
      repo: this.currentRepo!,
      commitHash: sourceElem.dataset.hash!,
      isStash
    });
  }
  /** What the open CDV is showing: the expanded commit, plus the commit it is
   *  being compared with. Two renders sharing an identity are the same view
   *  drawn twice, which is what {@link renderCommitDetailsPanel} uses to tell
   *  a redraw from an opening.
   *
   *  A redraw that cannot keep the same identity is an opening by definition,
   *  and does scroll: see renderTable's fallback for a compared commit that
   *  left the loaded set. */
  private cdvIdentity(): string | null {
    if (this.expandedCommit === null) return null;
    return this.expandedCommit.hash + "|" + (this.expandedCommit.compareWithHash ?? "");
  }
  public hideCommitDetails() {
    if (this.expandedCommit !== null) {
      this.clearExpandedCommit();
      this.saveState();
      this.renderGraph();
    }
  }

  /** Tear down the Commit Details View DOM — an inline `<tr>` or a docked
   *  `<body>`-level panel — clear both rows' highlights and the
   *  `cdvDocked` body class, and reset the expanded-commit state. Every place
   *  that drops the expanded commit must go through this so a docked panel
   *  (which is NOT inside the re-rendered table) can never be orphaned. */
  private clearExpandedCommit() {
    const panel = document.getElementById("commitDetails");
    if (panel !== null) panel.remove();
    // The next CDV is an opening, however it compares to this one.
    this.cdvBroughtIntoView = null;
    if (this.expandedCommit !== null) {
      if (this.expandedCommit.srcElem !== null)
        this.expandedCommit.srcElem.classList.remove("commitDetailsOpen");
      if (this.expandedCommit.compareWithSrcElem !== null)
        this.expandedCommit.compareWithSrcElem.classList.remove("commitDetailsOpen");
    }
    document.body.classList.remove("cdvDocked");
    this.expandedCommit = null;
  }

  /** Whether the Commit Details View docks to the bottom of the window rather
   *  than expanding inline within the table. */
  private isCdvDocked(): boolean {
    return this.config.commitDetailsViewLocation === "Docked to Bottom";
  }

  /** The revision the Commit Details View's file actions act on: the "to"
   *  commit while comparing, otherwise the expanded commit. */
  private get cdvHash(): string {
    if (this.expandedCommit === null) return "";
    return this.expandedCommit.compareWithHash !== null &&
      this.expandedCommit.compareToHash !== null
      ? this.expandedCommit.compareToHash
      : this.expandedCommit.hash;
  }

  /** The base revision for view-diff while comparing two commits;
   *  undefined for a single-commit view (diffs against the commit's parent). */
  private get cdvFromHash(): string | undefined {
    return this.expandedCommit !== null &&
      this.expandedCommit.compareWithHash !== null &&
      this.expandedCommit.compareFromHash !== null
      ? this.expandedCommit.compareFromHash
      : undefined;
  }

  /** CTRL/CMD-click a second commit while details are open to compare the two
   * . The older commit (further down the list = larger row id) becomes the
   *  "from"; requests the diff between them from the backend. */
  private loadCommitComparison(compareElem: HTMLElement) {
    if (this.expandedCommit === null || this.expandedCommit.srcElem === null) return;
    const compareHash = compareElem.dataset.hash!;
    // Drop a previously-compared row's highlight before switching targets.
    if (
      this.expandedCommit.compareWithSrcElem !== null &&
      this.expandedCommit.compareWithSrcElem !== compareElem
    ) {
      this.expandedCommit.compareWithSrcElem.classList.remove("commitDetailsOpen");
    }
    const compareId = parseInt(compareElem.dataset.id!);
    const fromHash = this.expandedCommit.id > compareId ? this.expandedCommit.hash : compareHash;
    const toHash = this.expandedCommit.id > compareId ? compareHash : this.expandedCommit.hash;
    this.expandedCommit.compareWithHash = compareHash;
    this.expandedCommit.compareWithSrcElem = compareElem;
    this.expandedCommit.compareFromHash = fromHash;
    this.expandedCommit.compareToHash = toHash;
    this.expandedCommit.compareFileChanges = null;
    this.expandedCommit.fileTree = null;
    compareElem.classList.add("commitDetailsOpen");
    this.saveState();
    sendMessage({ command: "compareCommits", repo: this.currentRepo!, fromHash, toHash });
  }

  /** The two commits a CTRL-click comparison has selected — the anchored row
   *  and the one compared against it — or null while the Commit Details View is
   *  showing a single commit. Unordered: the pair is whatever was clicked, and
   *  each caller resolves the order its own operation needs. */
  private comparedCommitPair(): [string, string] | null {
    const expanded = this.expandedCommit;
    if (expanded === null || expanded.compareWithHash === null) return null;
    return [expanded.hash, expanded.compareWithHash];
  }

  /** Close the comparison and fall back to the expanded commit's own details
   * . `loadCommitDetails` resets the expanded-commit state (and clears the
   *  compared row's highlight via `hideCommitDetails`) before re-requesting. */
  private hideCommitComparison() {
    if (this.expandedCommit === null || this.expandedCommit.srcElem === null) return;
    this.loadCommitDetails(this.expandedCommit.srcElem);
  }

  /* Find Widget */
  public showFind() {
    this.findActive = true;
    document.getElementById("findWidget")?.classList.add("active");
    const input = <HTMLInputElement | null>document.getElementById("findInput");
    if (input !== null) {
      input.focus();
      input.select();
      this.runFind(input.value);
    }
    this.requestBranchSearchIndex();
  }
  private requestBranchSearchIndex() {
    // Falsy, not `=== null`: "none selected" is the empty string when the host
    // had no live repository to offer ({@link loadRepos}), and `=== null` waved
    // it through — Ctrl+F then asked the host to index a repository named "".
    if (!this.currentRepo) return;
    sendMessage({
      command: "branchSearch",
      repo: this.currentRepo,
      branchNames: this.currentBranches !== null ? this.currentBranches : [""],
      commitOrder: this.gitRepos[this.currentRepo]?.commitOrdering ?? undefined,
      hiddenRemotes: this.gitRepos[this.currentRepo]?.hiddenRemotes ?? [],
      token: ++this.branchSearchToken
    });
  }
  private invalidateBranchSearchIndex() {
    this.branchSearchToken++;
    this.branchSearchIndex = [];
    this.pendingFindNavigation = null;
  }
  public hideFind() {
    this.findActive = false;
    document.getElementById("findWidget")?.classList.remove("active");
    // Return focus to the document so keyboard shortcuts work again.
    (<HTMLElement | null>document.getElementById("findInput"))?.blur();
    this.findMatches = [];
    this.findCurrent = -1;
    // Whatever the next search lands on, Find has not settled on it yet.
    this.findSettledOn = null;
    this.pendingFindNavigation = null;
    // Both pending fields are cleared here, not just the navigation one: a
    // closed widget has no outstanding step, and a target left standing would
    // be read by the next load as a move somebody asked for. `runFind` happens
    // to clear it on the way back in, but that is its business, not a reason
    // for this one to leave a live field behind.
    this.pendingFindTargetHash = null;
    this.clearFindHighlights();
  }
  /** The commit Find is pointing at, or null when it points at nothing.
   *  {@link findPosition} reads it for the plain reason — that is the match to
   *  put Find back on — and {@link refreshFind} asks it one question and only
   *  one: has the branch
   *  index that just landed changed the target, or is it the same answer to the
   *  same search arriving again? The index is re-requested after every load, so
   *  without this the first search that matches a branch name would re-centre
   *  itself on every page the user browses past.
   *
   *  It deliberately does **not** decide anything on the redraw path. Whether a
   *  target changed says nothing about whether the user asked for it to — see
   *  refreshFind.
   *
   *  `findCurrent` is not part of it: `buildFindMatches` emits at most one match
   *  per hash, so the index says nothing the hash does not, and it is the one
   *  part a rebuild moves on its own — a match keeping its hash while matches
   *  inserted above it shift its index is not a new target.
   *
   *  Neither is the search text. {@link applyFindHighlights} re-settles this on
   *  every scroll it is asked to make, and every search asks for one, so the
   *  identity already stands for the search now in the box. Carrying the text
   *  as well would only add a false positive: an input value that changed
   *  without reaching Find — a right-click paste fires no keyup — would make
   *  the next index arrival look like a move to a new target. */
  private findIdentity(): string | null {
    return this.findCurrent >= 0 ? (this.findMatches[this.findCurrent]?.hash ?? null) : null;
  }
  private runFind(query: string) {
    this.pendingFindTargetHash = null;
    this.pendingFindNavigation = null;
    this.findMatches = buildFindMatches(query, this.commits, this.branchSearchIndex);
    this.findCurrent = this.findMatches.length > 0 ? 0 : -1;
    this.applyFindHighlights(true);
  }
  /** Rebuild the matches against the commits and branch index as they now
   *  stand, keeping the current match on the same commit where it survived.
   *
   *  `source` says what arrived, and it — not the identity — is what decides
   *  whether this may move the viewport. See the comment on the decision. */
  private refreshFind(source: "redraw" | "branchIndex", preferredHash: string | null) {
    const input = <HTMLInputElement | null>document.getElementById("findInput");
    const previousIndex = this.findCurrent;
    const currentHash =
      preferredHash ??
      (this.findCurrent >= 0 ? (this.findMatches[this.findCurrent]?.hash ?? null) : null);
    const currentDepth =
      currentHash === null
        ? undefined
        : this.findMatches.find((match) => match.hash === currentHash)?.depth;
    this.findMatches = buildFindMatches(input?.value ?? "", this.commits, this.branchSearchIndex);
    this.findCurrent = resolveFindCurrent(
      this.findMatches,
      currentHash,
      previousIndex,
      this.findDirection,
      currentDepth
    );
    // Bringing the current match into view belongs to *moving* to it, not to
    // drawing it (ADR-0019: automatic loading is browsing, and browsing must
    // not move anything in front of the user). What separates the two is
    // whether the user asked, and **a change of target does not answer that
    // question** — it is wrong in both directions. A background refresh that
    // amends the current match away moves the target with nobody asking. A
    // search that has found nothing yet keeps the same target — "still
    // nothing" — right up to the page that silently turns it into a commit.
    // So the caller says what arrived, and that decides.
    //
    // A `redraw` is a page or a refresh landing: browsing, or an operation
    // that already owns its own viewport decision. It moves nothing — unless
    // it is the answer to a step still outstanding, which `preferredHash` is
    // non-null exactly when, `loadFindMatch` having set it on the load it sent
    // to reach a match past the loaded commit window.
    //
    // A `branchIndex` arrival is the second half of the search itself: matches
    // on branch names cannot exist before it lands, so centring what it
    // reveals is part of searching, which the user did ask for. But it is
    // re-requested after every load, so only the arrival that actually changes
    // the target may scroll — which is the identity's whole job, and its only
    // one.
    //
    // Stepping and searching call applyFindHighlights directly and are
    // unconditional: those are moves, and one that happens to land back on the
    // current match still owes the user the scroll.
    const scroll =
      preferredHash !== null ||
      (source === "branchIndex" && this.findIdentity() !== this.findSettledOn);
    this.applyFindHighlights(scroll);
  }
  public loadBranchSearchIndex(
    branches: BranchSearchEntry[],
    token: number,
    status: string | null
  ) {
    if (token !== this.branchSearchToken) return;
    if (status !== null) {
      showErrorDialog(l10n.unableToSearchBranches, status, null);
      return;
    }
    const pendingNavigation = this.pendingFindNavigation;
    this.branchSearchIndex = branches;
    if (!this.findActive) return;
    // Where Find is standing as this arrival begins. The step that raised the
    // pending navigation deliberately moved nothing, so this is still the match
    // the user is looking at — and `refreshFind` is about to move off it, which
    // is why it is read here rather than after.
    const position = this.findPosition();
    this.refreshFind("branchIndex", pendingNavigation?.hash ?? this.pendingFindTargetHash);
    if (pendingNavigation === null) return;

    this.pendingFindNavigation = null;
    this.applyPendingFindNavigation(pendingNavigation, position);
  }
  /** Finish a step onto a branch match, against the index that has just been
   *  revalidated for it. `position` is where Find stood before this arrival,
   *  which is where the step goes back to if it turns out not to be happening.
   *
   *  This is the whole of the step: the click that asked for it recorded a
   *  wish and nothing else. That is ADR-0019's rule read literally — the guard
   *  belongs at the front of the same synchronous stretch as the state change,
   *  and a change waiting on a round trip has to wait with it. */
  private applyPendingFindNavigation(navigation: PendingFindNavigation, position: FindPosition) {
    const branchRefs = new Set(navigation.branchRefs);
    const movedIndex = this.findMatches.findIndex((match) =>
      match.branches.some((branch) => branchRefs.has(branch.ref))
    );
    if (movedIndex === -1) return;
    if (this.loadFindMatch(this.findMatches[movedIndex], navigation.direction) === "hold") {
      this.restoreFindPosition(position);
      return;
    }
    this.findCurrent = movedIndex;
    this.findDirection = navigation.direction;
    // Painted whether or not a page is on its way. When one is, the match has
    // no row yet and this moves only the counter — onto the match Find is now
    // on, which is the point: the two are readings of one fact, and the rebuild
    // above resolved its reading from the branch's *old* tip.
    this.applyFindHighlights(true);
  }
  private findStep(delta: number) {
    if (this.findMatches.length === 0) return;
    const n = this.findMatches.length;
    // Presses compound while an answer is out. A step waiting on a branch index
    // has recorded nothing — that is the whole point of it — but it is still
    // where the user has asked to be, so this press counts from there.
    // Counting from `findCurrent` instead would swallow every press made during
    // the round trip, and the branch index is a `git` call, not a local read.
    const pending = this.pendingFindNavigation;
    const outstanding =
      pending === null ? -1 : this.findMatches.findIndex((match) => match.hash === pending.hash);
    const next = ((outstanding === -1 ? this.findCurrent : outstanding) + delta + n) % n;
    const direction: -1 | 1 = delta < 0 ? -1 : 1;
    const match = this.findMatches[next];
    if (match.branches.length > 0) {
      // A branch may have moved since the index in hand was fetched, so where
      // this lands is decided against a fresh one. Nothing is written until
      // then — not even the direction — because a step recorded now is a step
      // the answer may say never happened.
      this.pendingFindNavigation = {
        hash: match.hash,
        branchRefs: match.branches.map((branch) => branch.ref),
        direction
      };
      this.requestBranchSearchIndex();
      return;
    }
    // Decided before anything moves, which on this path costs nothing: no
    // branch to revalidate means no round trip, so the guard and the state
    // change are already in the same synchronous stretch (ADR-0019).
    if (this.loadFindMatch(match, direction) === "hold") return;
    this.findCurrent = next;
    this.findDirection = direction;
    this.applyFindHighlights(true);
  }
  /** Where Find is standing now, in the form something that moves it can put it
   *  back. */
  private findPosition(): FindPosition {
    return { hash: this.findIdentity(), index: this.findCurrent };
  }
  /** Put Find back on the match it was on before this arrival rebuilt the
   *  matches and resolved itself onto the target of a step that is not
   *  happening. Nothing was sent, so nothing is coming to move the highlight,
   *  and a counter left one ahead of it would sit there for good.
   *
   *  The repaint is not optional: the arrival that carried the news has already
   *  refreshed the widget once, over the position being undone here. */
  private restoreFindPosition(position: FindPosition) {
    this.findCurrent = resolveFindCurrent(
      this.findMatches,
      position.hash,
      position.index,
      this.findDirection
    );
    this.applyFindHighlights(false);
  }
  /** Bring `match` within reach of the graph, reporting whether the caller's
   *  step may go ahead — see {@link FindLoadOutcome}.
   *
   *  The confirmation path answers `hold` because that is the truth while the
   *  dialog stands: the request goes out when the user says yes, if a load has
   *  not started underneath it in the meantime, and it may never go out at all.
   *  A step recorded when the question went up would be describing a navigation
   *  nobody has agreed to, and Cancel would leave it described for ever.
   *
   *  Which is why `direction` is handed over rather than kept: on that path the
   *  step commits an unbounded wait after the caller has returned, so the only
   *  code left to record it is the request going out. The rest of the move
   *  travels the same way — {@link pendingFindTargetHash} carries the target to
   *  the page that lands, so the counter, the highlight and the viewport all
   *  arrive together with it. */
  private loadFindMatch(match: FindMatch, direction: -1 | 1): FindLoadOutcome {
    // Ahead of the in-flight guard, and that order is the point: "no request was
    // needed" and "the request could not be sent" are different answers, and
    // only the second is a reason to hold Find back. Taking the guard first
    // would stall every step onto an already-drawn match for the length of any
    // background load — which is nearly every step.
    const plan = planFindLoad(this.maxCommits, match);
    if (plan === null) return "move";
    if (this.commitLoadInFlight) {
      // Refused out loud, because `hold` has two sources and only one of them
      // is visible. The other is the confirmation below, which the user is
      // looking at; this one is a step that moved the graph not at all and said
      // nothing — a dead Enter key, on the control a user presses most often
      // (`confirmForRepoAndHead`: an invisible refusal and a broken button
      // cannot be told apart). Neither caller can say it for us, since neither
      // can tell the two sources of `hold` apart.
      //
      // Something is left to do, which is what separates this from the silence
      // a few lines down when the match has been amended away: the very same
      // press, once the load in flight lands.
      //
      // Speaking from behind a standing dialog costs that dialog — #141 is why
      // the user can get here, #127 is why arriving destroys the standing
      // question; the measurement and why silence is not the cure are in
      // ADR-0019. Live on this path too: the document keydown handler returns
      // early while a dialog is up, but the Find input has a keyup listener of
      // its own, so Enter still steps from behind an overlay.
      showErrorDialog(l10n.dialogFindStepBusy, null, null);
      return "hold";
    }
    const load = () => {
      // Guarded again, not just at the top: when the plan needs confirming, this
      // runs after the user answers the dialog, and a load can have started in
      // the meantime. Everything below changes state, so the check belongs here
      // as well — the check above only covers the path that acts immediately.
      //
      // And reported, for the reason the `now === null` branch below already
      // spells out about itself: returning here is the "pressed Yes, nothing
      // happened" half-state the same ADR rules out. This guard is
      // only ever reached from the confirmed path — on the immediate path the
      // check above has already answered `hold` — so by construction there is a
      // question the user just answered, which is the loudest possible claim
      // that something was about to happen. The wording says a load *started*
      // rather than that one is running: when the question went up there was
      // none, and the user has no other way to learn that changed.
      //
      // Speaking from behind a standing dialog costs that dialog — #141 is why
      // the user can get here, #127 is why arriving destroys the standing
      // question; the measurement and why silence is not the cure are in
      // ADR-0019. Cheapest to see here of the four: this runs from the answer
      // to a dialog, so another may well have been raised over it in between.
      if (this.commitLoadInFlight) {
        showErrorDialog(l10n.dialogFindLoadBusy, null, null);
        return;
      }
      // And the plan is re-taken with it, for the same reason and on the same
      // terms (ADR-0019: when the change is deferred into a callback, so is the
      // reading it rests on). The plan above was sized against two things as
      // they stood when the question went up, and both still move while the
      // dialog stands.
      // The loaded commit window: automatic loading no longer widens it there
      // — #124 gated the scroll listener on the dialog — but the footer's Load
      // More still does, because `showDialog` provides no focus containment
      // (#141: no `inert`, no focus trap, no focus move, so every background
      // control stays tabbable and pressable) and the overlay hides that
      // button without disabling it. And the match: a background reload lands on the file
      // watcher's schedule, not the user's, so a rebase or an amend in the
      // terminal can redraw the very commit this plan was sized to go and
      // fetch.
      // Acting on a stale plan sets `maxCommits` *back* to the older, smaller
      // number, silently discarding commits already drawn; and if the target
      // came in on one of those pages, it reloads the whole table and closes
      // the Commit Details View to reach a row that is already on screen.
      // Silent, unlike the stash drop's refusal a few hundred lines up, and the
      // difference is what there is left to do rather than how loud to be. That
      // one has a stash it could still act on and declines to; this one has no
      // match to step onto at all — the query itself has changed underneath the
      // question, so Find has already moved on and repainted, and there is no
      // half-state to report.
      const current = this.findMatches.find((m) => m.hash === match.hash);
      if (current === undefined) return;
      const now = planFindLoad(this.maxCommits, current);
      if (now === null) {
        // Nothing left to load — but the step the user pressed Yes for still
        // has to happen. Returning here would be the "pressed Yes, nothing
        // happened" half-state the same ADR rules out, and no page is coming to
        // move the highlight instead.
        this.findCurrent = this.findMatches.indexOf(current);
        this.findDirection = direction;
        this.applyFindHighlights(true);
        return;
      }
      this.pendingFindTargetHash = match.hash;
      // The step is happening as of this line, so this is where its direction
      // belongs. Leaving it to the caller loses it on the confirmed path: that
      // caller answered `hold` and returned long before the user said yes, and
      // the page that lands knows the target but not which way Find was going.
      // A navigation that completes without recording its direction leaves the
      // next amended-away match resolving off some earlier step's.
      this.findDirection = direction;
      this.maxCommits = now.maxCommits;
      this.hideCommitDetails();
      this.saveState();
      this.beginBusyLoad();
      this.requestLoadCommits(true, () => this.endBusyLoad());
    };
    if (plan.confirm) {
      showConfirmationDialog(
        l10n.dialogFindLoadMoreConfirm.replace("{0}", String(plan.additionalCommits)),
        load,
        null
      );
      return "hold";
    }
    load();
    return "move";
  }
  /** Take Find's marks off the graph. Scoped for the reason at
   *  {@link graphRowByHash}, with one wrinkle of its own: a clear can only ever
   *  reach *too far*, never too short, so document-wide it never lost a mark —
   *  it went into the dialog and stripped classes off rows it had not marked.
   *  Harmless while nothing else uses the names, which is the same argument that
   *  held for the bindings right up until it didn't.
   *
   *  The selector tightened from `.commit` to `tr.commit` on the way, which is a
   *  change and so is written down rather than left to be noticed: within
   *  `#commitTable` the two select the same set, because `renderTable` puts the
   *  class on `<tr>` and on nothing else. It is here so that every selector in
   *  this family reads the same, and so that the one thing they have in common
   *  is visible at a glance — they all name a row of a table.
   *
   *  The ref half is scoped with it rather than left behind. Nothing but
   *  `renderTable` renders a `.gitRef` today, so there is no second `.gitRef` to
   *  reach — but `findBranchMatch` is set, ten lines down, only on refs inside a
   *  row this now cannot find outside the table, and a clear with a wider reach
   *  than the paint it undoes is the asymmetry both #128 and #144 were. This is
   *  the *read*; `gitRef`'s **binding** is still document-wide and is somebody
   *  else's ticket — see the inventory beside `addListenerToClass`. */
  private clearFindHighlights() {
    this.tableElem
      .querySelectorAll("tr.commit.findMatch, tr.commit.findMatchCurrent")
      .forEach((el) => el.classList.remove("findMatch", "findMatchCurrent"));
    this.tableElem
      .querySelectorAll(".gitRef.findBranchMatch")
      .forEach((el) => el.classList.remove("findBranchMatch"));
  }
  /** Re-apply find styling to the current DOM. Pass scroll=true to bring the
   *  current match into view (e.g. on a new search or step, not on re-render).
   *
   *  Every row here is {@link graphRowByHash}'s. The matches come from
   *  `this.commits`, so the rows they mean are the graph's by construction —
   *  what the scope adds is that the lookup can no longer answer with anything
   *  else. Painting the dialog's copy of a hash left the graph's row unmarked
   *  while the counter went on saying a match was current, and sent the
   *  bring-into-view scroll into the modal: a search that reads as broken rather
   *  than as looking in the wrong place. */
  private applyFindHighlights(scroll: boolean) {
    // Every pass claims the target it resolved, including the ones that move
    // nothing. `loadCommits` refreshes Find and then re-requests the branch
    // index, whose answer refreshes Find again — so a redraw that declined to
    // scroll and also declined to claim what it had just resolved would leave
    // the index one message later comparing the page's new target against a
    // record from before the page, reading its own load as a change and
    // scrolling the browsing user after all. Declining to move and declining to
    // settle are different things, and only the first one was ever wanted.
    this.findSettledOn = this.findIdentity();
    this.clearFindHighlights();
    for (const match of this.findMatches) {
      const row = this.graphRowByHash(match.hash);
      row?.classList.add("findMatch");
      if (row !== null) {
        row.querySelectorAll<HTMLElement>(".gitRef").forEach((ref) => {
          if (match.branches.some((branch) => branch.name === (ref.dataset.name ?? ""))) {
            ref.classList.add("findBranchMatch");
          }
        });
      }
    }
    const countElem = document.getElementById("findCount");
    if (countElem !== null) {
      countElem.textContent =
        this.findMatches.length === 0
          ? l10n.noResultsFound
          : l10n.findCount
              .replace("{0}", String(this.findCurrent + 1))
              .replace("{1}", String(this.findMatches.length));
    }
    if (this.findCurrent >= 0) {
      const currentRow = this.graphRowByHash(this.findMatches[this.findCurrent].hash);
      if (currentRow !== null) {
        currentRow.classList.add("findMatchCurrent");
        if (scroll && typeof currentRow.scrollIntoView === "function") {
          currentRow.scrollIntoView({ block: "center" });
        }
        // In "open details" mode, open the current match's details view,
        // unless it's already the expanded commit.
        if (
          scroll &&
          this.findOpenCommitDetails &&
          (this.expandedCommit === null ||
            this.expandedCommit.hash !== this.findMatches[this.findCurrent].hash)
        ) {
          this.loadCommitDetails(currentRow);
        }
      }
    }
  }
  /** Scroll the view to centre the commit referenced by HEAD, optionally blinking
   *  it. The row is {@link graphRowByHash}'s, and the blink is handed that same
   *  row rather than the hash: "Locate HEAD" that centres and flashes a copy of
   *  the row inside a dialog moves the graph not at all, which reads as the
   *  button being dead rather than as it having found the wrong tree. */
  public scrollToHead(blink = true) {
    if (this.commitHead === null) return;
    const row = this.graphRowByHash(this.commitHead);
    if (row !== null && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "center" });
    }
    if (blink) blinkRow(row);
  }
  /** Cycle the view to the next (or previous) stash on the graph, centring and
   *  blinking it. No-op when no stashes are shown.
   *
   *  The cycle is over `this.commits` — the graph's own loaded set — so the row
   *  it then wants is the graph's by construction; {@link graphRowByHash} is
   *  what makes the lookup say so. */
  public scrollToStash(forward: boolean) {
    const stashRows: number[] = [];
    for (let i = 0; i < this.commits.length; i++) {
      if (this.commits[i].refs.some((r) => r.type === "stash")) stashRows.push(i);
    }
    if (stashRows.length === 0) return;
    this.currentStashScroll = forward
      ? (this.currentStashScroll + 1) % stashRows.length
      : (this.currentStashScroll - 1 + stashRows.length) % stashRows.length;
    const hash = this.commits[stashRows[this.currentStashScroll]].hash;
    const row = this.graphRowByHash(hash);
    if (row !== null && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "center" });
    }
    blinkRow(row);
  }

  /* Keyboard Navigation */

  /** Every row keyboard focus can land on, in visual order: the column-header
   *  row, then one per commit / uncommitted-changes row. Rebuilt from the DOM on
   *  each call because `renderTable` replaces the lot. */
  private graphRows(): HTMLElement[] {
    return Array.from(
      this.tableElem.querySelectorAll<HTMLElement>("#tableColHeaders, tr.commit, tr.unsavedChanges")
    );
  }

  /** Which row keyboard focus is in, or null when it is not in the graph at
   *  all. Read immediately *before* the table is replaced: once the rows are
   *  gone `document.activeElement` has fallen back to `<body>` and nothing is
   *  left to say where the user was. */
  private focusedRowKey(): string | null {
    const row = focusedRow(this.graphRows());
    return row === undefined ? null : graphRowKey(row);
  }

  /** Where the arrow keys step from: the row holding focus, falling back to the
   *  expanded commit's row. That fallback is what keeps Up/Down stepping
   *  through the Commit Details View from wherever focus happens to be, which
   *  is what they did before rows could be focused. */
  private focusedRowIndex(rows: HTMLElement[]): number {
    const focused = focusedRow(rows);
    if (focused !== undefined) return rows.indexOf(focused);
    const anchored = this.expandedCommit?.srcElem ?? null;
    return anchored === null ? -1 : rows.indexOf(anchored);
  }

  /** Move focus `delta` rows through the graph (negative = up). */
  public moveRowFocus(delta: number) {
    const rows = this.graphRows();
    if (rows.length === 0) return;
    const from = this.focusedRowIndex(rows);
    if (from === -1) {
      // Nothing to step from, so enter the grid at the end the key is coming
      // from — never the column-header row, which is somewhere to arrive at
      // rather than to start from.
      const first = rows.find((row) => !isHeaderRow(row)) ?? rows[0];
      this.focusGraphRow(delta > 0 ? first : rows[rows.length - 1]);
      return;
    }
    this.focusGraphRow(rows[stepWithinGroup(rows.length, from, delta)]);
  }

  /** Focus `row` and, while the Commit Details View is open, swap the panel to
   *  the commit it lands on. Selection follows focus: arrowing through the graph
   *  was already how the details view was navigated, and leaving the panel on a
   *  commit the user has focused away from would have the two disagree. */
  private focusGraphRow(row: HTMLElement) {
    this.graphTabStop.focus(row);
    if (
      this.expandedCommit !== null &&
      row.classList.contains("commit") &&
      row.dataset.hash !== this.expandedCommit.hash
    ) {
      this.loadCommitDetails(row);
    }
  }

  /** Move focus between the widgets inside the focused row — a commit row's ref
   *  chips, the header row's columns — or back out to the row itself. This is
   *  how a grid exposes what a row holds: Up/Down pick the row, Left/Right walk
   *  its contents. False when there is nothing to walk, leaving the key to do
   *  whatever it otherwise would. */
  public moveWidgetFocus(delta: number): boolean {
    const rows = this.graphRows();
    const row = focusedRow(rows);
    if (row === undefined) return false;
    const widgets = rowWidgets(row);
    if (widgets.length === 0) return false;
    // From the row itself, Right enters at the first widget and Left at the
    // last; stepping off either end hands focus back to the row.
    const at = widgets.indexOf(<HTMLElement>document.activeElement);
    const next = at === -1 ? (delta > 0 ? 0 : widgets.length - 1) : at + delta;
    this.graphTabStop.focus(next < 0 || next >= widgets.length ? row : widgets[next]);
    return true;
  }

  /** The open Commit Details View, or null when none is. **A class name is never
   *  proof of the panel**, so this is where everything that has to tell the
   *  panel's markup from a look-alike asks: the branch-redundancy dialog renders
   *  a commit's files through the same `commitFilesHtml`, so `.gitFile`,
   *  `.gitFolder` and every row action's class exist in the modal too, carrying
   *  another commit's paths. The focus path (`cdvFileRows`, #113) and the
   *  binding path ({@link addCdvListenerToClass}, #128) share this one answer
   *  rather than each writing a selector.
   *
   *  Not every `getElementById("commitDetails")` in this class goes through it,
   *  and the ones that don't are asking a different question: they want the
   *  panel itself — to remove it, to replace it, or (in `renderGraph`) to
   *  measure its height — not to decide whether some element already in hand
   *  belongs to it. */
  private cdvPanel(): HTMLElement | null {
    return document.getElementById("commitDetails");
  }

  /** The Commit Details View's file rows, in visual order. Files inside a
   *  collapsed folder are left out — `display: none` takes them out of the focus
   *  order, so stepping onto one would strand focus. */
  private cdvFileRows(): HTMLElement[] {
    const panel = this.cdvPanel();
    if (panel === null) return [];
    return Array.from(panel.querySelectorAll<HTMLElement>(".gitFile")).filter(
      (file) => file.closest(".hidden") === null
    );
  }

  /** Which file in the Commit Details View keyboard focus is in, or null when it
   *  is not in that list at all. Read immediately *before* the table is
   *  replaced, the same way {@link focusedRowKey} is: the panel goes with the
   *  table it is inline in, and a docked one is removed and rebuilt a moment
   *  later, so by the end of the redraw `document.activeElement` is `<body>`
   *  under either layout and nothing is left to say where the user was.
   *
   *  Asked of {@link cdvFileRows}, not of the focused element's nearest
   *  `.gitFile`: a `.gitFile` row is not proof of the Commit Details View. The
   *  branch-redundancy dialog renders its commit's files through the same
   *  `renderGitFileRow`, carrying the same paths, and a redraw arriving while
   *  focus sits in that dialog must not haul it out of the modal and onto the
   *  panel behind it. */
  private focusedCdvFileKey(): string | null {
    const file = focusedRow(this.cdvFileRows());
    return file === undefined ? null : cdvFileKey(file);
  }

  /** Move focus `delta` file rows through the Commit Details View. False when
   *  focus isn't in the file list, so the caller falls back to the graph's rows
   *  — the file list is its own widget, and arrowing through it must not walk
   *  out into the commits behind it. */
  public moveCdvFileFocus(delta: number): boolean {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return false;
    const file = active.closest<HTMLElement>(".gitFile");
    if (file === null) return false;
    const files = this.cdvFileRows();
    const from = files.indexOf(file);
    if (from === -1) return false;
    this.cdvFileTabStop.focus(files[stepWithinGroup(files.length, from, delta)]);
    return true;
  }

  /** Put the graph's keyboard state back after a re-render, given the row that
   *  held focus before it (`focusedRowKey`, or null when focus was elsewhere).
   *
   *  `mayScroll` is false for every redraw but one — a redraw is not a move, so
   *  nothing may move on the user's behalf. The exception is the loaded-commit-
   *  window reset, where standing still is not the neutral choice: see
   *  {@link resetLoadedCommitWindow}. It arrives as an argument rather than as
   *  instance state so that it describes this redraw and no other.
   *
   *  Focus goes back onto the same commit, in its new row. Automatic loading on
   *  scroll is browsing, and browsing must leave the user where they were
   *  (ADR-0019) — but arrowing onto a row scrolls it into view, that scroll is
   *  what trips the load, and the load destroys the very row that focus was on.
   *  Without putting it back, the next Down key finds no focused row, falls
   *  through to its "enter the grid" branch and starts again from the first
   *  commit, hundreds of rows above where the user actually was. Arrow keys
   *  move between rows (ADR-0014); nothing else may move between them.
   *
   *  The tab stop follows focus, and when there is none to restore — focus was
   *  outside the graph, or the commit that held it is no longer loaded — it
   *  lands on the expanded commit's row, else the first commit. Without that,
   *  the table would carry no `tabindex="0"` at all and Tab would skip the
   *  graph entirely.
   *
   *  **This changes every other redraw too, deliberately.** Automatic loading
   *  is what forced the question, but every redraw runs `renderTable` — a soft
   *  refresh, a find, a branch-filter or commit-ordering change, toggling a
   *  column — and focus now survives all of them. That is the same argument,
   *  not a wider one: in each of those the user did not move focus either, so
   *  dropping it was never right. It is the mirror of ADR-0019's note that
   *  fixing the Commit Details View's auto-centre also stopped soft refreshes
   *  dragging the user back to the expanded commit — one cause, treated once,
   *  visible on every path that shared it. */
  private restoreGraphFocus(focusedKey: string | null, mayScroll: boolean) {
    const rows = this.graphRows();
    const refocused =
      focusedKey === null ? undefined : rows.find((row) => graphRowKey(row) === focusedKey);
    if (refocused !== undefined) {
      // `focusInPlace`, not `focusGraphRow`: a redraw is not a focus *move*, so
      // it may neither scroll nor — selection follows focus — swap the open
      // Commit Details View onto a commit the user never arrowed onto.
      // `focus` only when the caller shrank the loaded set on purpose, which is
      // the one case where standing still is not the neutral choice.
      if (mayScroll) this.graphTabStop.focus(refocused);
      else this.graphTabStop.focusInPlace(refocused);
      return;
    }
    const anchored = this.expandedCommit?.srcElem ?? null;
    const target =
      anchored !== null && rows.includes(anchored)
        ? anchored
        : (rows.find((row) => !isHeaderRow(row)) ?? rows[0]);
    if (target === undefined) return;
    this.graphTabStop.set(target);
    // No row holds focus, so there is none for the viewport to agree with — it
    // goes to where the graph now begins for the keyboard, which is this one.
    // `set`, not `focus`: the tab stop moves, focus does not. Since #88 focus
    // may be in the footer rather than dropped outright, and then this does
    // leave the two apart; `restoreFooterFocus` argues why that is the cheaper
    // of the two errors on the one path (the reset) where this scrolls at all.
    if (mayScroll && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "nearest" });
    }
  }

  /** Put the Commit Details View's file list back on the file that held focus
   *  before the redraw (`focusedCdvFileKey`, or null when focus was elsewhere).
   *
   *  This is {@link restoreGraphFocus}'s argument applied to the other roving
   *  group, and for the same reason: a redraw is not a focus *move*, so a
   *  browsing-triggered load (ADR-0019) may not take the user out of the list
   *  they were reading. It cost the user twice without this. Focus fell to
   *  `<body>`, and `moveCdvFileFocus` — which reads the focused file to decide
   *  whether the file list even owns the arrow keys — then found nothing and
   *  returned false, so the next Down key fell through to `moveRowFocus` and
   *  put them in the graph. Restoring the tab stop, which is all
   *  {@link restoreCdvFileTabStop} does, brought Tab back but not the arrow
   *  keys: the tab stop is where Tab *re-enters*, focus is where the arrows
   *  *continue from*, and only the second one was the user's place.
   *
   *  `focusInPlace`, so nothing scrolls. There is no `mayScroll` counterpart to
   *  the graph's here: the one redraw allowed to take the viewport with it is
   *  the loaded-commit-window reset, and that is a change to which *commits*
   *  are loaded — the graph's own restore carries the viewport there, and an
   *  inline panel travels with the row it hangs off while a docked one is
   *  fixed to the window. Either way the file is already wherever the commit
   *  is.
   *
   *  Looks the file up in {@link cdvFileRows} rather than the raw markup, so a
   *  restore can only land where the arrow keys can step from — a file buried
   *  in a collapsed folder is out of the focus order, and reaching it any other
   *  way would strand focus on a row the user cannot leave.
   *
   *  A miss changes nothing: the list keeps the tab stop
   *  `attachCdvFileListeners` gave it when the panel was rebuilt, or there is
   *  no panel to leave alone. The reachable miss is a redraw that has to
   *  *re-request* rather than redraw from cache — a comparison whose compared
   *  commit left the loaded set, or whose file changes are not cached. Those
   *  tear the panel down and wait for an answer that opens a view the user was
   *  never in. When the *expanded* commit is itself the one that left,
   *  `loadCommits` drops the panel before `renderTable` runs, so focus is
   *  already gone and there is no key to miss with. */
  private restoreCdvFileFocus(fileKey: string | null) {
    if (fileKey === null) return;
    const refocused = this.cdvFileRows().find((file) => cdvFileKey(file) === fileKey);
    if (refocused === undefined) return;
    this.cdvFileTabStop.focusInPlace(refocused);
  }

  /** Give the Commit Details View's file list a tab stop, so Tab can reach it
   *  at all. Re-run whenever the visible set changes — a fresh render leaves
   *  every row at `-1`, and collapsing a folder can bury the row that held it.
   *
   *  Only *this* list gets one. The branch-redundancy dialog's copy of a commit's
   *  files is left with no tab stop of its own and so is unreachable by keyboard
   *  — not a conclusion anyone reached, but a question that was asked and moved:
   *  #128 was told to decide whether that list should be its own roving group and
   *  the maintainer deferred it to **#145**, so that its own defect (the file
   *  actions crossing between the two lists) could be fixed without a keyboard
   *  design riding along. Read this as pending, not as settled. */
  private restoreCdvFileTabStop() {
    const held = this.cdvFileTabStop.current;
    if (held !== null && held.closest(".hidden") === null) return;
    const first = this.cdvFileRows()[0];
    if (first !== undefined) this.cdvFileTabStop.set(first);
  }

  /** Keep each group's tab stop wherever it last held focus, however focus got
   *  there — a click, Tab, or the arrow keys — so Tab returns to where the user
   *  left off rather than to the top of the graph.
   *
   *  Asked of {@link cdvFileRows} rather than matched as a bare `.gitFile`, for
   *  the same reason {@link focusedCdvFileKey} is: a `.gitFile` row is not proof
   *  of the Commit Details View. The branch-redundancy dialog renders its
   *  commit's files through the same `renderGitFileRow`, so focus landing on one
   *  of *its* rows would hand the panel's single tab stop to a row in the modal.
   *  Setting it is also what *takes* it: `set` demotes the previous holder, so
   *  the panel is left with no `tabindex="0"` at all and Tab steps straight past
   *  the file list. Nor does {@link restoreCdvFileTabStop} give one back while
   *  the dialog is open — it sees a holder that is still connected and still
   *  unhidden and returns early — and once the dialog closes and takes its rows
   *  with it, nothing calls that method until the panel is next rebuilt. So the
   *  list stays unreachable until some *other* thing redraws it: a refresh, a
   *  page of commits, a layout toggle. The dialog's rows belong to no roving
   *  group, so there is no tab stop of theirs to keep and none to hand them:
   *  leaving the panel's where it was is the whole of the fix. It claimed
   *  nothing about how those rows behave otherwise, and at the time they were
   *  not inert at all; the binding path has since been scoped the same way this
   *  one is (#128), so {@link commitFilesHtml} can now say they do nothing — on
   *  three conditions it lists there, the third of which is not about the rows
   *  and would be re-opened by #145 or #141.
   *
   *  The `.gitFile` match survives in front of the scope check as a cheap way
   *  in, not as a second scoping rule: `cdvFileRows` is the only thing that says
   *  what counts, and everything it returns is a `.gitFile`. Without it every
   *  `focusin` anywhere — each row an arrow key steps onto in the graph — scans
   *  the panel and builds an array of its rows, to ask a question whose answer
   *  is already no. */
  public syncTabStop(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) return;
    if (target.matches(".gitFile") && this.cdvFileRows().includes(target)) {
      this.cdvFileTabStop.set(target);
    } else if (target.closest("#commitTable") !== null && target.matches(GRAPH_FOCUSABLE)) {
      this.graphTabStop.set(target);
    }
  }

  /** Navigate the expanded Commit Details View along the graph: to the first
   *  parent ("parent") or to a child commit that lists it as a parent
   *  ("child"). Returns false (no-op) when there's no such commit loaded. */
  public commitDetailsNavigateGraph(
    direction: "parent" | "child",
    alternative: boolean = false
  ): boolean {
    if (this.expandedCommit === null || this.expandedCommit.srcElem === null) return false;
    const current = this.commits[this.expandedCommit.id];
    if (current === undefined) return false;
    const targetHash = graphNavigationTarget(current, this.commits, direction, alternative);
    if (targetHash === undefined || this.commitLookup[targetHash] === undefined) return false;
    // By id, and so only ever the graph's: `commitLookup` indexes `this.commits`,
    // and `data-id` carries that index on rows `renderTable` wrote. Read
    // document-wide the number would have been matched against whatever else
    // happened to carry the attribute, and handed to `loadCommitDetails` as the
    // panel's new source. See {@link graphRowById}.
    const elem = this.graphRowById(this.commitLookup[targetHash]);
    if (elem === null) return false;
    this.loadCommitDetails(elem);
    return true;
  }
  public showCommitDetails(commitDetails: GitCommitDetails, fileTree: GitFolder) {
    if (
      this.expandedCommit === null ||
      this.expandedCommit.srcElem === null ||
      this.expandedCommit.hash !== commitDetails.hash
    )
      return;
    let elem = document.getElementById("commitDetails");
    if (typeof elem === "object" && elem !== null) elem.remove();

    if (this.config.fileTreeCompactFolders) compactGitFileTree(fileTree);
    this.expandedCommit.commitDetails = commitDetails;
    this.expandedCommit.fileTree = fileTree;
    this.expandedCommit.srcElem.classList.add("commitDetailsOpen");
    this.saveState();

    this.renderCommitDetailsPanel(
      this.commitSummaryHtml(commitDetails, true),
      commitDetails.fileChanges,
      fileTree
    );
  }

  /**
   * The Commit Details View's summary block — the key/value header, avatar and
   * message body. Shared with the branch-redundancy dialog, which renders the
   * same commit the same way.
   *
   * **`interactive` governs the hashes only — never the mailto links.** Both
   * `.commitBodyLink`s are emitted unconditionally, so a caller passing `false`
   * still gets two elements of a class the Commit Details View binds a context
   * menu to. That read as "the dialog's summary is inert" for as long as the
   * binding was document-wide, and it was not: the panel's Copy Link menu opened
   * on the dialog's links after any redraw (#144). The binding is scoped to the
   * panel now, so the claim holds — but it holds because of where the *handler*
   * goes, not because of this flag, and a third surface rendering a summary
   * would inherit the markup without inheriting the scope.
   *
   * `interactive` is false for that dialog: the clickable parent hashes and the
   * hashes linkified inside the body both navigate the graph's own rows, and a
   * commit listed in a dialog need not be among them.
   */
  public commitSummaryHtml(commitDetails: GitCommitDetails, interactive: boolean): string {
    let html =
      '<span class="commitDetailsSummaryTop' +
      (typeof this.avatars[commitDetails.email] === "string" ? " withAvatar" : "") +
      '"><span class="commitDetailsSummaryTopRow"><span class="commitDetailsSummaryKeyValues">';
    html += "<b>" + l10n.detailCommit + "</b>" + escapeHtml(commitDetails.hash) + "<br>";
    html +=
      "<b>" +
      l10n.detailParents +
      "</b>" +
      commitDetails.parents
        .map((p) =>
          interactive && this.commitLookup[p] !== undefined
            ? '<span class="commitBodyHash" data-hash="' + p + '">' + abbrevCommit(p) + "</span>"
            : abbrevCommit(p)
        )
        .join(", ") +
      "<br>";
    html +=
      "<b>" +
      l10n.detailAuthor +
      "</b>" +
      escapeHtml(commitDetails.author) +
      ' &lt;<a class="commitBodyLink" href="mailto:' +
      encodeURIComponent(commitDetails.email) +
      '">' +
      escapeHtml(commitDetails.email) +
      "</a>&gt;<br>";
    html +=
      "<b>" +
      l10n.detailDate +
      "</b>" +
      new Date(commitDetails.authorDate * 1000).toString() +
      "<br>";
    html +=
      "<b>" +
      l10n.detailCommitter +
      "</b>" +
      escapeHtml(commitDetails.committer) +
      ' &lt;<a class="commitBodyLink" href="mailto:' +
      encodeURIComponent(commitDetails.committerEmail) +
      '">' +
      escapeHtml(commitDetails.committerEmail) +
      "</a>&gt;";
    // Show the commit date too when it differs from the author date.
    if (commitDetails.commitDate !== commitDetails.authorDate) {
      html +=
        "<br><b>" +
        l10n.detailCommitDate +
        "</b>" +
        new Date(commitDetails.commitDate * 1000).toString();
    }
    html += "</span>";
    if (typeof this.avatars[commitDetails.email] === "string")
      html +=
        '<span class="commitDetailsSummaryAvatar"><img src="' +
        this.avatars[commitDetails.email] +
        '"></span>';
    html += "</span></span><br><br>";
    const resolveHash = (token: string): string | null => {
      if (!interactive) return null;
      if (this.commitLookup[token] !== undefined) return token;
      for (const h in this.commitLookup) {
        if (h.startsWith(token)) return h;
      }
      return null;
    };
    let body = preserveLeadingWhitespace(
      linkifyUrls(
        replaceEmojiShortcodes(commitDetails.body, this.config.customEmojiShortcodeMappings),
        (t) =>
          linkifyCommitHashes(t, resolveHash, (t2) =>
            linkifyIssues(t2, this.config.issueLinkingRegex, this.config.issueLinkingUrl)
          )
      )
    );
    if (this.config.markdown) body = renderInlineMarkdown(body);
    return html + body.replace(/\n/g, "<br>");
  }

  /** Show the comparison of the two commits referenced by the expanded commit's
   *  `compareFromHash` → `compareToHash`. Builds a summary line and the
   *  same file tree/list + actions as the single-commit details view. */
  public showCommitComparison(
    fromHash: string,
    toHash: string,
    fileChanges: GitFileChange[],
    fileTree: GitFolder
  ) {
    if (
      this.expandedCommit === null ||
      this.expandedCommit.srcElem === null ||
      this.expandedCommit.compareWithHash === null ||
      this.expandedCommit.compareFromHash === null ||
      this.expandedCommit.compareToHash === null ||
      // Ignore a stale response that no longer matches the open comparison.
      this.expandedCommit.compareFromHash !== fromHash ||
      this.expandedCommit.compareToHash !== toHash
    )
      return;
    let elem = document.getElementById("commitDetails");
    if (typeof elem === "object" && elem !== null) elem.remove();

    if (this.config.fileTreeCompactFolders) compactGitFileTree(fileTree);
    this.expandedCommit.compareFileChanges = fileChanges;
    this.expandedCommit.fileTree = fileTree;
    this.expandedCommit.srcElem.classList.add("commitDetailsOpen");
    if (this.expandedCommit.compareWithSrcElem !== null)
      this.expandedCommit.compareWithSrcElem.classList.add("commitDetailsOpen");
    this.saveState();

    const html = l10n.comparingCommits
      .replace("{0}", "<b>" + abbrevCommit(this.expandedCommit.compareFromHash) + "</b>")
      .replace("{1}", "<b>" + abbrevCommit(this.expandedCommit.compareToHash) + "</b>");
    this.renderCommitDetailsPanel(html, fileChanges, fileTree);
  }

  /** Apply the per-repo inline Commit Details View height & divider, and wire
   *  the drag handles to resize them, persisting on release. */
  private setupCdvResize(row: HTMLElement) {
    const repoState = this.gitRepos[this.currentRepo];
    const summary = document.getElementById("commitDetailsSummary");
    const files = document.getElementById("commitDetailsFiles");
    const divider = document.getElementById("detailsDivider");
    const heightGrip = document.getElementById("detailsResizeGrip");
    // `repoState` joins the DOM lookups rather than being asserted: everything
    // below reads a per-repo size or writes one back, and a panel with no
    // repository selected has neither. Both halves are the same kind of
    // absence — the pieces this needs are not there — and both leave the view
    // at its CSS defaults rather than throwing mid-render.
    if (
      repoState === undefined ||
      summary === null ||
      files === null ||
      divider === null ||
      heightGrip === null
    ) {
      return;
    }

    if (typeof repoState.detailsPanelHeight === "number")
      row.style.height = repoState.detailsPanelHeight + "px";
    let ratio = typeof repoState.detailsDivider === "number" ? repoState.detailsDivider : 0.45;
    const applyDivider = () => {
      const pct = (ratio * 100).toFixed(2) + "%";
      summary.style.width = pct;
      files.style.left = pct;
      divider.style.left = pct;
    };
    applyDivider();

    const drag = (onMove: (e: MouseEvent) => void, persist: () => void) => {
      const move = (e: MouseEvent) => onMove(e);
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        persist();
        this.saveState();
        sendMessage({
          command: "saveRepoState",
          repo: this.currentRepo!,
          state: repoState
        });
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    };

    divider.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const cell = divider.parentElement!; // the description <td> (position:relative)
      drag(
        (ev) => {
          const rect = cell.getBoundingClientRect();
          ratio = Math.min(0.9, Math.max(0.1, (ev.clientX - rect.left) / rect.width));
          applyDivider();
        },
        () => (repoState.detailsDivider = ratio)
      );
    });

    heightGrip.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = row.getBoundingClientRect().height;
      let height = startHeight;
      drag(
        (ev) => {
          height = Math.min(800, Math.max(100, startHeight + (ev.clientY - startY)));
          row.style.height = height + "px";
          this.renderGraph();
        },
        () => (repoState.detailsPanelHeight = Math.round(height))
      );
    });
  }

  /** Build the `#commitDetails` row from a prepared summary fragment plus the
   *  file tree/list, insert it after the expanded commit, and wire up the file
   *  actions. Shared by the commit-details and commit-comparison views. */
  private renderCommitDetailsPanel(
    summaryHtml: string,
    fileChanges: GitFileChange[],
    fileTree: GitFolder
  ) {
    if (this.expandedCommit === null || this.expandedCommit.srcElem === null) return;
    const fileViewType = this.getFileViewType();
    // Shared inner content: summary + file tree/list + right-hand toolbar
    // (close button above the tree/list layout toggle).
    const inner =
      '<div id="commitDetailsSummary">' +
      summaryHtml +
      "</div>" +
      '<div id="commitDetailsFiles">' +
      this.generateCdvFilesHtml(fileChanges, fileTree, fileViewType) +
      "</table></div>" +
      // Draggable summary/files divider and bottom height grip (inline only).
      '<div id="detailsDivider"></div>' +
      '<div id="detailsResizeGrip"></div>' +
      '<div id="commitDetailsClose">' +
      svgIcons.close +
      "</div>" +
      '<div id="cdvFileViewToggle">' +
      '<div class="cdvFileViewBtn' +
      (fileViewType === "File Tree" ? " active" : "") +
      '" data-viewtype="File Tree" title="' +
      l10n.fileLayoutTree +
      '">' +
      svgIcons.fileTreeView +
      "</div>" +
      '<div class="cdvFileViewBtn' +
      (fileViewType === "File List" ? " active" : "") +
      '" data-viewtype="File List" title="' +
      l10n.fileLayoutList +
      '">' +
      svgIcons.fileListView +
      "</div>" +
      "</div>";

    const docked = this.isCdvDocked();
    let newElem: HTMLElement;
    if (docked) {
      // Docked to bottom: a fixed panel below the graph rather than a row
      // inserted into the table, so the graph keeps its full height (no gap).
      newElem = document.createElement("div");
      newElem.id = "commitDetails";
      newElem.className = "docked";
      newElem.innerHTML = inner;
      document.body.appendChild(newElem);
      document.body.classList.add("cdvDocked");
    } else {
      newElem = document.createElement("tr");
      newElem.id = "commitDetails";
      newElem.innerHTML = '<td></td><td colspan="4">' + inner + "</td>";
      insertAfter(newElem, this.expandedCommit.srcElem);
      this.setupCdvResize(newElem); // height + divider drag, inline only
    }

    this.renderGraph();

    // Bringing the CDV into view belongs to *opening* it, not to drawing it.
    // renderTable re-renders the panel on every reload that leaves it open —
    // a Load More page, a soft refresh — and the user asked for none of those:
    // re-running this would drag them back to the expanded commit from
    // wherever they had scrolled to, which on the auto-load-on-scroll path
    // means fighting the scroll that triggered the load (ADR-0019: automatic
    // loading is browsing, and browsing must not move anything). So it runs
    // once per CDV, and again only when the CDV becomes a different one.
    const cdv = this.cdvIdentity();
    if (!docked && cdv !== this.cdvBroughtIntoView) {
      this.cdvBroughtIntoView = cdv;
      if (this.config.autoCenterCommitDetailsView) {
        // Center Commit Detail View setting is enabled
        // control menu height [40px] + newElem.y + (commit details view height [250px] + commit height [24px]) / 2 - (window height) / 2
        window.scrollTo(0, newElem.offsetTop + 177 - window.innerHeight / 2);
      } else if (newElem.offsetTop + 8 < window.pageYOffset) {
        // Commit Detail View is opening above what is visible on screen
        // control menu height [40px] + newElem y - commit height [24px] - desired gap from top [8px] < pageYOffset
        window.scrollTo(0, newElem.offsetTop + 8);
      } else if (
        newElem.offsetTop + this.config.grid.expandY - window.innerHeight + 48 >
        window.pageYOffset
      ) {
        // Commit Detail View is opening below what is visible on screen
        // control menu height [40px] + newElem y + commit details view height [250px] + desired gap from bottom [8px] - window height > pageYOffset
        window.scrollTo(0, newElem.offsetTop + this.config.grid.expandY - window.innerHeight + 48);
      }
    }

    document.getElementById("commitDetailsClose")!.addEventListener("click", () => {
      this.hideCommitDetails();
    });
    // Nothing this function binds goes through `addListenerToClass`. Only the
    // last of the three was actually leaking, but the panel is a surface the
    // dialog copies wholesale, and a scoped call sitting next to an unscoped one
    // is how the next class family gets bound the wrong way while reading
    // exactly like its neighbours (#144).
    this.addCdvListenerToClass("cdvFileViewBtn", "click", (e) => {
      const btn = <HTMLElement>(<Element>e.target).closest(".cdvFileViewBtn")!;
      this.setFileViewType(<GG.FileViewType>btn.dataset.viewtype);
    });
    this.attachCdvFileListeners();
    this.addCdvListenerToClass("commitBodyHash", "click", (e) => {
      let sourceElem = <HTMLElement>(<Element>e.target).closest(".commitBodyHash")!;
      // The chip is bound within the *panel*, but its destination is a *graph*
      // row: the click means "show me that commit in the graph", and what it
      // finds is handed to `loadCommitDetails` as the panel's next source. Two
      // roots one line apart, and they are not the same one — a docked panel is
      // not inside the table at all. See {@link graphRowByHash}.
      let row = this.graphRowByHash(sourceElem.dataset.hash!);
      if (row !== null) {
        if (typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "center" });
        this.loadCommitDetails(row);
      }
    });
    // The dialog renders these too: `commitSummaryHtml` emits `.commitBodyLink`
    // whether or not it is `interactive`, so asking for the non-interactive
    // rendering does not opt out of them. Their scope is the panel's rather than
    // the table's — a docked panel is not inside `#commitTable` at all.
    this.addCdvContextMenuListener("commitBodyLink", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      let sourceElem = <HTMLElement>(<Element>e.target).closest(".commitBodyLink")!;
      showContextMenu(
        <MouseEvent>e,
        [
          {
            title: l10n.copyLink,
            onClick: () => {
              sendMessage({
                command: "copyToClipboard",
                type: "Link",
                data: sourceElem.textContent ?? ""
              });
            }
          }
        ],
        sourceElem
      );
    });
  }

  /** The Commit Details View's root, named: the only binder
   *  {@link attachCdvFileListeners} or {@link renderCommitDetailsPanel} may use,
   *  binding within {@link cdvPanel} instead of across the whole document.
   *
   *  Scope belongs to the caller that knows what it renders, and the one this
   *  caller needs already existed: {@link cdvPanel}, drawn for the focus path by
   *  #113. Not a second scoping rule — the same one.
   *
   *  Binding, unlike {@link cdvFileRows}, must reach rows inside a *collapsed*
   *  folder as well: opening a folder unhides its rows without re-rendering
   *  anything, and nothing re-binds afterwards.
   *
   *  No panel means nothing to bind — but that is unreachable today rather than
   *  a case being handled: every caller has the panel in the document first.
   *  {@link renderCommitDetailsPanel} binds only after it has inserted the panel
   *  and reached into it by id, and both callers of
   *  {@link attachCdvFileListeners} are downstream of that. The check is here
   *  and not in {@link addGraphListenerToClass} because only this root can be
   *  missing — see {@link addScopedListenerToClass}.
   *
   *  **The rest of the family arrived with #144, and it needed a second scope
   *  rather than this one.** The dialog's copy of a commit also carries
   *  `.commitBodyLink` — the author and committer mailto links, which
   *  {@link commitSummaryHtml} emits whether or not it is `interactive` — and
   *  `tr.commit` rows of its own. The links are the panel's, so they bind
   *  through here. The commit rows are the *graph's*, and the graph is a
   *  different element: {@link addGraphListenerToClass} binds those within
   *  `#commitTable`. Neither scope contains the other — a docked panel is
   *  appended to `<body>`, outside the table entirely — so this is two
   *  boundaries because there are two surfaces, not two rules. */
  private addCdvListenerToClass(className: string, event: string, listener: EventListener) {
    const panel = this.cdvPanel();
    if (panel === null) return;
    this.addScopedListenerToClass(panel, className, event, listener);
  }

  /** {@link addCdvListenerToClass}'s context-menu pair, wiring both ways of
   *  raising one within {@link cdvPanel}. */
  private addCdvContextMenuListener(className: string, listener: EventListener) {
    const panel = this.cdvPanel();
    if (panel === null) return;
    this.addScopedContextMenuListener(panel, className, listener);
  }

  /** Wire up the file rows of the Commit Details View file tree/list. Called on
   *  each render of the panel and again whenever the file section is re-rendered
   *  by the tree/list layout toggle (the old rows are replaced wholesale).
   *
   *  **Every binding here goes through {@link addCdvListenerToClass}, never
   *  `addListenerToClass`.** Being called repeatedly is what makes that
   *  load-bearing: an unscoped bind reaches rows that this function's callers do
   *  not replace — the branch-redundancy dialog's — and leaves one more copy of
   *  each handler on them every time (#128). */
  private attachCdvFileListeners() {
    this.restoreCdvFileTabStop();
    this.addCdvListenerToClass("gitFolder", "click", (e) => {
      let sourceElem = <HTMLElement>(<Element>e.target!).closest(".gitFolder");
      let parent = sourceElem.parentElement!;
      parent.classList.toggle("closed");
      let isOpen = !parent.classList.contains("closed");
      parent.children[0].children[0].innerHTML = isOpen
        ? svgIcons.openFolder
        : svgIcons.closedFolder;
      parent.children[1].classList.toggle("hidden");
      // Both `!`s rest on the scope, not on luck: this handler only exists on
      // rows inside {@link cdvPanel}, and `clearExpandedCommit` removes that
      // panel and nulls `expandedCommit` in the same breath. Unscoped, the
      // dialog's rows kept the handler after the panel closed and this line
      // threw for every redraw the dialog had lived through (#128) — which is
      // why the fix is the scope rather than a null check here.
      alterGitFileTree(
        this.expandedCommit!.fileTree!,
        decodeURIComponent(sourceElem.dataset.folderpath!),
        isOpen
      );
      // Collapsing a folder can bury the row holding the list's tab stop.
      this.restoreCdvFileTabStop();
      this.saveState();
    });
    this.addCdvListenerToClass("gitFile", "click", (e) => {
      let sourceElem = <HTMLElement>(<Element>e.target).closest(".gitFile")!;
      if (this.expandedCommit === null) return;
      // If the entry is a known sub-repository (e.g. a changed submodule gitlink),
      // load it in GING instead of trying to diff the gitlink.
      const subrepo = this.subrepoForPath(decodeURIComponent(sourceElem.dataset.newfilepath!));
      if (subrepo !== null) {
        this.switchToRepo(subrepo);
        return;
      }
      if (!sourceElem.classList.contains("gitDiffPossible")) return;
      const newFilePath = decodeURIComponent(sourceElem.dataset.newfilepath!);
      sendMessage({
        command: "viewDiff",
        repo: this.currentRepo!,
        commitHash: this.cdvHash,
        fromHash: this.cdvFromHash,
        oldFilePath: decodeURIComponent(sourceElem.dataset.oldfilepath!),
        newFilePath,
        type: <GitFileChangeType>sourceElem.dataset.type
      });
    });
    this.addCdvListenerToClass("gitFileCopyPath", "click", (e) => {
      e.stopPropagation(); // don't also trigger the file's view-diff click
      let sourceElem = <HTMLElement>(<Element>e.target).closest(".gitFileCopyPath")!;
      sendMessage({
        command: "copyToClipboard",
        type: "File Path",
        data: decodeURIComponent(sourceElem.dataset.filepath!)
      });
    });
    this.addCdvContextMenuListener("gitFile", (e: Event) => {
      e.stopPropagation();
      if (this.expandedCommit === null) return;
      const sourceElem = <HTMLElement>(<Element>e.target).closest(".gitFile")!;
      const filePath = decodeURIComponent(sourceElem.dataset.newfilepath!);
      const fileType = sourceElem.dataset.type;
      const commitHash = this.cdvHash;
      const fromHash = this.cdvFromHash;
      const oldFilePath = decodeURIComponent(sourceElem.dataset.oldfilepath!);
      const notDeleted = fileType !== "D";
      // Per-action visibility; each action can be hidden via config.
      const v = viewState.contextMenuActionsVisibility.commitDetailsViewFile;
      const menu: ContextMenuElement[] = [];
      // Mirror the row's hover actions in the context menu.
      if (sourceElem.classList.contains("gitDiffPossible") && v.viewDiff) {
        menu.push({
          title: l10n.viewDiff,
          icon: "fileDiff",
          onClick: () =>
            sendMessage({
              command: "viewDiff",
              repo: this.currentRepo!,
              commitHash,
              fromHash,
              oldFilePath,
              newFilePath: filePath,
              type: <GitFileChangeType>fileType
            })
        });
      }
      // Open File / View File at Revision / View Diff with Working don't apply
      // to files deleted at this commit (mirrors the hover-button availability).
      if (notDeleted && v.viewFileAtThisRevision) {
        menu.push({
          title: l10n.viewFileAtRevision,
          icon: "viewRevision",
          onClick: () =>
            sendMessage({
              command: "viewFileAtRevision",
              repo: this.currentRepo!,
              commitHash,
              filePath
            })
        });
      }
      if (notDeleted && v.viewDiffWithWorkingFile) {
        menu.push({
          title: l10n.viewDiffWithWorking,
          icon: "compare",
          onClick: () =>
            sendMessage({
              command: "viewDiffWithWorking",
              repo: this.currentRepo!,
              commitHash,
              filePath
            })
        });
      }
      if (notDeleted && v.openFile) {
        menu.push({
          title: l10n.openFile,
          icon: "openFile",
          onClick: () =>
            sendMessage({ command: "openFile", repo: this.currentRepo!, filePath, commitHash })
        });
      }
      // Resetting a deleted file's revision would just re-create it; offer it
      // only for files that still exist at this commit.
      if (notDeleted && v.resetFileToThisRevision) {
        menu.push({
          title: l10n.resetFileToRevision + ELLIPSIS,
          icon: "history",
          onClick: () => {
            this.confirmForRepo(
              l10n.dialogResetFileConfirm
                .replace("{0}", "<b><i>" + escapeHtml(filePath) + "</i></b>")
                .replace("{1}", "<b><i>" + abbrevCommit(commitHash) + "</i></b>"),
              (repo) => {
                sendMessage({
                  command: "resetFileToRevision",
                  repo,
                  commitHash,
                  filePath
                });
              },
              null
            );
          }
        });
      }
      if (v.copyFilePath) {
        menu.push({
          title: l10n.copyFilePath,
          onClick: () => {
            sendMessage({ command: "copyToClipboard", type: "File Path", data: filePath });
          }
        });
      }
      showContextMenu(<MouseEvent>e, menu, sourceElem);
    });
    this.addCdvListenerToClass("gitFileOpen", "click", (e) => {
      e.stopPropagation(); // don't also trigger the file's view-diff click
      let sourceElem = <HTMLElement>(<Element>e.target).closest(".gitFileOpen")!;
      sendMessage({
        command: "openFile",
        repo: this.currentRepo!,
        filePath: decodeURIComponent(sourceElem.dataset.filepath!),
        commitHash: this.cdvHash
      });
    });
    this.addCdvListenerToClass("gitFileViewRev", "click", (e) => {
      e.stopPropagation(); // don't also trigger the file's view-diff click
      if (this.expandedCommit === null) return;
      let sourceElem = <HTMLElement>(<Element>e.target).closest(".gitFileViewRev")!;
      sendMessage({
        command: "viewFileAtRevision",
        repo: this.currentRepo!,
        commitHash: this.cdvHash,
        filePath: decodeURIComponent(sourceElem.dataset.filepath!)
      });
    });
    this.addCdvListenerToClass("gitFileDiffWorking", "click", (e) => {
      e.stopPropagation(); // don't also trigger the file's view-diff click
      if (this.expandedCommit === null) return;
      let sourceElem = <HTMLElement>(<Element>e.target).closest(".gitFileDiffWorking")!;
      sendMessage({
        command: "viewDiffWithWorking",
        repo: this.currentRepo!,
        commitHash: this.cdvHash,
        filePath: decodeURIComponent(sourceElem.dataset.filepath!)
      });
    });
  }

  /** The Commit Details View file layout: the per-repo choice when one has
   *  been made via the panel's toolbar, otherwise the global setting. */
  private getFileViewType(): GG.FileViewType {
    return this.gitRepos[this.currentRepo]?.fileViewType ?? this.config.fileViewType;
  }

  /** The avatar span of a commit table's author cell — empty until the image
   *  for that address has been fetched, and empty entirely when avatars are
   *  turned off. Shared with the branch-redundancy dialog's list. */
  public avatarHtml(email: string): string {
    if (!this.config.fetchAvatars) return "";
    return (
      '<span class="avatar" data-email="' +
      escapeHtml(email) +
      '">' +
      (typeof this.avatars[email] === "string"
        ? '<img class="avatarImg" src="' + this.avatars[email] + '">'
        : "") +
      "</span>"
    );
  }

  /** The Commit Details View's file section for a set of changes, in whichever
   *  layout the repo is set to. Shared with the branch-redundancy dialog so a
   *  commit's files read the same wherever they are shown.
   *
   *  **The dialog's copy is inert, and it rests on three legs, not one.** First,
   *  nothing here binds a listener — the generator emits markup only. Second,
   *  the panel's own binding stays out: {@link attachCdvFileListeners} goes
   *  through {@link addCdvListenerToClass}, scoped to {@link cdvPanel}. Third —
   *  and this leg is held up by something that is not about these rows at all —
   *  the rows ship at `tabindex="-1"` and match both `MENU_SOURCES` and
   *  `ACTIVATABLE`, whose handlers *are* still document-wide; what keeps them
   *  off is that the one document `keydown` listener returns as soon as
   *  `isDialogOpen()`, above every branch that reads either constant, and a
   *  dialog row exists only while a dialog is open.
   *
   *  **So check the third leg when #145 or #141 lands.** #145 would give these
   *  rows a tab stop, and #141 would contain focus in the dialog; either changes
   *  what can be focused here, and the third leg survives only because that
   *  early return outranks the branches — not because the rows are unreachable.
   *  The first two legs are this ticket's and hold on their own.
   *
   *  This comment claimed inertness for years on a different ground that was never
   *  true — that the row actions are bound to the graph's expanded row — while
   *  the binding actually went through `addListenerToClass`, i.e.
   *  `document.getElementsByClassName`, which has no scope at all. Every call of
   *  `attachCdvFileListeners` reached every `.gitFile` on the page, the dialog's
   *  included, so after one redraw a click here sent `viewDiff` carrying the
   *  path from *that* row and the commit from the graph's expanded one, and each
   *  further redraw bound another copy (#128). The claim is kept, its reason
   *  replaced: an inert list is a property of who binds, not of who renders, and
   *  the next person to render a commit's files somewhere new inherits the
   *  claim only if they leave the scope alone. */
  public commitFilesHtml(fileChanges: GitFileChange[]): string {
    const fileTree = generateGitFileTree(fileChanges);
    if (this.config.fileTreeCompactFolders) compactGitFileTree(fileTree);
    return this.generateCdvFilesHtml(fileChanges, fileTree, this.getFileViewType());
  }

  private generateCdvFilesHtml(
    fileChanges: GitFileChange[],
    fileTree: GitFolder,
    fileViewType: GG.FileViewType
  ): string {
    return fileViewType === "File List"
      ? generateGitFileListHtml(fileChanges, this.config.enhancedAccessibility)
      : generateGitFileTreeHtml(fileTree, fileChanges, this.config.enhancedAccessibility);
  }

  /** Switch the open Commit Details View between the tree and list file
   *  layouts: persist the choice for the repo, re-render the file section in
   *  place, and reflect the active state on the toggle buttons. */
  private setFileViewType(fileViewType: GG.FileViewType) {
    if (fileViewType !== "File Tree" && fileViewType !== "File List") return;
    if (fileViewType === this.getFileViewType()) return;
    // Nowhere to persist the choice to, so there is no choice to make. Reached
    // only through a Commit Details View left open over a panel that has since
    // lost its repository; {@link getFileViewType} already falls back to the
    // setting on the read side.
    const repoState = this.gitRepos[this.currentRepo];
    if (repoState === undefined) return;
    repoState.fileViewType = fileViewType;
    this.saveState();
    sendMessage({
      command: "saveRepoState",
      repo: this.currentRepo,
      state: repoState
    });

    const expanded = this.expandedCommit;
    const filesElem = document.getElementById("commitDetailsFiles");
    if (expanded === null || expanded.fileTree === null || filesElem === null) return;
    const fileChanges = expanded.compareFileChanges ?? expanded.commitDetails?.fileChanges;
    if (fileChanges === undefined) return;
    filesElem.innerHTML = this.generateCdvFilesHtml(fileChanges, expanded.fileTree, fileViewType);
    this.attachCdvFileListeners();
    const buttons = document.getElementsByClassName("cdvFileViewBtn");
    for (let i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle(
        "active",
        (<HTMLElement>buttons[i]).dataset.viewtype === fileViewType
      );
    }
  }
}

let contextMenu = document.getElementById("contextMenu")!,
  contextMenuSource: HTMLElement | null = null,
  // Whether the open menu's source was made focusable for the occasion, so that
  // closing removes only what opening added. The graph's own sources carry a
  // tabindex permanently now; a commit-message link is an <a href> and needs
  // none. What's left is anything else that grows a menu later.
  contextMenuSourceBorrowedFocus = false;
let dialog = document.getElementById("dialog")!,
  dialogBacking = document.getElementById("dialogBacking")!,
  dialogMenuSource: HTMLElement | null = null,
  /** The open dialog's dismissal hook, if it declared one.
   *
   *  Held here rather than only inside the Dismiss button's click closure,
   *  because the button is not the only way a dialog closes: Escape closes one,
   *  and so does a background reload that finds its own progress dialog still
   *  up. A hook wired to one route out of three is not a hook, it is a
   *  coincidence.
   *
   *  The five of them do quite different things, and it is worth not flattening
   *  that. The cleanup refetch clears the state a late answer would otherwise
   *  put back on screen; the cleanup scan stops work the host is still doing,
   *  and stops *only* that — Stop is a "come back with what you found"
   *  contract, so the answer still arrives and still fills the dialog back in;
   *  the error dialog and the batch summary go and fetch what they were
   *  standing in front of (the conflict banner); the batch retry's decline ends
   *  a run that did real work, and opens a summary dialog of its own. What they
   *  share is only the occasion — the user is done with this dialog — and that
   *  is as true of the routes that close it *for* them as of the button.
   *
   *  Set on every {@link showDialog}, including the ones that overwrite an open
   *  dialog, so a stale hook can never outlive its dialog. Overwriting does not
   *  *run* the hook it replaces: an answer that legitimately replaces the
   *  dialog it was awaited by is not a dismissal — `handleBranchCleanupOpen`
   *  builds the new `cleanupState` before rendering over the refetch dialog,
   *  and running that dialog's hook would null it straight back out. */
  dialogDismissAction: (() => void) | null = null;
// "Remember my choice" values per dialog key, seeded from the extension host at
// load and updated optimistically on each confirm (the save message is one-way).
let dialogMemory: GG.DialogMemoryStore = viewState.dialogMemory ?? {};
let gitGraph = new GitGraphView(
  viewState.repos,
  viewState.lastActiveRepo,
  {
    autoCenterCommitDetailsView: viewState.autoCenterCommitDetailsView,
    commitDetailsViewLocation: viewState.commitDetailsViewLocation,
    branchLabelsAlignedToGraph:
      viewState.referenceLabelAlignment === "Branches (aligned to the graph) & Tags (on the right)",
    tagLabelsRightAligned: viewState.referenceLabelAlignment !== "Normal",
    combineLocalAndRemoteBranchLabels: viewState.combineLocalAndRemoteBranchLabels,
    dialogDeleteBranchForceDelete: viewState.dialogDeleteBranchForceDelete,
    dialogCherryPickNoCommit: viewState.dialogCherryPickNoCommit,
    dialogAddTagType: viewState.dialogAddTagType,
    dialogCreateBranchCheckOut: viewState.dialogCreateBranchCheckOut,
    dialogMergeNoFastForward: viewState.dialogMergeNoFastForward,
    dialogMergeSquash: viewState.dialogMergeSquash,
    dialogResetMode: viewState.dialogResetMode,
    customBranchGlobPatterns: viewState.customBranchGlobPatterns,
    customEmojiShortcodeMappings: viewState.customEmojiShortcodeMappings,
    enhancedAccessibility: viewState.enhancedAccessibility,
    fetchAvatars: viewState.fetchAvatars,
    fileTreeCompactFolders: viewState.fileTreeCompactFolders,
    fileViewType: viewState.fileViewType,
    graphColours: viewState.graphColours,
    graphStyle: viewState.graphStyle,
    grid: { x: 16, y: 24, offsetX: 8, offsetY: 12, expandY: 250 },
    initialLoadCommits: viewState.initialLoadCommits,
    issueLinkingRegex: viewState.issueLinkingRegex,
    issueLinkingUrl: viewState.issueLinkingUrl,
    loadMoreAutomatically: viewState.loadMoreAutomatically,
    loadMoreCount: viewState.loadMoreCount,
    markdown: viewState.markdown,
    muteCommitsNotAncestorsOfHead: viewState.muteCommitsNotAncestorsOfHead,
    muteMergeCommits: viewState.muteMergeCommits,
    signCommits: viewState.signCommits,
    onLoadScrollToHead: viewState.onLoadScrollToHead,
    showCurrentBranchByDefault: viewState.showCurrentBranchByDefault,
    uncommittedChangesAtHead: viewState.uncommittedChangesAtHead,
    showSpecificBranches: viewState.showSpecificBranches,
    showRemoteBranches: viewState.showRemoteBranches,
    showTags: viewState.showTags
  },
  vscode.getState() ?? null
);

/* Conflict prediction (merge dialogs) */
// Correlates an async predictConflicts response with the dialog that asked for
// it: only one dialog is open at a time, but a stale response from a previous
// dialog must not fill a newer one.
let conflictPredictionSeq = 0;
function conflictPredictionPlaceholder(repo: string, theirs: string): string {
  const token = ++conflictPredictionSeq;
  sendMessage({ command: "predictConflicts", repo, ours: "HEAD", theirs, token });
  return (
    '<br><span id="conflictPrediction" class="conflictPrediction checking" data-token="' +
    token +
    '">' +
    escapeHtml(l10n.conflictPredictionChecking) +
    "</span>"
  );
}

/* Branch redundancy (on-demand check) */
// Correlates an answer with the request that asked for it. The check runs a
// merge and may scan history, so it can outlive the dialog that started it: a
// late answer must neither replace whatever the user opened in the meantime nor
// reappear after they dismissed the "checking" dialog.
let redundancyCheckSeq = 0;
/** The repo the open dialog is reporting on, for its lazy detail requests. */
let redundancyRepo: string | null = null;

/** Ask whether `branch` still has anything to contribute to the default branch.
 *  Deliberately reports and forgets: the answer is a snapshot, and folding it
 *  into the always-on merged badge would break that badge's "safe to delete"
 *  promise (ADR-0006). */
function requestBranchRedundancy(repo: string, branch: string) {
  redundancyRepo = repo;
  showActionRunningDialog(l10n.redundancyChecking);
  sendMessage({ command: "branchRedundancy", repo, branch, token: ++redundancyCheckSeq });
}

function showBranchRedundancy(branch: string, result: BranchRedundancy, token: number) {
  if (token !== redundancyCheckSeq || document.getElementById("actionRunning") === null) return;
  const message = branchRedundancyMessage(branch, result) + branchRedundancyBasis(result);
  // A redundant branch, and every branch we couldn't judge, is a one-line
  // answer with nothing to list. Those stay plain centred alerts: the wide
  // left-aligned box exists to hold the commit table, and wrapping it round a
  // single sentence just makes the dialog look like something failed to load.
  const list =
    result.kind === "unmerged" && result.commits.length > 0 ? redundancyCommitList(result) : "";
  showDialog(
    list === ""
      ? message
      : '<div class="redundancyResult"><span class="redundancySummary">' +
          message +
          "</span>" +
          list +
          "</div>",
    null,
    l10n.dialogDismiss,
    null,
    null
  );
  document.querySelectorAll("#dialog .commitList tr.commit").forEach((row) => {
    row.addEventListener("click", () => toggleRedundancyCommit(<HTMLElement>row));
  });
}

/* The rebase dialogs' replay checklist (#172) */
/**
 * The open rebase dialog's replay list and its ticks.
 *
 * Module-level for the same reason `cleanupState` is: the checkboxes live in
 * the dialog's markup, and the handlers that read them are re-bound whenever
 * that markup is rewritten.
 */
let rebasePickState: {
  replay: RebaseReplay;
  /** Hashes still ticked. Opens as every commit on the list — the list is a
   *  filter on what git would replay, not a selection to be made. */
  checked: Set<string>;
  /** The rebase the dialog is asking about, as git spells it. */
  range: RebasePickRange;
  /** The line the dialog prints for a command. Supplied by the dialog because
   *  only it knows how to write its own refs; fed the same command the message
   *  is built from, so the two cannot disagree (ADR-0022). */
  preview: (command: RebasePickCommand) => string;
} | null = null;

/** The range a rebase replays, in the spellings git's arguments take. */
interface RebasePickRange {
  /** Where the commits land — git's `<newBase>`. */
  newBase: string;
  /** The exclusive lower bound of the range — git's `<upstream>`. */
  upstream: string;
  /** How the tip is spelled to git — git's `<branch>`. A branch name whenever
   *  one is on the tip, so git moves the branch; null leaves the argument off
   *  and lets git use HEAD, which is what the plain rebase does. */
  tip: string | null;
}

/**
 * The git command a plan actually becomes, once the range's spelling is taken
 * into account — everything but the repository.
 *
 * Both the printed line and the message sent are read off this one value, so
 * the dialog cannot print one command and run another (ADR-0022).
 */
type RebasePickCommand =
  /** Whatever this dialog ran before the list existed. */
  | { kind: "unchanged" }
  /** The plain `--onto` form, with the lower bound moved forward. */
  | { kind: "onto"; newBase: string; upstream: string; tip: string }
  /** The interactive form, with a todo we write. */
  | { kind: "interactive"; newBase: string; upstream: string; tip: string | null; todo: string }
  /** Nothing to run; the dialog says why instead. */
  | { kind: "none" };

/** The replay list with the current ticks on it — what the plan, the todo and
 *  the ticked count are all worked out from. */
function rebasePickCommits(): RebaseCommit[] {
  const state = rebasePickState;
  if (state === null) return [];
  return state.replay.commits.map((commit) => ({
    hash: commit.hash,
    message: commit.message,
    parentHashes: commit.parentHashes,
    keep: state.checked.has(commit.hash)
  }));
}

/**
 * The plan a set of ticks makes.
 *
 * The untouched case is answered here rather than handed to `planRebase`, and
 * that is the whole point of the wrapper: a dialog nobody has touched must run
 * exactly the command it always ran, and `planRebase` reads an *empty* list as
 * "everything was unticked". An empty list is not that — a range with nothing
 * to replay is a fast-forward, which git performs. Written this way, "unticking
 * nothing cannot change what runs" is structural rather than derived.
 */
function rebasePickPlan(commits: readonly RebaseCommit[]): RebasePlan {
  if (commits.every((commit) => commit.keep)) return { kind: "unchanged" };
  return planRebase(commits);
}

/**
 * The command the current ticks make, for a tip settled now rather than when
 * the dialog opened — the range dialog's branch select is answered at the same
 * moment the dialog itself is.
 */
function rebasePickCommand(tip: string | null): RebasePickCommand {
  const state = rebasePickState;
  if (state === null) return { kind: "unchanged" };
  const commits = rebasePickCommits();
  const plan = rebasePickPlan(commits);
  const { newBase, upstream } = state.range;
  switch (plan.kind) {
    case "empty":
      return { kind: "none" };
    case "unchanged":
      return { kind: "unchanged" };
    case "interactive":
      return { kind: "interactive", newBase, upstream, tip, todo: plan.todo };
    case "narrowed":
      // A narrowed range still needs git's `<branch>` to move a branch, and a
      // rebase aimed at a detached HEAD has none to give. The interactive form
      // replays the same commits — the dropped ones spelled as `drop` lines —
      // so it is the same rebase written the other way, not a different one.
      return tip === null
        ? { kind: "interactive", newBase, upstream, tip, todo: rebaseTodo(commits) }
        : { kind: "onto", newBase, upstream: plan.upstream, tip };
  }
}

/** Wrap a printed command line, or print nothing when there is no command. */
function rebasePickCommandHtml(line: string | null): string {
  return line === null ? "" : '<span class="commandPreview">' + escapeHtml(line) + "</span>";
}

/** The list, newest first — the graph's own order, so the rows read against the
 *  graph behind the dialog rather than against git's todo. */
function rebasePickList(state: NonNullable<typeof rebasePickState>): string {
  // A list that may be short cannot be edited: the ticks would then drop
  // commits the user was never shown. The rows are still worth showing, so they
  // are shown and disabled, and the notice above says why.
  const disabled = state.replay.incomplete ? " disabled" : "";
  return (
    '<div class="rebasePickList"><table>' +
    state.replay.commits
      .toReversed()
      .map(
        (commit) =>
          '<tr class="rebasePickRow"><td><label><input type="checkbox" data-hash="' +
          escapeHtml(commit.hash) +
          '"' +
          (state.checked.has(commit.hash) ? " checked" : "") +
          disabled +
          "/><span>" +
          escapeHtml(
            replaceEmojiShortcodes(commit.message, viewState.customEmojiShortcodeMappings)
          ) +
          '</span></label></td><td class="rebasePickHash" title="' +
          escapeHtml(commit.hash) +
          '">' +
          abbrevCommit(commit.hash) +
          "</td></tr>"
      )
      .join("") +
    "</table></div>"
  );
}

/**
 * Open a checklist over `replay` and return the markup for it.
 *
 * The caller puts it under the dialog's own question and then calls
 * {@link bindRebasePickHandlers}; the dialog helpers render synchronously, so
 * the rows exist by the time they return.
 */
function openRebasePick(
  replay: RebaseReplay,
  range: RebasePickRange,
  preview: (command: RebasePickCommand) => string
): string {
  const state = {
    replay,
    checked: new Set(replay.commits.map((commit) => commit.hash)),
    range,
    preview
  };
  rebasePickState = state;
  const command = rebasePickCommand(range.tip);
  return (
    '<div class="rebasePick"><div id="rebasePickCommand">' +
    preview(command) +
    "</div>" +
    (replay.commits.length === 0 ? "" : rebasePickList(state)) +
    "</div>"
  );
}

/** Wire the row ticks. Re-bound after every render, since each replaces the
 *  markup they hang off. */
function bindRebasePickHandlers() {
  document.querySelectorAll<HTMLInputElement>("#dialog .rebasePickRow input").forEach((box) => {
    box.addEventListener("change", () => {
      const state = rebasePickState;
      if (state === null) return;
      const hash = box.dataset.hash!;
      if (box.checked) state.checked.add(hash);
      else state.checked.delete(hash);
      const command = rebasePickCommand(state.range.tip);
      const printed = document.getElementById("rebasePickCommand");
      if (printed !== null) printed.innerHTML = state.preview(command);
    });
  });
}

/**
 * Run the rebase the ticks chose, or say why there is none to run.
 *
 * `sendUnchanged` is a closure rather than a message shape so that the
 * untouched path stays the caller's *existing* message, field for field.
 */
function sendRebasePick(repo: string, command: RebasePickCommand, sendUnchanged: () => void) {
  switch (command.kind) {
    case "none":
      showErrorDialog(l10n.dialogRebasePickNothingChecked, null, null);
      return;
    case "unchanged":
      sendUnchanged();
      break;
    case "onto":
      sendMessage({
        command: "rebaseOnto",
        repo,
        newBase: command.newBase,
        upstream: command.upstream,
        tip: command.tip
      });
      break;
    case "interactive":
      sendMessage({
        command: "rebaseInteractive",
        repo,
        newBase: command.newBase,
        upstream: command.upstream,
        tip: command.tip,
        todo: command.todo
      });
      break;
  }
  showActionRunningDialog(l10n.rebasing);
}

/* Branch cleanup (the candidate dialog) */
/**
 * The open cleanup dialog's state.
 *
 * `shown` is separate from `checked` on purpose: a deep check or a fetch replaces
 * the whole list, and telling "the user left this unticked" apart from "the user
 * has never seen this" is the only way to honour both (see `mergeCheckedRefs`).
 */
let cleanupState: {
  repo: string;
  payload: GG.BranchCleanupPayload;
  shown: Set<string>;
  checked: Set<string>;
  /** A one-off line above the list: a stopped scan, a failed fetch. */
  notice: string | null;
  /** Correlates async answers with this dialog; a late one for a dialog since
   *  closed or reopened must not fill it in. */
  token: number;
} | null = null;
let cleanupSeq = 0;
/** The request behind a not-yet-open dialog: the graph's own menu asks the host
 *  for a payload, and only that answer may open one. */
let cleanupOpenToken = 0;
/** The repo that request was made for. */
let cleanupOpenRepo: string | null = null;

/** Ask the host for a payload and open the dialog on it. The graph's context
 *  menu route (the side-view command has the payload already). */
function requestBranchCleanup(repo: string) {
  cleanupOpenRepo = repo;
  cleanupOpenToken = ++cleanupSeq;
  showActionRunningDialog(l10n.cleanupChecking);
  sendMessage({ command: "branchCleanupOpen", repo, fetch: false, token: cleanupOpenToken });
}

/**
 * A payload arriving from `branchCleanupOpen`, for either of its two callers.
 *
 * The open dialog's own "fetch and recompute" carries that dialog's token, so it
 * updates in place. Anything else is a fresh open, and only counts while the
 * "working" dialog it replaced is still up — a late answer must not reopen a
 * dialog the user has already dismissed.
 */
function handleBranchCleanupOpen(msg: GG.ResponseBranchCleanupOpen) {
  const notice = msg.fetchFailed ? l10n.cleanupFetchFailed : null;
  if (cleanupState !== null && msg.token === cleanupState.token) {
    updateBranchCleanup(msg.payload, notice, msg.token);
    return;
  }
  if (
    msg.token !== cleanupOpenToken ||
    cleanupOpenRepo === null ||
    document.getElementById("actionRunning") === null
  ) {
    return;
  }
  if (msg.payload.candidates.length === 0) {
    showDialog(l10n.cleanupNone, null, l10n.dialogDismiss, null, null);
    return;
  }
  openCleanupDialog(cleanupOpenRepo, msg.payload);
  if (notice !== null) updateBranchCleanup(msg.payload, notice, cleanupState!.token);
}

/** Open the dialog on a payload the extension host built (ADR-0017). */
function openCleanupDialog(repo: string, payload: GG.BranchCleanupPayload) {
  cleanupState = {
    repo,
    payload,
    shown: new Set(payload.candidates.map((c) => c.ref)),
    checked: new Set(defaultCheckedRefs(payload.candidates)),
    notice: null,
    token: ++cleanupSeq
  };
  renderBranchCleanup();
}

/** Replace the list in an open dialog, carrying the user's ticks across. */
function updateBranchCleanup(
  payload: GG.BranchCleanupPayload,
  notice: string | null,
  token: number
) {
  if (cleanupState === null || token !== cleanupState.token) return;
  const checked = mergeCheckedRefs({
    candidates: payload.candidates,
    shown: cleanupState.shown,
    checked: cleanupState.checked
  });
  cleanupState.payload = payload;
  cleanupState.checked = new Set(checked);
  for (const c of payload.candidates) cleanupState.shown.add(c.ref);
  cleanupState.notice = notice;
  renderBranchCleanup();
}

/** The facts that put a row on the list, as words. Never collapsed into one
 *  label: merged carries git's guarantee, redundant does not, and inactive says
 *  nothing about whether deleting loses work (CONTEXT.md). */
function cleanupRowFacts(candidate: GG.CleanupCandidate): string {
  const words: string[] = [];
  if (candidate.facts.merged) words.push(l10n.cleanupFactMerged);
  if (candidate.facts.redundant) words.push(l10n.cleanupFactRedundant);
  if (candidate.facts.inactive) words.push(l10n.cleanupFactInactive);
  return words.map((w) => '<span class="cleanupFact">' + escapeHtml(w) + "</span>").join("");
}

function cleanupRow(candidate: GG.CleanupCandidate, checked: boolean): string {
  const date =
    candidate.lastActivitySec === undefined ? null : getCommitDate(candidate.lastActivitySec);
  return (
    '<tr class="cleanupRow"><td><label><input type="checkbox" data-ref="' +
    escapeHtml(candidate.ref) +
    '"' +
    (checked ? " checked" : "") +
    "/><span>" +
    escapeHtml(displayRef(candidate.ref)) +
    "</span></label></td><td>" +
    cleanupRowFacts(candidate) +
    '</td><td class="cleanupAge"' +
    (date === null ? ">" : ' title="' + escapeHtml(date.title) + '">' + escapeHtml(date.value)) +
    "</td></tr>"
  );
}

/**
 * The list, grouped and ordered exactly as the host put the rows in — the
 * side-view's tree order.
 *
 * Unlike the tree, a heading is rendered whenever its group is non-empty, not
 * only when both kinds are present. The tree omits a lone "Local" because it
 * would be pure noise, but here the heading carries the group's select-all, and
 * a group with no way to select all of it is the worse outcome.
 */
function cleanupList(state: NonNullable<typeof cleanupState>): string {
  const heading = (label: string, isRemote: boolean) =>
    '<tr class="cleanupGroup"><td colspan="3"><label><input type="checkbox"' +
    ' class="cleanupGroupToggle" data-remote="' +
    String(isRemote) +
    '" title="' +
    escapeHtml(l10n.cleanupSelectAll) +
    '"/><span>' +
    escapeHtml(label) +
    "</span></label></td></tr>";
  const group = (label: string, isRemote: boolean) => {
    const rows = state.payload.candidates.filter((c) => c.isRemote === isRemote);
    return rows.length === 0
      ? ""
      : heading(label, isRemote) +
          rows.map((c) => cleanupRow(c, state.checked.has(c.ref))).join("");
  };
  return (
    '<div class="cleanupList"><table>' +
    group(l10n.cleanupGroupRemote, true) +
    group(l10n.cleanupGroupLocal, false) +
    "</table></div>"
  );
}

/** Point each group header at its rows' current state. Set from script because
 *  `indeterminate` has no markup form. */
function syncCleanupGroupToggles(state: NonNullable<typeof cleanupState>) {
  document.querySelectorAll<HTMLInputElement>("#dialog .cleanupGroupToggle").forEach((box) => {
    const toggle = groupToggleState(
      state.payload.candidates,
      state.checked,
      box.dataset.remote === "true"
    );
    box.checked = toggle === "all";
    box.indeterminate = toggle === "some";
  });
}

/** The standing caveats about what this list can and cannot tell you. Each is
 *  stated rather than left as a silent gap in the answer (ADR-0015). Rebuilt on
 *  its own (into `#cleanupNotices`) when a tick changes, because re-rendering the
 *  whole dialog mid-click would steal focus. */
function cleanupNotices(state: NonNullable<typeof cleanupState>): string {
  const lines: string[] = [];
  if (state.notice !== null) lines.push(state.notice);
  if (state.payload.defaultBranch === null) lines.push(l10n.cleanupNoDefaultBranch);
  if (state.payload.remotesHidden) lines.push(l10n.cleanupRemotesHidden);
  // Said whenever a ticked local row lacks the one fact that guarantees git will
  // allow the delete. `merged` is that fact and nothing else is: `redundant`
  // makes no such promise, and an idle branch that was never merged will be
  // refused just as surely — so the test is the absence of `merged`, not the
  // presence of anything. Remote rows are excluded because `push --delete` has
  // no such refusal to warn about (ADR-0015).
  if (
    state.payload.candidates.some((c) => state.checked.has(c.ref) && !c.isRemote && !c.facts.merged)
  ) {
    lines.push(l10n.cleanupForceNote);
  }
  return lines.map((line) => '<div class="cleanupNotice">' + escapeHtml(line) + "</div>").join("");
}

/** How current the basis is. Same wording and same source as the single-branch
 *  check, so the two never date the same ref differently. */
function cleanupBasis(state: NonNullable<typeof cleanupState>): string {
  if (state.payload.defaultBranch === null || state.payload.defaultBranchDate === 0) return "";
  const date = getCommitDate(state.payload.defaultBranchDate);
  return (
    '<div class="redundancyBasis" title="' +
    escapeHtml(date.title) +
    '">' +
    fillTemplate(
      l10n.redundancyBasisDate,
      escapeHtml(displayRef(state.payload.defaultBranch)),
      escapeHtml(date.value)
    ) +
    "</div>"
  );
}

function renderBranchCleanup() {
  const state = cleanupState;
  if (state === null) return;
  // Force delete is the only option here. "Also delete on remotes" belongs to
  // the side-view's batch delete, where the selection is local branches and the
  // remote is otherwise unreachable; in this dialog every remote candidate is a
  // row of its own, so the checkbox would be a second, invisible way to delete
  // the same refs.
  const inputs: DialogInput[] = [
    {
      type: "checkbox",
      name: l10n.dialogDeleteForceDelete,
      value: gitGraph.dialogDeleteBranchForceDelete()
    }
  ];
  const scanButton =
    state.payload.scannable > 0
      ? '<div id="cleanupDeepCheck" class="roundedBtn" title="' +
        escapeHtml(l10n.cleanupDeepCheckHint) +
        '">' +
        escapeHtml(fillTemplate(l10n.cleanupDeepCheck, String(state.payload.scannable))) +
        "</div>"
      : "";
  const body =
    '<div class="cleanupResult"><span class="cleanupSummary">' +
    escapeHtml(fillTemplate(l10n.cleanupIntro, String(state.payload.candidates.length))) +
    '</span><div id="cleanupNotices">' +
    cleanupNotices(state) +
    "</div>" +
    cleanupList(state) +
    cleanupBasis(state) +
    '<div class="cleanupTools">' +
    scanButton +
    '<div id="cleanupRefetch" class="roundedBtn">' +
    escapeHtml(l10n.cleanupRefetch) +
    "</div></div></div>";

  // The dialog is the confirmation: there is no second one behind it. The row
  // ticks, the two delete options and the batch run all hang off this one
  // action (ADR-0017).
  showFormDialog(
    body,
    inputs,
    l10n.deleteBranches,
    (values) => {
      const refs = [...state.checked];
      if (refs.length === 0) {
        showErrorDialog(l10n.cleanupNothingChecked, null, null);
        return;
      }
      cleanupState = null;
      gitGraph.startCleanupDelete(state.repo, refs, {
        forceDelete: values[0] === "checked",
        // Never implied here — a remote is only deleted by ticking its own row.
        deleteOnRemotes: false
      });
    },
    null
  );
  bindBranchCleanupHandlers(state);
}

/** Wire the parts `showFormDialog` knows nothing about: the per-row ticks and
 *  the two tools. Re-bound on every render, since each replaces the markup. */
function bindBranchCleanupHandlers(state: NonNullable<typeof cleanupState>) {
  // The force note appears and disappears with the ticks it describes, and the
  // group headers track their rows. Both are refreshed in place rather than by
  // re-rendering the dialog, which would steal focus mid-click.
  const afterTickChange = (live: NonNullable<typeof cleanupState>) => {
    const notices = document.getElementById("cleanupNotices");
    if (notices !== null) notices.innerHTML = cleanupNotices(live);
    syncCleanupGroupToggles(live);
  };
  document.querySelectorAll<HTMLInputElement>("#dialog .cleanupRow input").forEach((box) => {
    box.addEventListener("change", () => {
      if (cleanupState === null) return;
      const ref = box.dataset.ref!;
      if (box.checked) cleanupState.checked.add(ref);
      else cleanupState.checked.delete(ref);
      afterTickChange(cleanupState);
    });
  });
  document.querySelectorAll<HTMLInputElement>("#dialog .cleanupGroupToggle").forEach((box) => {
    box.addEventListener("change", () => {
      if (cleanupState === null) return;
      const isRemote = box.dataset.remote === "true";
      // A partly-ticked header is indeterminate; clicking it ticks the whole
      // group rather than clearing it, which is the direction that matches what
      // the user just reached for.
      const next = box.checked;
      for (const candidate of cleanupState.payload.candidates) {
        if (candidate.isRemote !== isRemote) continue;
        if (next) cleanupState.checked.add(candidate.ref);
        else cleanupState.checked.delete(candidate.ref);
      }
      document.querySelectorAll<HTMLInputElement>("#dialog .cleanupRow input").forEach((row) => {
        if (row.dataset.ref!.startsWith(REMOTE_PREFIX) === isRemote) row.checked = next;
      });
      afterTickChange(cleanupState);
    });
  });
  syncCleanupGroupToggles(state);
  document.getElementById("cleanupDeepCheck")?.addEventListener("click", () => {
    if (cleanupState === null) return;
    startBranchCleanupScan(cleanupState.repo, cleanupState.token);
  });
  document.getElementById("cleanupRefetch")?.addEventListener("click", () => {
    if (cleanupState === null) return;
    // Dismissing the progress dialog abandons the dialog with it. The fetch
    // itself cannot be recalled, but the answer must not reopen a dialog the
    // user has closed — unlike the scan's Stop, which exists precisely to come
    // back with what it found.
    showActionRunningDialogWith(l10n.loading, l10n.dialogDismiss, () => {
      cleanupState = null;
    });
    sendMessage({
      command: "branchCleanupOpen",
      repo: cleanupState.repo,
      fetch: true,
      token: cleanupState.token
    });
  });
}

/** Run the deep check, showing progress and offering to stop. The dialog is
 *  replaced by a progress one so the list can't be edited against verdicts that
 *  are still arriving. */
function startBranchCleanupScan(repo: string, token: number) {
  showActionRunningDialogWith(
    escapeHtml(fillTemplate(l10n.cleanupScanning, "0", "?")),
    l10n.cleanupScanStop,
    () => sendMessage({ command: "branchCleanupScanCancel" })
  );
  sendMessage({ command: "branchCleanupScan", repo, token });
}

function updateBranchCleanupScanProgress(done: number, total: number, token: number) {
  if (cleanupState === null || token !== cleanupState.token) return;
  const running = document.getElementById("actionRunning");
  if (running === null) return;
  running.innerHTML =
    svgIcons.loading + escapeHtml(fillTemplate(l10n.cleanupScanning, String(done), String(total)));
}

/** Substitute `{0}`, `{1}`, … in an l10n template. Function replacements
 *  throughout: the values are branch names and commit text, which may contain
 *  `$&` or `$'` — a string replacement would expand those, and `escapeHtml`
 *  leaves `$` alone. */
function fillTemplate(template: string, ...values: string[]): string {
  return values.reduce((text, value, i) => text.replace("{" + i + "}", () => value), template);
}

/**
 * How current the branch the answer was measured against is.
 *
 * Nothing in this check fetches, so every answer is only as fresh as the local
 * copy of the default branch: a branch squash-merged upstream an hour ago still
 * reads as unmerged until the user fetches. Dating the basis is what lets them
 * notice — without it there is no clue on screen that the answer has a
 * best-before. Omitted when there is no basis to date (the `unknown` answers).
 */
function branchRedundancyBasis(result: BranchRedundancy): string {
  if (result.kind === "unknown" || result.defaultBranchDate === 0) return "";
  const date = getCommitDate(result.defaultBranchDate);
  return (
    '<div class="redundancyBasis" title="' +
    escapeHtml(date.title) +
    '">' +
    fillTemplate(
      l10n.redundancyBasisDate,
      escapeHtml(displayRef(result.defaultBranch)),
      escapeHtml(date.value)
    ) +
    "</div>"
  );
}

/** The dialog's headline sentence. The verdict is merge-tree's; the commit
 *  counts are patch-id evidence reported alongside it, and are left out when
 *  they attribute nothing — which is what a squash merge with later work, and a
 *  change that was applied then reverted, both look like. */
function branchRedundancyMessage(branch: string, result: BranchRedundancy): string {
  const name = "<b><i>" + escapeHtml(branch) + "</i></b>";
  if (result.kind === "unknown") {
    const reason =
      result.reason === "noDefaultBranch"
        ? l10n.redundancyNoDefaultBranch
        : result.reason === "noMergeBase"
          ? l10n.redundancyNoMergeBase
          : l10n.redundancyUnsupported;
    return fillTemplate(reason, name);
  }
  const target = "<b><i>" + escapeHtml(displayRef(result.defaultBranch)) + "</i></b>";
  if (result.kind === "redundant") {
    return fillTemplate(l10n.redundancyNone, name, target);
  }
  const missing = result.commits.filter((c) => !c.covered).length;
  const covered = result.commits.length - missing;
  // Past the listing cap the counts are the cap's, not the branch's, so the
  // sentence has to stop asserting an exact number rather than state a wrong one.
  if (result.truncated) {
    return fillTemplate(l10n.redundancyUnmergedAtLeast, name, String(missing), target);
  }
  if (missing === 0) {
    return fillTemplate(l10n.redundancyUnmergedUnknown, name, target);
  }
  if (covered === 0) {
    return fillTemplate(l10n.redundancyUnmerged, name, String(missing), target);
  }
  return fillTemplate(
    l10n.redundancyUnmergedPartial,
    name,
    String(missing),
    target,
    String(covered)
  );
}

/** The branch's commits, split by whether the default branch already carries an
 *  identical patch. Both groups are shown: "already applied" is the half that
 *  explains why a branch the badge calls unmerged may still be nearly done. */
function redundancyCommitList(result: Extract<BranchRedundancy, { kind: "unmerged" }>): string {
  const target = escapeHtml(displayRef(result.defaultBranch));
  const group = (title: string, commits: readonly RedundancyCommit[]) =>
    commits.length === 0
      ? ""
      : '<tr class="commitListGroup"><td colspan="4">' +
        fillTemplate(title, target, String(commits.length)) +
        "</td></tr>" +
        commits.map(redundancyCommitRow).join("");
  return (
    '<div class="commitList"><table>' +
    group(
      l10n.redundancyGroupMissing,
      result.commits.filter((c) => !c.covered)
    ) +
    group(
      l10n.redundancyGroupCovered,
      result.commits.filter((c) => c.covered)
    ) +
    (result.truncated
      ? '<tr class="commitListGroup"><td colspan="4">' +
        escapeHtml(l10n.redundancyTruncated) +
        "</td></tr>"
      : "") +
    "</table></div>"
  );
}

/** One row of the list, built from the same cells as the graph's commit table
 *  with the graph and ref-label column dropped, followed by the (initially
 *  empty) details row that expanding it fills in. */
function redundancyCommitRow(commit: RedundancyCommit): string {
  const date = getCommitDate(commit.date);
  const avatar = gitGraph.avatarHtml(commit.email);
  return (
    '<tr class="commit" data-hash="' +
    commit.hash +
    '"><td>' +
    escapeHtml(replaceEmojiShortcodes(commit.subject, viewState.customEmojiShortcodeMappings)) +
    '</td><td title="' +
    escapeHtml(date.title) +
    '">' +
    escapeHtml(date.value) +
    '</td><td title="' +
    escapeHtml(commit.author + " <" + commit.email + ">") +
    '">' +
    avatar +
    escapeHtml(commit.author) +
    '</td><td title="' +
    escapeHtml(commit.hash) +
    '">' +
    abbrevCommit(commit.hash) +
    '</td></tr><tr class="commitListDetails" data-hash="' +
    commit.hash +
    '"><td colspan="4"></td></tr>'
  );
}

/** The details row that follows `row` in the list. Safe as a selector: the hash
 *  comes back from git as hex. */
function redundancyDetailsCell(commitHash: string): HTMLElement | null {
  return document.querySelector(
    '#dialog .commitList tr.commitListDetails[data-hash="' + commitHash + '"] td'
  );
}

/** Expand or collapse a row, fetching its details the first time it opens. */
function toggleRedundancyCommit(row: HTMLElement) {
  const hash = row.dataset.hash!;
  const cell = redundancyDetailsCell(hash);
  if (cell === null) return;
  if (!row.classList.toggle("commitDetailsOpen")) {
    cell.parentElement!.classList.remove("open");
    return;
  }
  cell.parentElement!.classList.add("open");
  if (cell.dataset.requested === "true" || redundancyRepo === null) return;
  cell.dataset.requested = "true";
  cell.dataset.token = String(redundancyCheckSeq);
  cell.innerHTML =
    '<span class="redundancyDetailsNote">' + escapeHtml(l10n.redundancyDetailsLoading) + "</span>";
  sendMessage({ command: "redundancyCommitDetails", repo: redundancyRepo, commitHash: hash });
}

/**
 * Fill in a row's details, using the graph's own Commit Details View renderers
 * so the same commit reads the same in both places.
 *
 * Nothing to do when the dialog has since closed — the row is gone with it. The
 * token guards the case where it has since been *reopened* for another branch
 * that happens to contain the same commit: that row was never expanded, and
 * filling it silently would leave content the user can't see and can't refresh.
 */
function showRedundancyCommitDetails(commitHash: string, details: GitCommitDetails | null) {
  const cell = redundancyDetailsCell(commitHash);
  if (cell === null || cell.dataset.token !== String(redundancyCheckSeq)) return;
  cell.innerHTML =
    details === null
      ? '<span class="redundancyDetailsNote">' +
        escapeHtml(l10n.unableToLoadCommitDetails) +
        "</span>"
      : // The flex layout goes on this wrapper, not on the cell: `display: flex`
        // on a `<td>` stops it being a table cell, and its `colspan` with it.
        '<div class="commitDetailsPanel"><div class="commitDetailsSummary">' +
        gitGraph.commitSummaryHtml(details, false) +
        '</div><div class="commitDetailsFiles">' +
        gitGraph.commitFilesHtml(details.fileChanges) +
        "</div></div>";
}

/* Command Processing */
window.addEventListener("message", (event) => {
  const msg: GG.ResponseMessage = event.data;
  // Applying a message is the only path that can name the operation it was
  // half-way through, so it is the one that catches; the two global handlers
  // armed above cover everything that runs outside this call stack (ADR-0016).
  errorReporter.whileHandling(msg.command, () => applyResponseMessage(msg));
});

function applyResponseMessage(msg: GG.ResponseMessage) {
  // An answer belonging to a navigation the panel has left, dropped before it
  // reaches anything. Applying one would put the previous repo's branches under
  // this repo's title, or draw its history as this one's; and its callback
  // belongs to a reload abandoned along with it, so running that would send the
  // current repo a commit request built from the filter it just left (#84).
  //
  // Here rather than inside the two handlers because this is where staleness
  // enters — the boot path replays saved state through the very same methods,
  // and it cannot be stale: it is this panel's own state, restored. Guarding
  // inside would have made both of them take a token that path could only
  // satisfy by handing back the field it was about to be compared against.
  if (
    (msg.command === "loadBranches" || msg.command === "loadCommits") &&
    !gitGraph.isCurrentNavigation(msg.token)
  ) {
    return;
  }
  switch (msg.command) {
    case "addTag":
      refreshGraphOrDisplayError(msg.status, l10n.unableToAddTag);
      break;
    case "checkoutBranch":
      refreshGraphOrDisplayError(msg.status, l10n.unableToCheckoutBranch);
      break;
    case "checkoutCommit":
      refreshGraphOrDisplayError(msg.status, l10n.unableToCheckoutCommit);
      break;
    case "dropCommit":
      refreshGraphOrDisplayError(msg.status, l10n.unableToDrop);
      break;
    case "applyStash":
      refreshGraphOrDisplayError(msg.status, l10n.unableToApplyStash);
      break;
    case "popStash":
      refreshGraphOrDisplayError(msg.status, l10n.unableToPopStash);
      break;
    case "dropStash":
      refreshGraphOrDisplayError(msg.status, l10n.unableToDropStash);
      break;
    case "resetUncommittedChanges":
      refreshGraphOrDisplayError(msg.status, l10n.unableToResetUncommitted);
      break;
    case "cleanUntrackedFiles":
      refreshGraphOrDisplayError(msg.status, l10n.unableToCleanUntracked);
      break;
    case "operationState":
      gitGraph.showConflictBanner(msg.operation, msg.conflictedFiles);
      break;
    case "continueOperation":
      refreshGraphOrDisplayError(msg.status, l10n.unableToContinueOperation);
      break;
    case "abortOperation":
      refreshGraphOrDisplayError(msg.status, l10n.unableToAbortOperation);
      break;
    case "markResolved":
      refreshGraphOrDisplayError(msg.status, l10n.unableToMarkResolved);
      break;
    case "resetFileToRevision":
      refreshGraphOrDisplayError(msg.status, l10n.unableToResetFile);
      break;
    case "cherrypickCommit":
      refreshGraphOrDisplayError(msg.status, l10n.unableToCherryPick);
      break;
    case "commitDetails":
      if (msg.commitDetails === null) {
        gitGraph.hideCommitDetails();
        showErrorDialog(l10n.unableToLoadCommitDetails, null, null);
      } else {
        gitGraph.showCommitDetails(
          msg.commitDetails,
          generateGitFileTree(msg.commitDetails.fileChanges)
        );
      }
      break;
    case "compareCommits":
      if (msg.fileChanges === null) {
        // Close the (not-yet-rendered) comparison so the second row doesn't stay
        // highlighted with no panel, mirroring the commitDetails error path.
        gitGraph.hideCommitDetails();
        showErrorDialog(l10n.unableToLoadCommitDetails, null, null);
      } else {
        gitGraph.showCommitComparison(
          msg.fromHash,
          msg.toHash,
          msg.fileChanges,
          generateGitFileTree(msg.fileChanges)
        );
      }
      break;
    case "branchRedundancy":
      showBranchRedundancy(msg.branch, msg.result, msg.token);
      break;
    case "redundancyCommitDetails":
      showRedundancyCommitDetails(msg.commitHash, msg.commitDetails);
      break;
    case "predictConflicts": {
      const elem = document.getElementById("conflictPrediction");
      // Ignore a response whose dialog has closed or been superseded.
      if (elem === null || elem.dataset.token !== String(msg.token)) break;
      if (!msg.ok) {
        // Couldn't predict (git too old / error): show nothing rather than a
        // misleading "no conflicts".
        elem.className = "conflictPrediction";
        elem.textContent = "";
      } else if (msg.conflictFiles.length === 0) {
        elem.className = "conflictPrediction noConflict";
        elem.textContent = l10n.conflictPredictionNone;
      } else {
        elem.className = "conflictPrediction hasConflict";
        elem.innerHTML =
          escapeHtml(
            l10n.conflictPredictionConflicts.replace("{0}", String(msg.conflictFiles.length))
          ) +
          '<ul class="conflictPredictionList">' +
          msg.conflictFiles.map((f) => "<li>" + escapeHtml(f) + "</li>").join("") +
          "</ul>";
      }
      break;
    }
    case "copyToClipboard":
      if (msg.success === false) {
        let typeLabel: Record<string, string> = {
          "Commit Hash": l10n.typeCommitHash,
          "Commit Subject": l10n.typeCommitSubject,
          "File Path": l10n.typeFilePath,
          Link: l10n.typeLink,
          "Tag Name": l10n.typeTagName,
          "Branch Name": l10n.typeBranchName
        };
        showErrorDialog(
          l10n.unableToCopyToClipboard.replace("{0}", typeLabel[msg.type] ?? msg.type),
          null,
          null
        );
      }
      break;
    case "createBranch":
      refreshGraphOrDisplayError(msg.status, l10n.unableToCreateBranch);
      break;
    case "deleteBranch":
      gitGraph.handleDeleteBranchResponse(msg.status, msg.notFullyMerged);
      break;
    case "deleteRemoteBranch":
      refreshGraphOrDisplayError(msg.status, l10n.unableToDeleteRemoteBranch);
      break;
    case "deleteTag":
      refreshGraphOrDisplayError(msg.status, l10n.unableToDeleteTag);
      break;
    case "fetchIntoLocalBranch":
      refreshGraphOrDisplayError(msg.status, l10n.unableToFetchIntoLocalBranch);
      break;
    case "fetchAvatar":
      gitGraph.loadAvatar(msg.email, msg.image);
      break;
    case "loadBranches":
      gitGraph.loadBranches(
        msg.branches,
        msg.head,
        msg.hard,
        msg.isRepo,
        msg.filter,
        msg.dimmedBranches ?? [],
        msg.cleanupCandidates ?? []
      );
      break;
    case "setBranchFilter":
      gitGraph.setBranchFilter(msg.branches);
      break;
    case "setShowRemoteBranches":
      gitGraph.setShowRemoteBranches(msg.value);
      break;
    case "loadCommits":
      gitGraph.loadCommits(msg.commits, msg.head, msg.moreCommitsAvailable, msg.hard);
      break;
    case "loadRemotes":
      gitGraph.loadRemotes(msg.remotes, msg.pushDefault);
      break;
    case "branchSearch":
      gitGraph.loadBranchSearchIndex(msg.branches, msg.token, msg.status);
      break;
    case "tagDetails":
      if (msg.details === null) {
        showErrorDialog(l10n.unableToLoadTagDetails, null, null);
      } else {
        showTagDetailsDialog(msg.details);
      }
      break;
    case "createArchive":
      if (msg.success === false) showErrorDialog(l10n.unableToCreateArchive, null, null);
      break;
    case "exportPatch":
      if (msg.success === false) showErrorDialog(l10n.unableToExportPatch, null, null);
      break;
    case "renameStash":
      refreshGraphOrDisplayError(msg.status, l10n.unableToRenameStash);
      break;
    case "fastForwardBranch":
      refreshGraphOrDisplayError(msg.status, l10n.unableToFastForward);
      break;
    case "loadRepos":
      gitGraph.loadRepos(msg.repos, msg.lastActiveRepo);
      break;
    case "setRepo":
      gitGraph.setRepo(msg.repo);
      break;
    case "setScmMultiRepoSelection":
      gitGraph.setScmMultiRepoSelection(msg.enabled);
      break;
    case "runRefAction":
      gitGraph.runRefAction(msg);
      break;
    case "runRefBatchAction":
      gitGraph.runRefBatchAction(msg);
      break;
    case "showBranchCleanup":
      gitGraph.showBranchCleanup(msg);
      break;
    case "branchCleanupOpen":
      handleBranchCleanupOpen(msg);
      break;
    case "branchCleanupScanProgress":
      updateBranchCleanupScanProgress(msg.done, msg.total, msg.token);
      break;
    case "branchCleanupScan":
      updateBranchCleanup(msg.payload, msg.cancelled ? l10n.cleanupScanCancelled : null, msg.token);
      break;
    case "deleteBranches":
      gitGraph.handleBatchActionResponse("deleteBranches", msg.results);
      break;
    case "pushBranches":
      gitGraph.handleBatchActionResponse("pushBranches", msg.results);
      break;
    case "fastForwardBranches":
      gitGraph.handleBatchActionResponse("fastForwardBranches", msg.results);
      break;
    case "mergeBranch":
      refreshGraphOrDisplayError(msg.status, l10n.unableToMergeBranch);
      break;
    case "mergeCommit":
      refreshGraphOrDisplayError(msg.status, l10n.unableToMergeCommit);
      break;
    case "pullBranch":
      refreshGraphOrDisplayError(msg.status, l10n.unableToPullBranch);
      break;
    case "pushBranch":
      refreshGraphOrDisplayError(msg.status, l10n.unableToPushBranch);
      break;
    case "pushTag":
      refreshGraphOrDisplayError(msg.status, l10n.unableToPushTag);
      break;
    case "renameBranch":
      refreshGraphOrDisplayError(msg.status, l10n.unableToRenameBranch);
      break;
    case "refresh":
      gitGraph.refresh(false);
      break;
    case "resetToCommit":
      refreshGraphOrDisplayError(msg.status, l10n.unableToReset);
      break;
    case "rebaseOn":
    case "rebaseOnto":
    case "rebaseInteractive":
      // All three are the same rebase to the user — which one ran was decided
      // by the dialog's ticks, not by them — so they share one failure report
      // (ADR-0022).
      refreshGraphOrDisplayError(msg.status, l10n.unableToRebase);
      break;
    case "revertCommit":
      refreshGraphOrDisplayError(msg.status, l10n.unableToRevert);
      break;
    case "viewDiff":
      if (msg.success === false) showErrorDialog(l10n.unableToViewDiff, null, null);
      break;
    case "fetch":
      refreshGraphOrDisplayError(msg.status, l10n.unableToFetch);
      break;
    case "openFile":
      if (msg.success === false) showErrorDialog(l10n.unableToOpenFile, null, null);
      break;
    case "viewFileAtRevision":
      if (msg.success === false) showErrorDialog(l10n.unableToOpenFile, null, null);
      break;
    case "viewDiffWithWorking":
      if (msg.success === false) showErrorDialog(l10n.unableToViewDiff, null, null);
      break;
  }
}
function refreshGraphOrDisplayError(status: GitCommandStatus, errorMessage: string) {
  if (status === null) {
    gitGraph.refresh(true, true); // keep the user's scroll position after an action
  } else {
    // Refresh once the error is dismissed: a failed merge/rebase/cherry-pick/
    // revert leaves an operation in progress, and the file watcher is muted
    // during the action, so this is what surfaces the conflict banner without a
    // manual refresh. (Harmless for non-operation failures — state is unchanged.)
    showErrorDialog(errorMessage, status, null, () => gitGraph.refresh(false));
  }
}

/* Dates */
function getCommitDate(dateVal: number) {
  let date = new Date(dateVal * 1000),
    value;

  let dateStr = formatDate(date, viewState.dateCustomFormat);
  let timeStr = pad2(date.getHours()) + ":" + pad2(date.getMinutes());
  let isoDate = date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
  let isoTime =
    pad2(date.getHours()) + ":" + pad2(date.getMinutes()) + ":" + pad2(date.getSeconds());

  switch (viewState.dateFormat) {
    case "Date Only":
      value = dateStr;
      break;
    case "ISO Date Only":
      value = isoDate;
      break;
    case "ISO Date & Time":
      value = isoDate + " " + isoTime;
      break;
    case "Relative":
      let diff = Math.round(new Date().getTime() / 1000) - dateVal,
        unit,
        unitPlural;
      if (diff < 60) {
        unit = l10n.timeSecond;
        unitPlural = l10n.timeSeconds;
      } else if (diff < 3600) {
        unit = l10n.timeMinute;
        unitPlural = l10n.timeMinutes;
        diff /= 60;
      } else if (diff < 86400) {
        unit = l10n.timeHour;
        unitPlural = l10n.timeHours;
        diff /= 3600;
      } else if (diff < 604800) {
        unit = l10n.timeDay;
        unitPlural = l10n.timeDays;
        diff /= 86400;
      } else if (diff < 2629800) {
        unit = l10n.timeWeek;
        unitPlural = l10n.timeWeeks;
        diff /= 604800;
      } else if (diff < 31557600) {
        unit = l10n.timeMonth;
        unitPlural = l10n.timeMonths;
        diff /= 2629800;
      } else {
        unit = l10n.timeYear;
        unitPlural = l10n.timeYears;
        diff /= 31557600;
      }
      diff = Math.round(diff);
      value = diff + " " + (diff !== 1 ? unitPlural : unit) + " " + l10n.timeAgo;
      break;
    default:
      value = dateStr + " " + timeStr;
  }
  return { title: dateStr + " " + timeStr, value: value };
}

/* Utils */
function toPushForceMode(v: string): "normal" | "force" | "forceWithLease" {
  return v === "force" ? "force" : v === "forceWithLease" ? "forceWithLease" : "normal";
}
function abbrevCommit(commitHash: string) {
  return commitHash.substring(0, 8);
}

/** Display label for a checked-out branch in dialogs: its actual name when on a
 *  branch, or the generic "current branch" wording when detached. Takes the
 *  head rather than reading it, so a dialog that has to name the branch it was
 *  *opened* on can say the same thing as one naming the branch it is on now. */
function branchLabel(head: string | null): string {
  return head !== null
    ? "<b><i>" + escapeHtml(head) + "</i></b>"
    : "<b>" + l10n.labelCurrentBranch + "</b>";
}

/* Context Menu */

/** Where a menu opens from. A right-click supplies a pointer position; the
 *  keyboard (`MENU_KEY_EVENT`) supplies none, so the menu hangs off the bottom-
 *  left corner of the element it was raised on, the way a native menu does. */
function menuAnchorPoint(e: Event, sourceElem: HTMLElement): { pageX: number; pageY: number } {
  if (e instanceof MouseEvent) return { pageX: e.pageX, pageY: e.pageY };
  const bounds = sourceElem.getBoundingClientRect();
  return { pageX: bounds.left + window.pageXOffset, pageY: bounds.bottom + window.pageYOffset };
}

function showContextMenu(e: Event, rawItems: ContextMenuElement[], sourceElem: HTMLElement) {
  // Drop items hidden via contextMenuActionsVisibility, then collapse any
  // dividers left leading, trailing, or doubled-up by the removals.
  const items = rawItems
    .filter((it) => it === null || it.visible !== false)
    .filter((it, idx, arr) => !(it === null && (idx === 0 || arr[idx - 1] === null)))
    .filter((it, idx, arr) => !(it === null && idx === arr.length - 1));
  let html = "",
    i: number,
    anchor = menuAnchorPoint(e, sourceElem);
  for (i = 0; i < items.length; i++) {
    const item = items[i];
    if (item === null) {
      html += '<li class="contextMenuDivider" role="separator"></li>';
      continue;
    }
    // Every item reserves the same leading gutter, so the labels of icon-less
    // items still line up with the rest (native menus reserve it for the
    // checkmark whether or not the item is checkable).
    const gutter =
      item.checked === true ? svgIcons.check : item.icon !== undefined ? svgIcons[item.icon] : "";
    html +=
      '<li class="contextMenuItem" role="' +
      (item.checked === undefined ? "menuitem" : "menuitemcheckbox") +
      '" tabindex="-1" data-index="' +
      i +
      '"' +
      (item.checked === undefined ? "" : ' aria-checked="' + item.checked + '"') +
      '><span class="contextMenuItemGutter">' +
      gutter +
      '</span><span class="contextMenuItemLabel">' +
      item.title +
      "</span></li>";
  }

  hideContextMenuListener();
  contextMenu.style.opacity = "0";
  contextMenu.className = "active";
  contextMenu.innerHTML = html;
  let bounds = contextMenu.getBoundingClientRect();
  // Prefer opening down/right of the anchor, flipping up/left when that side
  // would overflow the viewport.
  let left =
    anchor.pageX - window.pageXOffset + bounds.width < window.innerWidth
      ? anchor.pageX - 2
      : anchor.pageX - bounds.width + 2;
  let top =
    anchor.pageY - window.pageYOffset + bounds.height < window.innerHeight
      ? anchor.pageY - 2
      : anchor.pageY - bounds.height + 2;
  // Clamp into the visible viewport: when the flipped side also lacks room (a
  // menu taller/wider than the space to that edge), the raw position spills past
  // the top/left edge and clips the leading items. Pin it inside instead, so a
  // menu larger than the viewport stays anchored to the top/left and its first
  // items remain reachable.
  left = Math.max(
    window.pageXOffset + 2,
    Math.min(left, window.pageXOffset + window.innerWidth - bounds.width - 2)
  );
  top = Math.max(
    window.pageYOffset + 2,
    Math.min(top, window.pageYOffset + window.innerHeight - bounds.height - 2)
  );
  contextMenu.style.left = left + "px";
  contextMenu.style.top = top + "px";
  contextMenu.style.opacity = "1";

  addListenerToClass("contextMenuItem", "click", (ev) => {
    ev.stopPropagation();
    // The click can land on the item's gutter or label span, so resolve back to
    // the <li> that carries data-index rather than trusting ev.target.
    const item = (<HTMLElement>ev.target).closest<HTMLElement>(".contextMenuItem");
    if (item === null) return;
    hideContextMenu();
    items[parseInt(item.dataset.index!)]!.onClick();
  });

  contextMenuSource = sourceElem;
  contextMenuSource.classList.add("contextMenuActive");
  // A source that isn't focusable on its own is lent a tabindex for the life of
  // the menu, so closing can hand focus back rather than dropping it on the
  // body. The graph's sources need no loan — they are permanently focusable.
  contextMenuSourceBorrowedFocus =
    !contextMenuSource.hasAttribute("tabindex") && contextMenuSource.tabIndex < 0;
  if (contextMenuSourceBorrowedFocus) contextMenuSource.tabIndex = -1;
  // Nothing is focused within the menu yet: matching native menus, the first
  // arrow key is what moves onto an item.
  contextMenu.focus({ preventScroll: true });
}

/** The menu's focusable items, in visual order (dividers excluded). */
function contextMenuItemElems() {
  return Array.from(contextMenu.querySelectorAll<HTMLElement>(".contextMenuItem"));
}

function focusContextMenuItem(index: number) {
  const elems = contextMenuItemElems();
  if (elems.length === 0) return;
  // Wrap around, mirroring native menu behaviour at either end.
  const target = elems[((index % elems.length) + elems.length) % elems.length]!;
  target.focus({ preventScroll: true });
  if (typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "nearest" });
}

function contextMenuKeydownListener(e: KeyboardEvent) {
  const elems = contextMenuItemElems();
  const focused = elems.indexOf(<HTMLElement>document.activeElement);
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      focusContextMenuItem(focused + 1);
      break;
    case "ArrowUp":
      // From the container (focused === -1) this lands on the last item, which
      // is what pressing Up on a freshly opened native menu does.
      e.preventDefault();
      focusContextMenuItem(focused - 1);
      break;
    case "Home":
      e.preventDefault();
      focusContextMenuItem(0);
      break;
    case "End":
      e.preventDefault();
      focusContextMenuItem(elems.length - 1);
      break;
    case "Enter":
    case " ":
      if (focused === -1) return;
      e.preventDefault();
      elems[focused]!.click();
      break;
    case "Tab":
      // Native menus dismiss rather than letting Tab walk out of them.
      e.preventDefault();
      hideContextMenu();
      break;
  }
}
function hideContextMenu() {
  // Only hand focus back when it was inside the menu to begin with. Dismissing
  // by clicking elsewhere must not yank focus away from wherever the click
  // just put it.
  const returnFocus = contextMenu.contains(document.activeElement);
  contextMenu.className = "";
  contextMenu.innerHTML = "";
  contextMenu.style.left = "0px";
  contextMenu.style.top = "0px";
  if (contextMenuSource !== null) {
    contextMenuSource.classList.remove("contextMenuActive");
    if (returnFocus && contextMenuSource.isConnected) {
      contextMenuSource.focus({ preventScroll: true });
    }
    if (contextMenuSourceBorrowedFocus) contextMenuSource.removeAttribute("tabindex");
    contextMenuSourceBorrowedFocus = false;
    contextMenuSource = null;
  }
}

/* Dialogs */
function showConfirmationDialog(
  message: string,
  confirmed: () => void,
  sourceElem: HTMLElement | null,
  onDismiss?: () => void
) {
  showDialog(
    message,
    l10n.dialogYes,
    l10n.dialogCancel,
    () => {
      hideDialog();
      confirmed();
    },
    sourceElem,
    onDismiss
  );
}
function showRefInputDialog(
  message: string,
  defaultValue: string,
  actionName: string,
  actioned: (value: string) => void,
  sourceElem: HTMLElement | null
) {
  showFormDialog(
    message,
    [{ type: "text-ref", name: "", default: defaultValue }],
    actionName,
    (values) => actioned(values[0]),
    sourceElem
  );
}
function showCheckboxDialog(
  message: string,
  checkboxLabel: string,
  checkboxValue: boolean,
  actionName: string,
  actioned: (value: boolean) => void,
  sourceElem: HTMLElement | null,
  rememberKey?: string
) {
  showFormDialog(
    message,
    [
      {
        type: "checkbox",
        name: checkboxLabel,
        value: checkboxValue,
        remember: rememberKey !== undefined
      }
    ],
    actionName,
    (values) => actioned(values[0] === "checked"),
    sourceElem,
    rememberKey
  );
}
function showSelectDialog(
  message: string,
  defaultValue: string,
  options: { name: string; value: string }[],
  actionName: string,
  actioned: (value: string) => void,
  sourceElem: HTMLElement | null,
  rememberKey?: string
) {
  showFormDialog(
    message,
    [
      {
        // A stable, non-displayed name (single selects never render their name)
        // so the remembered value is keyed by name, not position — see
        // dialogMemory.ts. Only meaningful when rememberKey is set.
        type: "select",
        name: "selection",
        options: options,
        default: defaultValue,
        remember: rememberKey !== undefined
      }
    ],
    actionName,
    (values) => actioned(values[0]),
    sourceElem,
    rememberKey
  );
}
/** On confirm, persist or forget a dialog's remembered choices based on the
 *  "Remember my choice" toggle. Updates the local copy optimistically; the save
 *  message to the extension host is one-way (globalState, shared across repos). */
function saveOrForgetDialogMemory(
  rememberKey: string,
  inputs: DialogInput[],
  values: string[],
  hadMemory: boolean
) {
  const rememberElem = <HTMLInputElement | null>document.getElementById("dialogRememberChoice");
  if (rememberElem === null) return; // present whenever rememberKey is set; defensive
  if (rememberElem.checked) {
    const remembered = extractDialogMemory(inputs, values);
    dialogMemory[rememberKey] = remembered;
    sendMessage({ command: "saveDialogMemory", dialogKey: rememberKey, values: remembered });
  } else if (hadMemory) {
    delete dialogMemory[rememberKey];
    sendMessage({ command: "saveDialogMemory", dialogKey: rememberKey, values: null });
  }
}
function showFormDialog(
  message: string,
  inputs: DialogInput[],
  actionName: string,
  actioned: (values: string[]) => void,
  sourceElem: HTMLElement | null,
  rememberKey?: string
) {
  // With a rememberKey, seed the remembered selects/checkboxes and offer a
  // "Remember my choice" toggle below the form (free-text inputs are never
  // remembered). hasMemory drives both the seeding and the toggle's checked
  // state, and lets a later un-check forget the stored choice.
  const hasMemory = rememberKey !== undefined && dialogMemory[rememberKey] !== undefined;
  if (rememberKey !== undefined) inputs = applyDialogMemory(inputs, dialogMemory[rememberKey]);
  let textRefInput = -1,
    multiElementForm = inputs.length > 1;
  let html =
    message + '<br><table class="dialogForm ' + (multiElementForm ? "multi" : "single") + '">';
  for (let i = 0; i < inputs.length; i++) {
    let input = inputs[i];
    if (input.type === "checkbox") {
      // Checkboxes always sit to the left of their own label (the native
      // VS Code direction), spanning the label column in multi-input forms.
      html +=
        "<tr><td" +
        (multiElementForm ? ' colspan="2"' : "") +
        '><span class="dialogFormCheckbox"><label><input id="dialogInput' +
        i +
        '" type="checkbox"' +
        (input.value ? " checked" : "") +
        "/>" +
        input.name +
        "</label></span></td></tr>";
      continue;
    }
    html += "<tr>" + (multiElementForm ? "<td>" + input.name + "</td>" : "") + "<td>";
    if (input.type === "select") {
      html += '<select id="dialogInput' + i + '">';
      for (let j = 0; j < input.options.length; j++) {
        html +=
          '<option value="' +
          input.options[j].value +
          '"' +
          (input.options[j].value === input.default ? " selected" : "") +
          ">" +
          escapeHtml(input.options[j].name) +
          "</option>";
      }
      html += "</select>";
    } else {
      html +=
        '<input id="dialogInput' +
        i +
        '" type="text" value="' +
        escapeHtml(input.default) +
        '"' +
        (input.type === "text" && input.placeholder !== null
          ? ' placeholder="' + escapeHtml(input.placeholder) + '"'
          : "") +
        "/>";
      if (input.type === "text-ref") textRefInput = i;
    }
    html += "</td></tr>";
  }
  html += "</table>";
  if (rememberKey !== undefined) {
    // Its own single-row form table (a direct child of #dialog) so it inherits
    // the themed checkbox styling without changing the layout of the inputs
    // above. Read back by its fixed id on submit.
    html +=
      '<br><table class="dialogForm single"><tr><td>' +
      '<span class="dialogFormCheckbox"><label><input id="dialogRememberChoice" type="checkbox"' +
      (hasMemory ? " checked" : "") +
      "/>" +
      l10n.dialogRememberChoice +
      "</label></span></td></tr></table>";
  }
  showDialog(
    html,
    actionName,
    l10n.dialogCancel,
    () => {
      if (dialog.className === "active noInput" || dialog.className === "active inputInvalid")
        return;
      let values = [];
      for (let i = 0; i < inputs.length; i++) {
        let input = inputs[i],
          elem = document.getElementById("dialogInput" + i);
        if (input.type === "select") {
          values.push((<HTMLSelectElement>elem).value);
        } else if (input.type === "checkbox") {
          values.push((<HTMLInputElement>elem).checked ? "checked" : "unchecked");
        } else {
          values.push((<HTMLInputElement>elem).value);
        }
      }
      if (rememberKey !== undefined)
        saveOrForgetDialogMemory(rememberKey, inputs, values, hasMemory);
      hideDialog();
      actioned(values);
    },
    sourceElem
  );

  if (textRefInput > -1) {
    let dialogInput = <HTMLInputElement>document.getElementById("dialogInput" + textRefInput),
      dialogAction = document.getElementById("dialogAction")!;
    if (dialogInput.value === "") dialog.className = "active noInput";
    dialogInput.focus();
    dialogInput.addEventListener("keyup", () => {
      const sub = viewState.referenceInputSpaceSubstitution;
      if (sub !== "None" && dialogInput.value.includes(" ")) {
        const pos = dialogInput.selectionStart;
        dialogInput.value = substituteRefSpaces(dialogInput.value, sub);
        if (pos !== null) dialogInput.setSelectionRange(pos, pos);
      }
      let noInput = dialogInput.value === "",
        invalidInput = dialogInput.value.match(refInvalid) !== null;
      let newClassName = "active" + (noInput ? " noInput" : invalidInput ? " inputInvalid" : "");
      if (dialog.className !== newClassName) {
        dialog.className = newClassName;
        dialogAction.title = invalidInput ? l10n.invalidCharacters.replace("{0}", actionName) : "";
      }
    });
  }
}
function showTagDetailsDialog(details: GitTagDetails) {
  let html = "<b>" + l10n.detailTagObject + "</b>" + escapeHtml(details.tagHash) + "<br>";
  html += "<b>" + l10n.detailCommit + "</b>" + escapeHtml(details.commitHash) + "<br>";
  html += "<b>" + l10n.detailTagger + "</b>" + escapeHtml(details.name);
  if (details.email !== "") {
    html +=
      ' &lt;<a href="mailto:' +
      encodeURIComponent(details.email) +
      '">' +
      escapeHtml(details.email) +
      "</a>&gt;";
  }
  html += "<br>";
  if (details.date !== null) {
    html += "<b>" + l10n.detailDate + "</b>" + new Date(details.date * 1000).toString() + "<br>";
  }
  const tagSig = signatureCategory(details.signatureStatus);
  if (tagSig !== null) {
    html +=
      "<b>" +
      l10n.detailSignature +
      '</b><span class="commitSignature ' +
      tagSig +
      '">' +
      (tagSig === "bad" ? "✗" : tagSig === "good" ? "✓" : "?") +
      "</span> " +
      (tagSig === "good"
        ? l10n.signatureGood
        : tagSig === "unverified"
          ? l10n.signatureUnverified
          : l10n.signatureBad) +
      "<br>";
  }
  if (details.message !== "") {
    let msg = preserveLeadingWhitespace(escapeHtml(details.message));
    if (viewState.markdown) msg = renderInlineMarkdown(msg);
    html += "<br>" + msg.replace(/\n/g, "<br>");
  }
  showDialog(html, null, l10n.dialogDismiss, null, null);
}
function showErrorDialog(
  message: string,
  reason: string | null,
  sourceElem: HTMLElement | null,
  onDismiss?: () => void
) {
  showDialog(
    svgIcons.alert +
      message +
      (reason !== null
        ? '<br><span class="errorReason">' + escapeHtml(reason).split("\n").join("<br>") + "</span>"
        : ""),
    null,
    l10n.dialogDismiss,
    null,
    sourceElem,
    onDismiss
  );
}
/**
 * The one place a progress dialog is built.
 *
 * `#actionRunning` is not decoration: it is the mark by which
 * {@link hideReloadOwnedOverlays} tells a dialog the webview raised for an
 * action in flight from a question it asked the user. A progress dialog written
 * out by hand somewhere else would either carry the mark by imitation — a
 * convention with nothing enforcing it — or lack it, and then survive the very
 * reload it was waiting for. So the markup is built here and the entry points
 * below differ only in what they pass in.
 *
 * `content` is inserted as HTML, so callers escape their own interpolations;
 * `dismissName` is the Dismiss button's label, which the cleanup scan replaces
 * with "Stop" because for that one wait, dismissing is what stops it.
 */
function showActionRunningDialogWith(content: string, dismissName: string, onDismiss?: () => void) {
  showDialog(
    '<span id="actionRunning">' + svgIcons.loading + content + "</span>",
    null,
    dismissName,
    null,
    null,
    onDismiss
  );
}
function showActionRunningDialog(command: string) {
  showActionRunningDialogWith(command + " ...", l10n.dialogDismiss);
}
function showDialog(
  html: string,
  actionName: string | null,
  dismissName: string,
  actioned: (() => void) | null,
  sourceElem: HTMLElement | null,
  onDismiss?: () => void
) {
  // Writing over the batch retry offer takes away a question with neither
  // answer given, and the run behind it has no other way to hear about that
  // (#125). This is the one funnel every dialog is raised through, so it is the
  // one place that catches all of the offer's destruction routes rather than
  // the eight-and-counting call sites that take it. Before the new markup, so
  // the dialog arriving here keeps the screen — see `abandonBatchRun`.
  if (document.getElementById("batchRetryOffer") !== null) gitGraph.abandonBatchRun();
  dialogBacking.className = "active";
  dialog.className = "active";
  dialog.innerHTML =
    html +
    '<div class="dialogButtons">' +
    (actionName !== null
      ? '<div id="dialogAction" class="roundedBtn">' + actionName + "</div>"
      : "") +
    '<div id="dialogDismiss" class="roundedBtn">' +
    dismissName +
    "</div></div>";
  if (actionName !== null && actioned !== null)
    document.getElementById("dialogAction")!.addEventListener("click", actioned);
  dialogDismissAction = onDismiss ?? null;
  document.getElementById("dialogDismiss")!.addEventListener("click", dismissDialog);

  dialogMenuSource = sourceElem;
  if (dialogMenuSource !== null) dialogMenuSource.classList.add("dialogActive");
}
/** Close the dialog. The plain close: the dialog's dismissal hook does *not*
 *  run, because this is also how a dialog closes when its action was taken —
 *  a confirmed dialog was not dismissed. Anything closing a dialog the user did
 *  not answer wants {@link dismissDialog} instead. */
function hideDialog() {
  dialogBacking.className = "";
  dialog.className = "";
  dialog.innerHTML = "";
  dialogDismissAction = null;
  if (dialogMenuSource !== null) {
    dialogMenuSource.classList.remove("dialogActive");
    dialogMenuSource = null;
  }
  // The slot is empty; a batch summary owed one is now due. As a microtask
  // rather than a call, because closing is rarely the last thing a route does
  // — the Yes that closes this dialog goes on to raise the next one — and the
  // summary is only due if the slot is *still* free once it has (see
  // `deliverOwedBatchSummary`, which checks).
  queueMicrotask(() => gitGraph.deliverOwedBatchSummary());
}
/** Close the dialog the way its own Dismiss button does, running whatever it
 *  declared for that. The hook is read before the close so that a hook which
 *  opens a dialog of its own is not undone by the close that invited it. */
function dismissDialog() {
  const onDismiss = dialogDismissAction;
  hideDialog();
  if (onDismiss !== null) onDismiss();
}

/** Whether a modal dialog is up. Three callers want quite different things of
 *  it — one closes the dialog, one hands it the keyboard, one holds automatic
 *  loading back (#124) — and what they share is the question, not the answer,
 *  which is why this is the question rather than a third spelling of it. */
function isDialogOpen() {
  return dialog.classList.contains("active");
}

/** Escape, and the other places that close both overlays on the user's behalf.
 *  A dismissal, not a plain close: reaching here means the user walked away
 *  from the dialog rather than answering it. */
function hideDialogAndContextMenu() {
  if (isDialogOpen()) dismissDialog();
  if (contextMenu.classList.contains("active")) hideContextMenu();
}

/**
 * Close the progress dialog and the context menu when a background reload
 * finishes.
 *
 * The reload's own action put up a progress dialog ("Checking out …") and that
 * dialog has nothing left to say once the reload lands; leaving it up strands
 * the user behind an overlay whose only exit is Escape. But a *confirmation*
 * standing at the same moment belongs to the user, not to the reload: the file
 * watcher fires on any `.git` write, so an unrelated commit in the terminal
 * would otherwise take away a question the user is halfway through reading —
 * and with it any chance of answering Yes.
 *
 * `#actionRunning` is what separates those two, and that is the whole of what
 * it separates. It is an existence check, not an identity: it cannot tell this
 * reload's own progress dialog from one belonging to a host query that has
 * nothing to do with the reload. "Check for Unmerged Changes" and the cleanup
 * dialog's own opening request both raise one, and both still lose it to an
 * unrelated reload — after which their answers are dropped on arrival by the
 * same existence check (`showBranchRedundancy`, `handleBranchCleanupOpen`).
 * That predates this split, which only narrows what gets closed; the fix is to
 * correlate by token, and it is tracked on #127 rather than smuggled in here.
 * Every progress dialog is built by {@link showActionRunningDialogWith} rather
 * than by hand so that the mark is at least produced in one place.
 *
 * The context menu is not held back with it, deliberately. Its contents are a
 * snapshot — what can be dropped, what is HEAD, which refs are cleanup
 * candidates, the rebase range — computed from exactly the state the redraw has
 * just replaced, and it is positioned in page coordinates against a row that no
 * longer exists there. Keeping it open would keep offering Drop, Reset and
 * Delete computed against a graph that has moved underneath them. Reopening it
 * costs one right-click; a half-filled dialog cannot be reopened at all.
 */
function hideReloadOwnedOverlays() {
  if (document.getElementById("actionRunning") !== null) dismissDialog();
  if (contextMenu.classList.contains("active")) hideContextMenu();
}

/* Global Listeners */
// However focus arrives — a click, Tab, or the arrow keys — the group it landed
// in points its tab stop at it, so Tab comes back to where the user left off.
document.addEventListener("focusin", (e) => gitGraph.syncTabStop(e.target));
document.addEventListener("keyup", (e) => {
  if (e.key === "Escape") {
    hideDialogAndContextMenu();
  }
});
// Rows of overlap kept when Page Up/Down jumps a screenful, so the user has
// something to re-orient against on the far side of the jump. Up/Down no longer
// scroll at all — they move focus between rows (see ADR-0014).
const PAGE_SCROLL_OVERLAP = 48;
function pageScrollStep() {
  return Math.max(window.innerHeight - PAGE_SCROLL_OVERLAP, PAGE_SCROLL_OVERLAP);
}
document.addEventListener("keydown", (e) => {
  if (isDialogOpen()) {
    // Enter submits the dialog's primary (left) action, but not while an IME
    // composition is in progress (e.g. the Enter that confirms a CJK candidate
    // on macOS reports isComposing on keydown). The action's own click handler
    // no-ops when the form is empty/invalid, so firing it is safe.
    if (e.key === "Enter" && !e.isComposing) {
      const dialogAction = document.getElementById("dialogAction");
      if (dialogAction !== null) dialogAction.click();
    }
    return;
  }
  // An open menu owns the keyboard: arrows walk its items instead of scrolling
  // the graph, and Enter runs the focused action. Escape is handled on keyup.
  if (contextMenu.classList.contains("active")) {
    contextMenuKeydownListener(e);
    return;
  }
  // Don't hijack keys (arrows, Ctrl+R/H/F) while the user is typing in a text
  // field such as the Find input or a dropdown filter.
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
  // The repo dropdown is a popup and owns the keyboard while it is open, the
  // same way the context menu above does — its own listener handles the keys it
  // wants, and nothing here may move focus out from under the rest.
  if (document.getElementById("repoDropdownList")?.classList.contains("active") === true) return;
  // Configurable CTRL/CMD shortcuts; each is null when set to UNASSIGNED.
  const kb = viewState.keybindings;
  const key = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && kb.refresh !== null && key === kb.refresh) {
    e.preventDefault();
    gitGraph.refresh(true);
  } else if ((e.ctrlKey || e.metaKey) && kb.scrollToHead !== null && key === kb.scrollToHead) {
    e.preventDefault();
    gitGraph.scrollToHead();
  } else if ((e.ctrlKey || e.metaKey) && kb.find !== null && key === kb.find) {
    e.preventDefault();
    gitGraph.showFind();
  } else if ((e.ctrlKey || e.metaKey) && kb.scrollToStash !== null && key === kb.scrollToStash) {
    e.preventDefault();
    gitGraph.scrollToStash(!e.shiftKey);
  } else if ((e.ctrlKey || e.metaKey) && e.key === "ArrowUp") {
    // Shift follows the alternative branch at a fork.
    if (gitGraph.commitDetailsNavigateGraph("child", e.shiftKey)) e.preventDefault();
  } else if ((e.ctrlKey || e.metaKey) && e.key === "ArrowDown") {
    if (gitGraph.commitDetailsNavigateGraph("parent", e.shiftKey)) e.preventDefault();
  } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    // Down out of the footer is the one direction with nowhere to go. ADR-0014
    // made Up/Down unconditional and had them "enter the grid" when nothing
    // held focus, because nothing holding focus meant `<body>`, which is
    // nowhere; since #88 the footer is somewhere, and it is *below* the graph.
    // That makes the two directions different, so they are treated
    // differently rather than as one "focus is outside the grid" case:
    //
    // - **Up** has the whole table above it, and `moveRowFocus(-1)` steps into
    //   the last row — which is the row directly above the footer, and exactly
    //   what ADR-0014 asks for. It keeps the key.
    // - **Down** has nothing below it. Entering the grid from the *first* row
    //   would answer it by travelling up past every loaded commit to the top
    //   of the table, so the key goes back to the browser, whose answer is to
    //   scroll. That is the one Down here can mean.
    if (e.key === "ArrowDown" && active instanceof HTMLElement) {
      if (active.closest("#footer") !== null) return;
    }
    // Up/Down move focus between rows, as they do in any list — inside the
    // Commit Details View's file list when focus is there, otherwise through
    // the graph's own rows. Scrolling is Page Up/Down's job now.
    e.preventDefault();
    const delta = e.key === "ArrowUp" ? -1 : 1;
    if (!gitGraph.moveCdvFileFocus(delta)) gitGraph.moveRowFocus(delta);
  } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    if (gitGraph.moveWidgetFocus(e.key === "ArrowLeft" ? -1 : 1)) e.preventDefault();
  } else if (e.key === "PageUp" || e.key === "PageDown") {
    e.preventDefault();
    window.scrollBy(0, e.key === "PageUp" ? -pageScrollStep() : pageScrollStep());
  } else if (e.key === "Enter" || e.key === " ") {
    // Activate the focused row the way a click would. The ref chips and column
    // headers have no click action of their own — their actions live in the
    // menu — but routing every member through the same call keeps the rule to
    // one sentence, and stops Space scrolling the page out from under them.
    if (active instanceof HTMLElement && active.matches(ACTIVATABLE)) {
      e.preventDefault();
      active.click();
    }
  } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
    if (active instanceof HTMLElement && active.matches(MENU_SOURCES)) {
      e.preventDefault();
      active.dispatchEvent(new Event(MENU_KEY_EVENT, { bubbles: true }));
    }
  }
});
document.addEventListener("click", hideContextMenuListener);
document.addEventListener("contextmenu", hideContextMenuListener);
document.addEventListener("mouseleave", hideContextMenuListener);
// A click on the context menu itself but not on a specific item (e.g. a divider
// or the padding) should keep it open so the user can re-aim, rather than
// bubbling to the document listener that closes it.
contextMenu.addEventListener("click", (e) => e.stopPropagation());
function hideContextMenuListener() {
  if (contextMenu.classList.contains("active")) hideContextMenu();
}
