import type {
  BatchActionRequest,
  BatchDeleteResult,
  BatchRefResult,
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
import { displayRef } from "@/backend/utils/branchRef";

import { BatchRun, type BatchRunCommand, type BatchRunOptions } from "./batchRun";
import { applyDialogMemory, extractDialogMemory } from "./dialogMemory";
import { Graph } from "./graph";
import { formatDate, pad2 } from "./utils/date";
import { addListenerToClass, blinkHeadRow, insertAfter } from "./utils/dom";
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
  commitMatchesQuery,
  commitNodeTooltip,
  commitsReachableFrom,
  dropCommitPossible,
  ELLIPSIS,
  graphNavigationTarget,
  latestTagName,
  refInvalid,
  signatureCategory,
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
import { getVSCodeStyle, sendMessage, vscode } from "./utils/vscode";

/** Split a remote ref "<remote>/<branch>" on its first slash. Null for the
 *  symbolic "<remote>/HEAD" ref and for names without a slash — the callers
 *  offer no remote-branch operations on those. */
function splitRemoteRef(refName: string): { remote: string; branchOnRemote: string } | null {
  const slashIndex = refName.indexOf("/");
  if (slashIndex === -1) return null;
  const branchOnRemote = refName.substring(slashIndex + 1);
  if (branchOnRemote === "HEAD") return null;
  return { remote: refName.substring(0, slashIndex), branchOnRemote };
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

class GitGraphView {
  private gitRepos: GG.GitRepoSet;
  private gitBranches: string[] = [];
  private gitBranchHead: string | null = null;
  private remotes: string[] = [];
  private pushDefault: string | null = null;
  private findActive = false;
  private findMatches: string[] = []; // hashes of matching commits, in graph order
  private findCurrent = -1;
  // When on, navigating find matches also opens each one's details view.
  private findOpenCommitDetails = false;
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
  private currentRepo!: string;
  // The last branch-deletion request, so a failed non-force delete can offer a
  // one-click force delete.
  private pendingDeleteBranch: { branchName: string; deleteOnRemotes: boolean } | null = null;
  // A branch action delegated by the Branches side-view, held until this view
  // shows the right repo with its data loaded. lastRefActionSeq dedupes the
  // host's two delivery paths (direct post + post-reload flush).
  private pendingRefAction: GG.ResponseRunRefAction | GG.ResponseRunRefBatchAction | null = null;
  private lastRefActionSeq = 0;
  // The one batch run in flight (at most): rounds, retry offer and summary all
  // live behind its interface — the adapters below only execute its commands.
  private batchRun = new BatchRun();

  private graph: Graph;
  private config: Config;
  private moreCommitsAvailable: boolean = false;
  private loadingMore = false;
  // Scroll offset to restore once the next load re-renders the table, so an
  // action / manual refresh keeps the user's place rather than jumping.
  private pendingScrollRestore: number | null = null;
  private showRemoteBranches: boolean = true;
  private expandedCommit: ExpandedCommit | null = null;
  private maxCommits: number;
  private hasScrolledToHeadOnLoad = false;
  private columnVisibility = { date: true, author: true, commit: true };
  private currentStashScroll = -1;
  private alwaysAcceptCheckoutCommit = false;

  private tableElem: HTMLElement;
  private footerElem: HTMLElement;
  private scrollShadowElem: HTMLElement;

  private loadBranchesCallback: ((changes: boolean, isRepo: boolean) => void) | null = null;
  private loadCommitsCallback: ((changes: boolean) => void) | null = null;

  constructor(
    repos: GG.GitRepoSet,
    lastActiveRepo: string | null,
    config: Config,
    prevState: WebViewState | null
  ) {
    this.gitRepos = repos;
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
        // Opened by a plain click, unlike the contextmenu-driven menus — stop
        // the click before it reaches the document listener that would dismiss
        // the menu it just opened.
        e.stopPropagation();
        this.showRepoDropdown(<MouseEvent>e);
      });
    }
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
    this.maxCommits = this.config.initialLoadCommits;
    this.clearExpandedCommit();
    this.setCurrentBranches(null);
    this.applyShowRemoteBranchesForRepo();
    this.updateRepoTitle();
    this.saveState();
    sendMessage({ command: "selectRepo", repo });
    this.refresh(true);
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

  /** Refresh the toolbar's title block: the repo's display name (custom name,
   *  else its folder name) over the checked-out branch. With several repos
   *  known the block doubles as the repo dropdown's trigger, so it also gains
   *  the affordances for that — the chevron, the cursor and the tooltip (#16). */
  private updateRepoTitle() {
    const titleElem = document.getElementById("repoTitle");
    const nameElem = document.getElementById("repoTitleName");
    const branchElem = document.getElementById("repoTitleBranch");
    if (titleElem === null || nameElem === null || branchElem === null) return;
    const multipleRepos = Object.keys(this.gitRepos).length > 1;
    titleElem.classList.toggle("multipleRepos", multipleRepos);
    titleElem.title = multipleRepos ? l10n.switchRepo : "";
    const repo: string | undefined = this.currentRepo;
    if (repo === undefined) {
      nameElem.textContent = "";
      branchElem.textContent = "";
      return;
    }
    const branch = this.gitBranchHead ?? "";
    nameElem.textContent = this.repoDisplayName(repo);
    nameElem.title = repo;
    branchElem.textContent = branch;
    branchElem.title = branch;
  }

  /** Open the repo dropdown: a menu of every known repository from which the
   *  user can switch the graph. Only offered when several repos are known —
   *  with one repo the title is a plain label and the click does nothing. */
  private showRepoDropdown(e: MouseEvent) {
    const repoPaths = Object.keys(this.gitRepos);
    if (repoPaths.length < 2) return;
    const sourceElem = document.getElementById("repoTitle");
    if (sourceElem === null) return;
    showContextMenu(
      e,
      repoPaths.map((repo) => ({
        title: escapeHtml(this.repoDisplayName(repo)),
        checked: repo === this.currentRepo,
        onClick: () => this.setRepo(repo)
      })),
      sourceElem
    );
  }

  /** Apply a "Show Remote Branches" change driven by the Branches side-view's
   *  toggle, keeping the local per-repo copy in sync and reloading the graph. */
  public setShowRemoteBranches(value: boolean) {
    if (this.showRemoteBranches === value) return;
    this.showRemoteBranches = value;
    if (typeof this.gitRepos[this.currentRepo] !== "undefined") {
      this.gitRepos[this.currentRepo].showRemoteBranches = value;
    }
    this.saveState();
    this.refresh(true);
  }

  /** Send a branch-deletion request, remembering its parameters so a failed
   *  non-force delete can offer a one-click force delete. */
  private sendDeleteBranch(branchName: string, forceDelete: boolean, deleteOnRemotes: boolean) {
    this.pendingDeleteBranch = { branchName, deleteOnRemotes };
    sendMessage({
      command: "deleteBranch",
      repo: this.currentRepo!,
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
      showConfirmationDialog(
        l10n.dialogForceDeleteBranchConfirm.replace(
          "{0}",
          "<b><i>" + escapeHtml(pending.branchName) + "</i></b>"
        ),
        () => this.sendDeleteBranch(pending.branchName, true, pending.deleteOnRemotes),
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
    this.maxCommits = this.config.initialLoadCommits;
    this.clearExpandedCommit();
    this.setCurrentBranches(null);
    this.applyShowRemoteBranchesForRepo();
    this.updateRepoTitle();
    this.saveState();
    sendMessage({ command: "selectRepo", repo: this.currentRepo });
    this.refresh(true);
  }

  /* Loading Data */
  public loadRepos(repos: GG.GitRepoSet, lastActiveRepo: string | null) {
    this.gitRepos = repos;
    this.saveState();

    let repoPaths = Object.keys(repos),
      changedRepo = false;
    if (typeof repos[this.currentRepo] === "undefined") {
      this.currentRepo =
        lastActiveRepo !== null && typeof repos[lastActiveRepo] !== "undefined"
          ? lastActiveRepo
          : repoPaths[0];
      this.saveState();
      changedRepo = true;
    }

    if (changedRepo) {
      this.applyShowRemoteBranchesForRepo();
      this.refresh(true);
    }
    // Unconditional: a repo's customName may have changed without a repo switch.
    this.updateRepoTitle();
  }

  /** Reload commits after the branch selection changed: reset paging, close any
   *  open details, show the loading state, and request the new commit set. */
  private reloadForBranchChange() {
    this.maxCommits = this.config.initialLoadCommits;
    this.clearExpandedCommit();
    this.saveState();
    // Keep the current graph on screen and show the busy indicator while the new
    // commits load, rather than blanking to a loading screen (which flickers on
    // every branch toggle/switch). render() replaces the table atomically.
    this.setRefreshing(true);
    this.requestLoadCommits(true, () => this.setRefreshing(false));
  }

  public loadBranches(
    branchOptions: string[],
    branchHead: string | null,
    hard: boolean,
    isRepo: boolean,
    filter: string[],
    dimmedBranches: string[] = []
  ) {
    if (!isRepo) {
      this.triggerLoadBranchesCallback(false, isRepo);
      return;
    }
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
      this.render();

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

  /** Show/clear the busy indicator on the Refresh button while a load runs. */
  private setRefreshing(refreshing: boolean) {
    document.getElementById("refreshBtn")?.classList.toggle("refreshing", refreshing);
  }

  /* Requests */
  private requestLoadBranches(
    hard: boolean,
    loadedCallback: (changes: boolean, isRepo: boolean) => void
  ) {
    if (this.loadBranchesCallback !== null) return;
    this.loadBranchesCallback = loadedCallback;
    sendMessage({ command: "selectRepo", repo: this.currentRepo });
    sendMessage({ command: "loadRemotes" });
    sendMessage({
      command: "loadBranches",
      showRemoteBranches: this.showRemoteBranches,
      hard: hard
    });
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
  private requestLoadCommits(hard: boolean, loadedCallback: (changes: boolean) => void) {
    if (this.loadCommitsCallback !== null) return;
    this.loadCommitsCallback = loadedCallback;
    sendMessage({
      command: "loadCommits",
      repo: this.currentRepo!,
      branchNames: this.currentBranches !== null ? this.currentBranches : [""],
      maxCommits: this.maxCommits,
      showRemoteBranches: this.showRemoteBranches,
      hard: hard,
      commitOrder: this.gitRepos[this.currentRepo!]?.commitOrdering ?? undefined,
      hiddenRemotes: this.gitRepos[this.currentRepo!]?.hiddenRemotes ?? undefined
    });
  }
  private requestLoadBranchesAndCommits(hard: boolean) {
    this.setRefreshing(true);
    // Refresh the conflict banner alongside every (re)load so it tracks the
    // repo's operation state (.git changes trigger a refresh via the watcher).
    if (this.currentRepo) {
      sendMessage({ command: "operationState", repo: this.currentRepo });
    }
    this.requestLoadBranches(hard, (branchChanges: boolean, isRepo: boolean) => {
      if (isRepo) {
        this.requestLoadCommits(hard, (commitChanges: boolean) => {
          this.setRefreshing(false);
          // Dismiss the action-running dialog / context menu once the reload
          // finishes. Hard refreshes follow an action (checkout, merge, …) so
          // always close; soft refreshes only close when something changed.
          if (hard || branchChanges || commitChanges) {
            hideDialogAndContextMenu();
          }
        });
      } else {
        this.setRefreshing(false);
        sendMessage({ command: "loadRepos", check: true });
      }
    });
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
  private render() {
    this.renderTable();
    this.renderGraph();
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
  private renderTable() {
    const hiddenDate = this.columnVisibility.date ? "" : " hidden";
    const hiddenAuthor = this.columnVisibility.author ? "" : " hidden";
    const hiddenCommit = this.columnVisibility.commit ? "" : " hidden";
    let html = `<tr id="tableColHeaders"><th id="tableHeaderGraphCol" class="tableColHeader"></th><th class="tableColHeader">${l10n.description}</th><th class="tableColHeader${hiddenDate}" data-col="date">${l10n.date}</th><th class="tableColHeader${hiddenAuthor}" data-col="author">${l10n.author}</th><th class="tableColHeader${hiddenCommit}" data-col="commit">${l10n.commit}</th></tr>`,
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
      '" data-name="' +
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
          ? '<td><span style="margin-left:' +
            (widthsAtVertices[i] - 4) +
            'px"' +
            refBranches.substring(5) +
            "</td>"
          : "<td></td>";
      const descCell = "<td>" + headDot + (aligned ? "" : refBranches) + descCore + "</td>";
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
        ' data-id="' +
        i +
        '" data-color="' +
        this.graph.getVertexColour(i) +
        '">' +
        graphCell +
        descCell +
        '<td class="' +
        (hiddenDate ? "hidden" : "") +
        '" title="' +
        date.title +
        '">' +
        date.value +
        '</td><td class="' +
        (hiddenAuthor ? "hidden" : "") +
        '" title="' +
        escapeHtml(this.commits[i].author + " <" + this.commits[i].email + ">") +
        '">' +
        this.avatarHtml(this.commits[i].email) +
        escapeHtml(this.commits[i].author) +
        '</td><td class="' +
        (hiddenCommit ? "hidden" : "") +
        '" title="' +
        escapeHtml(this.commits[i].hash) +
        '">' +
        abbrevCommit(this.commits[i].hash) +
        "</td></tr>";
    }
    this.tableElem.innerHTML = "<table>" + html + "</table>";
    // Re-apply find highlighting to the freshly-rendered rows (without scrolling).
    if (this.findActive) this.applyFindHighlights(false);
    this.footerElem.innerHTML = this.moreCommitsAvailable
      ? '<div id="loadMoreCommitsBtn" class="roundedBtn">' + l10n.loadMore + "</div>"
      : "";
    this.makeTableResizable();

    if (this.moreCommitsAvailable) {
      document.getElementById("loadMoreCommitsBtn")!.addEventListener("click", () => {
        this.loadMoreCommits();
      });
    }

    if (this.expandedCommit !== null) {
      let elem = null,
        elems = <HTMLCollectionOf<HTMLElement>>document.getElementsByClassName("commit");
      for (i = 0; i < elems.length; i++) {
        if (this.expandedCommit.hash === elems[i].dataset.hash) {
          elem = elems[i];
          break;
        }
      }
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
          let compareElem: HTMLElement | null = null;
          for (i = 0; i < elems.length; i++) {
            if (this.expandedCommit.compareWithHash === elems[i].dataset.hash) {
              compareElem = elems[i];
              break;
            }
          }
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

    addListenerToClass("tableColHeader", "contextmenu", (e: Event) => {
      const headerElem = <HTMLElement>(<Element>e.target).closest(".tableColHeader")!;
      // Only the Date/Author/Commit headers carry a data-col and can be toggled.
      if (headerElem.dataset.col === undefined) return;
      e.stopPropagation();
      const toggle = (col: "date" | "author" | "commit") => {
        this.columnVisibility[col] = !this.columnVisibility[col];
        this.saveState();
        this.renderTable();
        this.renderGraph();
      };
      const item = (col: "date" | "author" | "commit", label: string) => ({
        title: label,
        checked: this.columnVisibility[col],
        onClick: () => toggle(col)
      });
      // Per-repo commit-ordering override (null = use the global setting).
      const currentOrder = this.gitRepos[this.currentRepo!]?.commitOrdering ?? null;
      const setOrder = (order: CommitOrdering | null) => {
        this.gitRepos[this.currentRepo!].commitOrdering = order;
        sendMessage({
          command: "saveRepoState",
          repo: this.currentRepo!,
          state: this.gitRepos[this.currentRepo!]
        });
        this.maxCommits = this.config.initialLoadCommits;
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
    addListenerToClass("commit", "contextmenu", (e: Event) => {
      e.stopPropagation();
      let sourceElem = <HTMLElement>(<Element>e.target).closest(".commit")!;
      let hash = sourceElem.dataset.hash!;
      // Drop is only offered when the topological check passes.
      const canDrop = dropCommitPossible(hash, this.commits, this.commitLookup, this.commitHead);
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
                  const send = (force: boolean) => {
                    sendMessage({
                      command: "addTag",
                      repo: this.currentRepo!,
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
                    showConfirmationDialog(
                      l10n.dialogAddTagExists.replace(
                        "{0}",
                        "<b><i>" + escapeHtml(tagName) + "</i></b>"
                      ),
                      () => send(true),
                      null
                    );
                  } else {
                    send(false);
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
                  const send = (force: boolean) => {
                    sendMessage({
                      command: "createBranch",
                      repo: this.currentRepo!,
                      branchName,
                      commitHash: hash,
                      checkout,
                      force
                    });
                  };
                  // A local branch with this name already exists: confirm replacing it.
                  if (this.gitBranches.includes(branchName)) {
                    showConfirmationDialog(
                      l10n.dialogCreateBranchExists.replace(
                        "{0}",
                        "<b><i>" + escapeHtml(branchName) + "</i></b>"
                      ),
                      () => send(true),
                      null
                    );
                  } else {
                    send(false);
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
                showConfirmationDialog(
                  l10n.dialogRevertConfirm.replace(
                    "{0}",
                    "<b><i>" + abbrevCommit(hash) + "</i></b>"
                  ),
                  () => {
                    sendMessage({
                      command: "revertCommit",
                      repo: this.currentRepo!,
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
          {
            visible: cmv.rebase,
            title: l10n.rebaseOnCommit + ELLIPSIS,
            icon: "rebase",
            onClick: () => {
              showConfirmationDialog(
                l10n.dialogRebaseConfirm
                  .replace("{0}", "<b><i>" + abbrevCommit(hash) + "</i></b>")
                  .replace("{1}", this.currentBranchLabel()),
                () => {
                  sendMessage({ command: "rebaseOn", repo: this.currentRepo!, obj: hash });
                  showActionRunningDialog(l10n.rebasing);
                },
                sourceElem
              );
            }
          },
          ...(canDrop
            ? <ContextMenuElement[]>[
                {
                  title: l10n.drop + ELLIPSIS,
                  icon: "trash",
                  visible: cmv.drop,
                  onClick: () => {
                    showConfirmationDialog(
                      l10n.dialogDropConfirm.replace(
                        "{0}",
                        "<b><i>" + abbrevCommit(hash) + "</i></b>"
                      ),
                      () => {
                        sendMessage({
                          command: "dropCommit",
                          repo: this.currentRepo!,
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
    addListenerToClass("commit", "click", (e: Event) => {
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
    addListenerToClass("unsavedChanges", "contextmenu", (e: Event) => {
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
              showConfirmationDialog(
                l10n.dialogResetUncommittedConfirm,
                () => sendMessage({ command: "resetUncommittedChanges", repo: this.currentRepo! }),
                null
              );
            }
          },
          {
            title: l10n.cleanUntracked + ELLIPSIS,
            icon: "trash",
            visible: ucv.clean,
            onClick: () => {
              showConfirmationDialog(
                l10n.dialogCleanUntrackedConfirm,
                () => sendMessage({ command: "cleanUntrackedFiles", repo: this.currentRepo! }),
                null
              );
            }
          }
        ],
        sourceElem
      );
    });
    addListenerToClass("gitRef", "contextmenu", (e: Event) => {
      e.stopPropagation();
      let sourceElem = <HTMLElement>(<Element>e.target).closest(".gitRef")!;
      let refName = unescapeHtml(sourceElem.dataset.name!),
        menu: ContextMenuElement[],
        copyType: string,
        copyTitle: string,
        copyVisible: boolean; // gated per ref type below
      const cmv = viewState.contextMenuActionsVisibility; // per-action visibility
      if (sourceElem.classList.contains("stash")) {
        // Stash refs aren't branches/tags — offer stash-specific actions.
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
        menu = [
          {
            title: l10n.stashApply + ELLIPSIS,
            visible: cmv.stash.apply,
            onClick: () => applyOrPop("applyStash", l10n.dialogStashApplyConfirm)
          },
          {
            title: l10n.stashPop + ELLIPSIS,
            visible: cmv.stash.pop,
            onClick: () => applyOrPop("popStash", l10n.dialogStashPopConfirm)
          },
          {
            title: l10n.stashDrop + ELLIPSIS,
            icon: "trash",
            visible: cmv.stash.drop,
            onClick: () => {
              showConfirmationDialog(
                l10n.dialogStashDropConfirm.replace(
                  "{0}",
                  "<b><i>" + escapeHtml(refName) + "</i></b>"
                ),
                () =>
                  sendMessage({ command: "dropStash", repo: this.currentRepo!, selector: refName }),
                sourceElem
              );
            }
          },
          {
            title: l10n.stashRename + ELLIPSIS,
            icon: "pencil",
            visible: true,
            onClick: () => {
              // Pre-fill with the stash's current displayed name (its commit
              // subject), taken from the loaded stash node for this ref.
              const currentMessage =
                this.commits.find((c) =>
                  c.refs.some((r) => r.type === "stash" && r.name === refName)
                )?.message ?? "";
              showFormDialog(
                l10n.dialogStashRenameTitle.replace(
                  "{0}",
                  "<b><i>" + escapeHtml(refName) + "</i></b>"
                ),
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
            }
          }
        ];
        copyType = "Stash Name";
        copyTitle = l10n.copyStashName;
        copyVisible = cmv.stash.copyName;
      } else if (sourceElem.classList.contains("tag")) {
        menu = [
          {
            title: l10n.viewTagDetails + ELLIPSIS,
            visible: cmv.tag.viewDetails,
            onClick: () => {
              sendMessage({ command: "tagDetails", repo: this.currentRepo!, tagName: refName });
            }
          },
          {
            title: l10n.createArchive + ELLIPSIS,
            visible: cmv.tag.createArchive,
            onClick: () => {
              sendMessage({ command: "createArchive", repo: this.currentRepo!, ref: refName });
            }
          },
          {
            title: l10n.deleteTag + ELLIPSIS,
            icon: "trash",
            visible: cmv.tag.delete,
            onClick: () => {
              const confirmMsg = l10n.dialogDeleteConfirm
                .replace("{0}", l10n.labelTag)
                .replace("{1}", "<b><i>" + escapeHtml(refName) + "</i></b>");
              if (this.remotes.length === 0) {
                showConfirmationDialog(
                  confirmMsg,
                  () => {
                    sendMessage({
                      command: "deleteTag",
                      repo: this.currentRepo!,
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
            }
          }
        ];
        if (this.remotes.length > 0) {
          menu.push({
            title: l10n.pushTag + ELLIPSIS,
            icon: "repoPush",
            visible: cmv.tag.push,
            onClick: () => this.pushTagAction(refName)
          });
        }
        copyType = "Tag Name";
        copyTitle = l10n.copyTagName;
        copyVisible = cmv.tag.copyName;
      } else {
        if (sourceElem.classList.contains("head")) {
          menu = [];
          if (this.gitBranchHead !== refName) {
            menu.push({
              title: l10n.checkoutBranch,
              icon: "arrowSwitch",
              visible: cmv.branch.checkout,
              onClick: () => this.checkoutBranchAction(refName, false)
            });
          }
          menu.push({
            title: l10n.renameBranch + ELLIPSIS,
            icon: "pencil",
            visible: cmv.branch.rename,
            onClick: () => this.renameBranchAction(refName)
          });
          if (this.remotes.length > 0) {
            menu.push({
              title: l10n.pushBranch + ELLIPSIS,
              icon: "repoPush",
              visible: cmv.branch.push,
              onClick: () => this.pushBranchAction(refName)
            });
          }
          menu.push({
            title: l10n.createArchive + ELLIPSIS,
            visible: cmv.branch.createArchive,
            onClick: () => {
              sendMessage({ command: "createArchive", repo: this.currentRepo!, ref: refName });
            }
          });
          if (this.gitBranchHead !== refName) {
            menu.push(
              {
                title: l10n.deleteBranch + ELLIPSIS,
                icon: "trash",
                visible: cmv.branch.delete,
                onClick: () => this.deleteBranchAction(refName)
              },
              {
                title: l10n.merge + ELLIPSIS,
                icon: "gitMerge",
                visible: cmv.branch.merge,
                onClick: () => this.mergeBranchAction(refName)
              },
              {
                title: l10n.rebaseOnBranch + ELLIPSIS,
                icon: "rebase",
                visible: cmv.branch.rebase,
                onClick: () => this.rebaseOnBranchAction(refName)
              },
              {
                title: l10n.fastForwardBranch,
                icon: "moveToEnd",
                visible: true,
                onClick: () => this.fastForwardBranchAction(refName)
              }
            );
          }
        } else {
          menu = [
            {
              title: l10n.checkoutBranch + ELLIPSIS,
              icon: "arrowSwitch",
              visible: cmv.remoteBranch.checkout,
              onClick: () => this.checkoutBranchAction(refName, true)
            },
            {
              title: l10n.merge + ELLIPSIS,
              icon: "gitMerge",
              visible: cmv.remoteBranch.merge,
              onClick: () => this.mergeBranchAction(refName)
            }
          ];
          // Remote branch refs are "<remote>/<branch>"; offer to delete the
          // branch on its remote (but not the symbolic "<remote>/HEAD" ref).
          if (splitRemoteRef(refName) !== null) {
            menu.push({
              title: l10n.pullIntoCurrentBranch + ELLIPSIS,
              icon: "repoPull",
              visible: cmv.remoteBranch.pull,
              onClick: () => this.pullRemoteBranchAction(refName)
            });
            menu.push({
              title: l10n.fetchIntoLocalBranch + ELLIPSIS,
              icon: "download",
              visible: cmv.remoteBranch.fetch,
              onClick: () => this.fetchIntoLocalBranchAction(refName, sourceElem)
            });
            menu.push({
              title: l10n.deleteRemoteBranch + ELLIPSIS,
              icon: "trash",
              visible: cmv.remoteBranch.delete,
              onClick: () => this.deleteRemoteBranchAction(refName)
            });
          }
        }
        // Offered on every branch — including the checked-out one and the
        // default branch itself — but not on the symbolic "<remote>/HEAD",
        // which is not a branch, matching the remote actions above.
        const remoteRef = sourceElem.classList.contains("remote");
        if (!remoteRef || splitRemoteRef(refName) !== null) {
          menu.push({
            title: l10n.checkRedundancy,
            visible: remoteRef ? cmv.remoteBranch.checkRedundancy : cmv.branch.checkRedundancy,
            onClick: () => requestBranchRedundancy(this.currentRepo!, refName)
          });
        }
        // Create a pull request from this branch on its remote.
        if (this.remotes.length > 0) {
          menu.push({
            title: l10n.createPullRequest + ELLIPSIS,
            icon: "gitPullRequest",
            onClick: () =>
              this.createPullRequestAction(refName, sourceElem.classList.contains("remote"))
          });
        }
        copyType = "Branch Name";
        copyTitle = l10n.copyBranchName;
        copyVisible = sourceElem.classList.contains("remote")
          ? cmv.remoteBranch.copyName
          : cmv.branch.copyName;
      }
      const issueUrl = firstIssueUrl(
        refName,
        this.config.issueLinkingRegex,
        this.config.issueLinkingUrl
      );
      if (issueUrl !== null) {
        menu.push({
          title: l10n.viewIssue,
          icon: "issue",
          onClick: () => sendMessage({ command: "openExternalUrl", url: issueUrl })
        });
      }
      menu.push(null, {
        title: copyTitle,
        visible: copyVisible,
        onClick: () => {
          sendMessage({ command: "copyToClipboard", type: copyType, data: refName });
        }
      });
      showContextMenu(<MouseEvent>e, menu, sourceElem);
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
  }
  private renderUncommitedChanges() {
    let date = getCommitDate(this.commits[0].date);
    document.getElementsByClassName("unsavedChanges")[0].innerHTML =
      "<td></td><td><b>" +
      escapeHtml(this.commits[0].message) +
      '</b></td><td title="' +
      date.title +
      '">' +
      date.value +
      '</td><td title="* <>">*</td><td title="*">*</td>';
  }
  private renderShowLoading() {
    hideDialogAndContextMenu();
    this.graph.clear();
    this.tableElem.innerHTML =
      '<h2 id="loadingHeader">' + svgIcons.loading + l10n.loading + "</h2>";
    this.footerElem.innerHTML = "";
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
              showConfirmationDialog(
                l10n.dialogCheckoutResetLocalConfirm.replace(
                  "{0}",
                  "<b><i>" + escapeHtml(leaf) + "</i></b>"
                ),
                () => {
                  showActionRunningDialog(l10n.checkoutBranch);
                  sendMessage({
                    command: "checkoutBranch",
                    repo: this.currentRepo!,
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
          this.sendDeleteBranch(refName, values[0] === "checked", values[1] === "checked");
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
          this.sendDeleteBranch(refName, forceDelete, false);
        },
        null,
        "deleteBranch"
      );
    }
  }
  private rebaseOnBranchAction(refName: string) {
    showConfirmationDialog(
      l10n.dialogRebaseConfirm
        .replace("{0}", "<b><i>" + escapeHtml(refName) + "</i></b>")
        .replace("{1}", this.currentBranchLabel()),
      () => {
        sendMessage({ command: "rebaseOn", repo: this.currentRepo!, obj: refName });
        showActionRunningDialog(l10n.rebasing);
      },
      null
    );
  }
  private fastForwardBranchAction(refName: string) {
    showConfirmationDialog(
      l10n.dialogFastForwardConfirm.replace("{0}", "<b><i>" + escapeHtml(refName) + "</i></b>"),
      () => {
        sendMessage({
          command: "fastForwardBranch",
          repo: this.currentRepo!,
          branchName: refName
        });
      },
      null
    );
  }
  private pullRemoteBranchAction(refName: string) {
    const parts = splitRemoteRef(refName);
    if (parts === null) return;
    showConfirmationDialog(
      l10n.dialogPullConfirm
        .replace("{0}", "<b><i>" + escapeHtml(refName) + "</i></b>")
        .replace("{1}", this.currentBranchLabel()),
      () => {
        sendMessage({
          command: "pullBranch",
          repo: this.currentRepo!,
          remote: parts.remote,
          branchName: parts.branchOnRemote
        });
        showActionRunningDialog(l10n.pulling);
      },
      null
    );
  }
  private fetchIntoLocalBranchAction(refName: string, sourceElem: HTMLElement | null = null) {
    const parts = splitRemoteRef(refName);
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
    const parts = splitRemoteRef(refName);
    if (parts === null) return;
    showConfirmationDialog(
      l10n.dialogDeleteRemoteBranchConfirm.replace(
        "{0}",
        "<b><i>" + escapeHtml(refName) + "</i></b>"
      ),
      () => {
        sendMessage({
          command: "deleteRemoteBranch",
          repo: this.currentRepo!,
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
  /** Run the pending delegated action once this view shows its repo with no
   *  load in flight (a fresh panel / repo switch reloads branches+commits; the
   *  remotes for that repo arrive before them, as requests are handled in
   *  order). Re-tried after each load completes. */
  private tryRunPendingRefAction() {
    const pending = this.pendingRefAction;
    if (pending === null || pending.repo !== this.currentRepo) return;
    if (this.loadBranchesCallback !== null || this.loadCommitsCallback !== null) return;
    this.pendingRefAction = null;
    this.lastRefActionSeq = pending.seq;
    if (pending.command === "runRefBatchAction") this.dispatchRefBatchAction(pending);
    else this.dispatchRefAction(pending);
  }
  private dispatchRefAction(msg: GG.ResponseRunRefAction) {
    const ref = msg.ref;
    // The one action that reads the same on both sides: it inspects the branch
    // rather than acting on it, so neither the remote split nor the head guards
    // below apply.
    if (msg.action === "checkRedundancy") {
      requestBranchRedundancy(msg.repo, ref);
      return;
    }
    if (msg.isRemote) {
      switch (msg.action) {
        case "checkout":
          this.checkoutBranchAction(ref, true);
          break;
        case "merge":
          this.mergeBranchAction(ref);
          break;
        case "pull":
          this.pullRemoteBranchAction(ref);
          break;
        case "fetchIntoLocal":
          this.fetchIntoLocalBranchAction(ref);
          break;
        case "deleteRemote":
          this.deleteRemoteBranchAction(ref);
          break;
        case "createPullRequest":
          if (this.remotes.length > 0) this.createPullRequestAction(ref, true);
          break;
      }
    } else {
      // Mirror the in-graph menu's guards: these never apply to the checked-out
      // branch (the menu wouldn't have offered them).
      if (
        ref === this.gitBranchHead &&
        (msg.action === "checkout" ||
          msg.action === "delete" ||
          msg.action === "merge" ||
          msg.action === "rebase" ||
          msg.action === "fastForward")
      ) {
        return;
      }
      switch (msg.action) {
        case "checkout":
          this.checkoutBranchAction(ref, false);
          break;
        case "rename":
          this.renameBranchAction(ref);
          break;
        case "delete":
          this.deleteBranchAction(ref);
          break;
        case "merge":
          this.mergeBranchAction(ref);
          break;
        case "rebase":
          this.rebaseOnBranchAction(ref);
          break;
        case "fastForward":
          this.fastForwardBranchAction(ref);
          break;
        case "push":
          if (this.remotes.length > 0) this.pushBranchAction(ref);
          break;
        case "createArchive":
          sendMessage({ command: "createArchive", repo: this.currentRepo!, ref });
          break;
        case "createPullRequest":
          if (this.remotes.length > 0) this.createPullRequestAction(ref, false);
          break;
      }
    }
  }
  /** Run a batch action delegated by the Branches side-view. The dialogs are
   *  written for the batch rather than replaying a single-branch dialog N times:
   *  one confirmation for the whole set, and — for delete — one force round at
   *  the end instead of a prompt per branch (ADR-0009). */
  private dispatchRefBatchAction(msg: GG.ResponseRunRefBatchAction) {
    // The host reports an empty target set itself, and never sends one.
    if (msg.targets.length === 0) return;
    switch (msg.action) {
      case "delete":
        this.deleteBranchesAction(msg.targets, msg.skipped);
        break;
      case "push":
        if (this.remotes.length > 0) this.pushBranchesAction(msg.targets, msg.skipped);
        break;
      case "fastForward":
        this.fastForwardBranchesAction(msg.targets, msg.skipped);
        break;
    }
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
            const p = params as { forceDelete: boolean; deleteOnRemotes: boolean };
            sendMessage({
              command: "deleteBranches",
              repo: this.currentRepo!,
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
            const p = params as {
              remotes: string[];
              forceMode: "normal" | "force" | "forceWithLease";
            };
            sendMessage({
              command: "pushBranches",
              repo: this.currentRepo!,
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
          send: (refs) => {
            sendMessage({
              command: "fastForwardBranches",
              repo: this.currentRepo!,
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
   *  never drift apart. */
  private startBatchRun(
    action: BatchActionKind,
    targets: string[],
    options: Omit<BatchRunOptions, "action"> = {}
  ) {
    this.runBatchCommand(this.batchRun.start(targets, { ...options, action }), action);
  }
  /** Execute one BatchRun command, re-entering as the retry dialog resolves.
   *  All round state lives in the run; this only performs its side effects. */
  private runBatchCommand(command: BatchRunCommand, action: BatchActionKind) {
    const spec = this.batchSpec(action);
    switch (command.kind) {
      case "send":
        spec.send(command.refs, command.round, command.params);
        showActionRunningDialog(spec.running);
        break;
      case "offerRetry":
        showConfirmationDialog(
          spec.retryBody?.(command.refs) ?? "",
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
        this.startBatchRun("deleteBranches", targets, {
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
        this.startBatchRun("pushBranches", targets, { params: { remotes, forceMode } });
      }
    );
  }
  private fastForwardBranchesAction(targets: string[], skipped: GG.BatchSkipped[]) {
    showConfirmationDialog(
      this.batchConfirmBody(l10n.dialogFastForwardBatchConfirm, targets, skipped),
      () => this.startBatchRun("fastForwardBranches", targets),
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
    return this.gitBranchHead !== null
      ? "<b><i>" + escapeHtml(this.gitBranchHead) + "</i></b>"
      : "<b>" + l10n.labelCurrentBranch + "</b>";
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
    const push = (remotes: string[]) => {
      if (remotes.length === 0) return;
      sendMessage({ command: "pushTag", repo: this.currentRepo!, tagName, remotes });
      showActionRunningDialog(l10n.pushingTag);
    };
    const chooseRemoteAndPush = () => {
      if (this.remotes.length === 1) {
        showConfirmationDialog(
          l10n.dialogPushTagConfirm.replace("{0}", "<b><i>" + escapeHtml(tagName) + "</i></b>"),
          () => push([this.remotes[0]]),
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
          (values) => push(this.remotes.filter((_, i) => values[i] === "checked")),
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
  private makeTableResizable() {
    let colHeadersElem = document.getElementById("tableColHeaders")!,
      cols = <HTMLCollectionOf<HTMLElement>>document.getElementsByClassName("tableColHeader");
    let columnWidths = this.gitRepos[this.currentRepo].columnWidths,
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
      if (col > -1 && columnWidths !== null) {
        col = -1;
        mouseX = -1;
        colHeadersElem.classList.remove("resizing");
        this.gitRepos[this.currentRepo].columnWidths = columnWidths;
        sendMessage({
          command: "saveRepoState",
          repo: this.currentRepo,
          state: this.gitRepos[this.currentRepo]
        });
      }
    };

    for (let i = 0; i < cols.length; i++) {
      cols[i].innerHTML +=
        (i > 0 ? '<span class="resizeCol left" data-col="' + (i - 1) + '"></span>' : "") +
        (i < cols.length - 1 ? '<span class="resizeCol right" data-col="' + i + '"></span>' : "");
    }
    if (columnWidths !== null) {
      makeTableFixedLayout();
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
      cols[0].style.padding =
        "0 " + Math.round((Math.max(graphWidth, 64) - (cols[0].offsetWidth - 24)) / 2) + "px";
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
      if (
        this.config.loadMoreAutomatically &&
        this.moreCommitsAvailable &&
        window.innerHeight + window.scrollY >= document.body.offsetHeight - 250
      ) {
        this.loadMoreCommits();
      }
    });
  }
  /** Load the next page of commits. Guarded so concurrent scroll events (or a
   *  click during a pending load) don't stack multiple requests. */
  private loadMoreCommits() {
    if (this.loadingMore) return;
    this.loadingMore = true;
    const btn = document.getElementById("loadMoreCommitsBtn");
    if (btn !== null) {
      (<HTMLElement>btn.parentNode!).innerHTML =
        '<h2 id="loadingHeader">' + svgIcons.loading + l10n.loading + "</h2>";
    }
    this.maxCommits += this.config.loadMoreCommits;
    this.hideCommitDetails();
    this.saveState();
    this.requestLoadCommits(true, () => {
      this.loadingMore = false;
    });
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

  /** Close the comparison and fall back to the expanded commit's own details
   * . `loadCommitDetails` resets the expanded-commit state (and clears the
   *  compared row's highlight via `hideCommitDetails`) before re-requesting. */
  private hideCommitComparison() {
    if (this.expandedCommit === null || this.expandedCommit.srcElem === null) return;
    this.loadCommitDetails(this.expandedCommit.srcElem);
  }

  /** Open the Commit Details View for the commit `delta` rows away from the one
   *  currently expanded (e.g. -1 for the row above, +1 below). Returns true only
   *  when navigation actually occurred, so the caller consumes the key press
   *  exactly then (and lets it scroll the page otherwise). */
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
  }
  public hideFind() {
    this.findActive = false;
    document.getElementById("findWidget")?.classList.remove("active");
    // Return focus to the document so keyboard shortcuts work again.
    (<HTMLElement | null>document.getElementById("findInput"))?.blur();
    this.findMatches = [];
    this.findCurrent = -1;
    this.clearFindHighlights();
  }
  private runFind(query: string) {
    this.findMatches =
      query === ""
        ? []
        : this.commits
            .filter((c) => c.hash !== "*" && commitMatchesQuery(c, query))
            .map((c) => c.hash);
    this.findCurrent = this.findMatches.length > 0 ? 0 : -1;
    this.applyFindHighlights(true);
  }
  private findStep(delta: number) {
    if (this.findMatches.length === 0) return;
    const n = this.findMatches.length;
    this.findCurrent = (this.findCurrent + delta + n) % n;
    this.applyFindHighlights(true);
  }
  private clearFindHighlights() {
    const rows = document.querySelectorAll(".commit.findMatch, .commit.findMatchCurrent");
    rows.forEach((el) => el.classList.remove("findMatch", "findMatchCurrent"));
  }
  /** Re-apply find styling to the current DOM. Pass scroll=true to bring the
   *  current match into view (e.g. on a new search or step, not on re-render). */
  private applyFindHighlights(scroll: boolean) {
    this.clearFindHighlights();
    for (const hash of this.findMatches) {
      document.querySelector('tr.commit[data-hash="' + hash + '"]')?.classList.add("findMatch");
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
      const currentRow = document.querySelector<HTMLElement>(
        'tr.commit[data-hash="' + this.findMatches[this.findCurrent] + '"]'
      );
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
            this.expandedCommit.hash !== this.findMatches[this.findCurrent])
        ) {
          this.loadCommitDetails(currentRow);
        }
      }
    }
  }
  /** Scroll the view to centre the commit referenced by HEAD, optionally blinking it. */
  public scrollToHead(blink = true) {
    if (this.commitHead === null) return;
    const row = document.querySelector<HTMLElement>(
      'tr.commit[data-hash="' + this.commitHead + '"]'
    );
    if (row !== null && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "center" });
    }
    if (blink) blinkHeadRow(this.commitHead);
  }
  /** Cycle the view to the next (or previous) stash on the graph, centring and
   *  blinking it. No-op when no stashes are shown. */
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
    const row = document.querySelector<HTMLElement>('tr.commit[data-hash="' + hash + '"]');
    if (row !== null && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "center" });
    }
    blinkHeadRow(hash);
  }
  public commitDetailsNavigate(delta: number): boolean {
    if (this.expandedCommit === null || this.expandedCommit.srcElem === null) return false;
    const newId = this.expandedCommit.id + delta;
    if (newId >= 0 && newId < this.commits.length) {
      const elem = document.querySelector('.commit[data-id="' + newId + '"]');
      if (elem !== null) {
        this.loadCommitDetails(<HTMLElement>elem);
        return true;
      }
    }
    return false;
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
    const elem = document.querySelector('.commit[data-id="' + this.commitLookup[targetHash] + '"]');
    if (elem === null) return false;
    this.loadCommitDetails(<HTMLElement>elem);
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
    if (summary === null || files === null || divider === null || heightGrip === null) return;

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
          state: this.gitRepos[this.currentRepo]
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

    if (!docked) {
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
    addListenerToClass("cdvFileViewBtn", "click", (e) => {
      const btn = <HTMLElement>(<Element>e.target).closest(".cdvFileViewBtn")!;
      this.setFileViewType(<GG.FileViewType>btn.dataset.viewtype);
    });
    this.attachCdvFileListeners();
    addListenerToClass("commitBodyHash", "click", (e) => {
      let sourceElem = <HTMLElement>(<Element>e.target).closest(".commitBodyHash")!;
      let row = document.querySelector<HTMLElement>(
        'tr.commit[data-hash="' + sourceElem.dataset.hash + '"]'
      );
      if (row !== null) {
        if (typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "center" });
        this.loadCommitDetails(row);
      }
    });
    addListenerToClass("commitBodyLink", "contextmenu", (e: Event) => {
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

  /** Wire up the file rows of the Commit Details View file tree/list. Called on
   *  each render of the panel and again whenever the file section is re-rendered
   *  by the tree/list layout toggle (the old rows are replaced wholesale). */
  private attachCdvFileListeners() {
    addListenerToClass("gitFolder", "click", (e) => {
      let sourceElem = <HTMLElement>(<Element>e.target!).closest(".gitFolder");
      let parent = sourceElem.parentElement!;
      parent.classList.toggle("closed");
      let isOpen = !parent.classList.contains("closed");
      parent.children[0].children[0].innerHTML = isOpen
        ? svgIcons.openFolder
        : svgIcons.closedFolder;
      parent.children[1].classList.toggle("hidden");
      alterGitFileTree(
        this.expandedCommit!.fileTree!,
        decodeURIComponent(sourceElem.dataset.folderpath!),
        isOpen
      );
      this.saveState();
    });
    addListenerToClass("gitFile", "click", (e) => {
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
    addListenerToClass("gitFileCopyPath", "click", (e) => {
      e.stopPropagation(); // don't also trigger the file's view-diff click
      let sourceElem = <HTMLElement>(<Element>e.target).closest(".gitFileCopyPath")!;
      sendMessage({
        command: "copyToClipboard",
        type: "File Path",
        data: decodeURIComponent(sourceElem.dataset.filepath!)
      });
    });
    addListenerToClass("gitFile", "contextmenu", (e: Event) => {
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
            showConfirmationDialog(
              l10n.dialogResetFileConfirm
                .replace("{0}", "<b><i>" + escapeHtml(filePath) + "</i></b>")
                .replace("{1}", "<b><i>" + abbrevCommit(commitHash) + "</i></b>"),
              () => {
                sendMessage({
                  command: "resetFileToRevision",
                  repo: this.currentRepo!,
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
    addListenerToClass("gitFileOpen", "click", (e) => {
      e.stopPropagation(); // don't also trigger the file's view-diff click
      let sourceElem = <HTMLElement>(<Element>e.target).closest(".gitFileOpen")!;
      sendMessage({
        command: "openFile",
        repo: this.currentRepo!,
        filePath: decodeURIComponent(sourceElem.dataset.filepath!),
        commitHash: this.cdvHash
      });
    });
    addListenerToClass("gitFileViewRev", "click", (e) => {
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
    addListenerToClass("gitFileDiffWorking", "click", (e) => {
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
   *  commit's files read the same wherever they are shown; the dialog's copy is
   *  inert, since the diff actions are bound to the graph's expanded row. */
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
    this.gitRepos[this.currentRepo].fileViewType = fileViewType;
    this.saveState();
    sendMessage({
      command: "saveRepoState",
      repo: this.currentRepo,
      state: this.gitRepos[this.currentRepo]
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
  contextMenuSource: HTMLElement | null = null;
let dialog = document.getElementById("dialog")!,
  dialogBacking = document.getElementById("dialogBacking")!,
  dialogMenuSource: HTMLElement | null = null;
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
    loadMoreCommits: viewState.loadMoreCommits,
    markdown: viewState.markdown,
    muteCommitsNotAncestorsOfHead: viewState.muteCommitsNotAncestorsOfHead,
    muteMergeCommits: viewState.muteMergeCommits,
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
        msg.dimmedBranches ?? []
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
    case "runRefAction":
      gitGraph.runRefAction(msg);
      break;
    case "runRefBatchAction":
      gitGraph.runRefBatchAction(msg);
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
});
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

/* Context Menu */
function showContextMenu(e: MouseEvent, rawItems: ContextMenuElement[], sourceElem: HTMLElement) {
  // Drop items hidden via contextMenuActionsVisibility, then collapse any
  // dividers left leading, trailing, or doubled-up by the removals.
  const items = rawItems
    .filter((it) => it === null || it.visible !== false)
    .filter((it, idx, arr) => !(it === null && (idx === 0 || arr[idx - 1] === null)))
    .filter((it, idx, arr) => !(it === null && idx === arr.length - 1));
  let html = "",
    i: number,
    event = <MouseEvent>e;
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
  // Prefer opening down/right of the cursor, flipping up/left when that side
  // would overflow the viewport.
  let left =
    event.pageX - window.pageXOffset + bounds.width < window.innerWidth
      ? event.pageX - 2
      : event.pageX - bounds.width + 2;
  let top =
    event.pageY - window.pageYOffset + bounds.height < window.innerHeight
      ? event.pageY - 2
      : event.pageY - bounds.height + 2;
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
  // Focusable only while its menu is open, so closing can hand focus back
  // instead of dropping it on the body. The commit table itself stays outside
  // the tab order — see docs/adr/0007.
  contextMenuSource.tabIndex = -1;
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
    contextMenuSource.removeAttribute("tabindex");
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
function showActionRunningDialog(command: string) {
  showDialog(
    '<span id="actionRunning">' + svgIcons.loading + command + " ...</span>",
    null,
    l10n.dialogDismiss,
    null,
    null
  );
}
function showDialog(
  html: string,
  actionName: string | null,
  dismissName: string,
  actioned: (() => void) | null,
  sourceElem: HTMLElement | null,
  onDismiss?: () => void
) {
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
  document.getElementById("dialogDismiss")!.addEventListener(
    "click",
    onDismiss === undefined
      ? hideDialog
      : () => {
          hideDialog();
          onDismiss();
        }
  );

  dialogMenuSource = sourceElem;
  if (dialogMenuSource !== null) dialogMenuSource.classList.add("dialogActive");
}
function hideDialog() {
  dialogBacking.className = "";
  dialog.className = "";
  dialog.innerHTML = "";
  if (dialogMenuSource !== null) {
    dialogMenuSource.classList.remove("dialogActive");
    dialogMenuSource = null;
  }
}

function hideDialogAndContextMenu() {
  if (dialog.classList.contains("active")) hideDialog();
  if (contextMenu.classList.contains("active")) hideContextMenu();
}

/* Global Listeners */
document.addEventListener("keyup", (e) => {
  if (e.key === "Escape") {
    hideDialogAndContextMenu();
  }
});
// Pixels scrolled per Up/Down key press when no Commit Details View is open.
const ARROW_SCROLL_STEP = 48;
document.addEventListener("keydown", (e) => {
  if (dialog.classList.contains("active")) {
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
  } else if (e.key === "ArrowUp") {
    // With a commit expanded, navigate commits; otherwise scroll the view.
    if (gitGraph.commitDetailsNavigate(-1)) e.preventDefault();
    else {
      window.scrollBy(0, -ARROW_SCROLL_STEP);
      e.preventDefault();
    }
  } else if (e.key === "ArrowDown") {
    if (gitGraph.commitDetailsNavigate(1)) e.preventDefault();
    else {
      window.scrollBy(0, ARROW_SCROLL_STEP);
      e.preventDefault();
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
