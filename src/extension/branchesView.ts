import * as vscode from "vscode";

import { displayRef, REMOTE_PREFIX } from "@/backend/utils/branchRef";
import * as l10n from "@/l10n";
import type { BatchAction, BatchSkipped } from "@/types";

import { resolveActionTargets } from "./branchActionTargets";
import { relativeAge } from "./branchActivity";
import { resolveCleanupCandidates } from "./branchCleanup";
import { type BranchFacts } from "./branchFacts";
import { BranchFilterStore } from "./branchFilterStore";
import {
  createBranchSelectionReconciler,
  createDirectFilterWriter
} from "./branchSelectionReconciler";
import {
  branchSelectionOf,
  type BranchTreeLeaf,
  type BranchTreeNode,
  buildGroupedBranchRoots
} from "./branchTree";

/** Scheme of the opaque per-branch URIs carrying a leaf's decoration flags, so
 *  the FileDecorationProvider below can dim it and/or badge it. */
const BRANCH_SCHEME = "gga-branch";

/** Authority flag characters. The two states are independent — a merged branch
 *  exempt from hiding is badged but not dimmed (ADR-0003) — so they're encoded
 *  as a set rather than an enum. */
const FLAG_DIMMED = "d";
const FLAG_MERGED = "m";

/** An opaque URI carrying the branch ref plus its decoration flags. The ref is
 *  only there to keep the URI unique per leaf; the provider reads the flags. */
function branchDecorationUri(ref: string, flags: { dimmed: boolean; merged: boolean }): vscode.Uri {
  return vscode.Uri.from({
    scheme: BRANCH_SCHEME,
    authority: (flags.dimmed ? FLAG_DIMMED : "") + (flags.merged ? FLAG_MERGED : ""),
    path: "/" + encodeURIComponent(ref)
  });
}

/** A TreeItem backed by one node of the branch tree. Carries the node and its
 *  repo so commands invoked from the context menu have everything they need. */
class BranchItem extends vscode.TreeItem {
  constructor(
    public readonly node: BranchTreeNode,
    public readonly repo: string,
    selectionGen: number,
    folderGen: number,
    defaultBranch: string | null
  ) {
    super(
      node.type === "group" ? l10n.t("branchView.group." + node.kind) : node.name,
      node.type === "group"
        ? vscode.TreeItemCollapsibleState.Expanded
        : node.type === "folder"
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None
    );
    if (node.type === "group") {
      // A stable id keeps the user's collapse choice across refreshes — the
      // Collapse button leaves group headings alone (it only bumps folderGen).
      this.id = repo + "::group::" + node.kind;
      this.contextValue = "branch-group";
    } else if (node.type === "folder") {
      // Within a folder generation the id is stable, keeping expansion across
      // refreshes (and across the "Show All" selection reset, which only
      // re-keys leaves). The Collapse button bumps the generation: every folder
      // re-renders under a fresh id, falling back to Collapsed.
      this.id = repo + "::folder::" + folderGen + "::" + node.path;
      this.contextValue = "branch-folder";
      this.iconPath = vscode.ThemeIcon.Folder;
    } else {
      // The selection generation is part of the leaf id so "Show All" can clear
      // the visual selection by bumping it: VSCode drops the selection of ids
      // that no longer exist. Within a generation the id is stable, so a normal
      // refresh (after a git op) preserves the selection.
      this.id = "branch::" + selectionGen + "::" + repo + "::" + node.branch;
      // The kind, plus a `-candidate` suffix when the cleanup dialog would
      // propose this branch — the one thing the menus need per row that no
      // global context key can express. Every `when` clause matching a branch
      // leaf therefore accepts both spellings.
      this.contextValue =
        (node.isRemote ? "branch-remote" : node.isHead ? "branch-current" : "branch-local") +
        (node.isCleanupCandidate ? "-candidate" : "");
      this.iconPath = new vscode.ThemeIcon(
        node.isHead ? "check" : node.isRemote ? "cloud" : "git-branch"
      );
      // The description carries the facts that read as words. Both can apply at
      // once now that the age is no longer gated on the branch being hideable —
      // a long-idle checked-out branch reads "current · 3mo".
      const description: string[] = [];
      if (node.isHead) description.push(l10n.t("branchView.current"));
      if (node.isInactive && node.lastActivitySec !== undefined) {
        const age = relativeAge(node.lastActivitySec, Math.floor(Date.now() / 1000));
        description.push(l10n.t("branchView.age." + age.unit, age.value));
      }
      if (description.length > 0) this.description = description.join(" · ");
      this.tooltip =
        node.isMerged && defaultBranch !== null
          ? node.branch + "\n" + l10n.t("branchView.mergedInto", displayRef(defaultBranch))
          : node.branch;
      // Dimming (hidable) and the merged badge both arrive through the
      // FileDecorationProvider, keyed on the flags in this URI. They're
      // independent: an exempt merged branch is badged but not dimmed. A leaf
      // with neither gets no resourceUri at all.
      if (node.isHidable || node.isMerged) {
        this.resourceUri = branchDecorationUri(node.branch, {
          dimmed: node.isHidable,
          merged: node.isMerged
        });
      }
      // No `command`: a left click selects (and filters); git operations are on
      // the right-click context menu.
    }
  }
}

/** Shared dependencies of the side-view: the classification facts (shared with
 *  the graph, so the two can't disagree — ADR-0013) and the two hide toggles,
 *  re-read on every reload so title-bar toggles take effect immediately. */
type BranchesProviderDeps = {
  branchFacts: BranchFacts;
  /** Where the tree's selection is written. Reading it back for the exemptions
   *  is `BranchFacts`' job, not this view's — that split is what closed the
   *  window where the two surfaces saw different filters. */
  filterStore: BranchFilterStore;
  /** The "show remote branches" state for a repo (per-repo override or the
   *  global default). Only the title toggle's icon state is read here — which
   *  refs the read covers is `BranchFacts`' business. */
  resolveShowRemote: (repo: string) => boolean;
  /** The "show inactive branches" state for a repo (per-repo override or the
   *  global default). */
  resolveShowInactive: (repo: string) => boolean;
  /** The "show merged branches" state for a repo (per-repo override or the
   *  global default). Independent of the inactive toggle — a branch hidden by
   *  either rule is gone regardless of the other (ADR-0004). */
  resolveShowMerged: (repo: string) => boolean;
  /** "Always show" name/glob patterns. Needed here only to mark which leaves the
   *  cleanup dialog would propose, so the menu item can appear on those rows. */
  resolveExemptPatterns: () => string[];
};

class BranchesProvider implements vscode.TreeDataProvider<BranchItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<BranchItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private roots: BranchTreeNode[] = [];
  private repo: string | null = null;
  // The default branch the current roots' merged flags were computed against,
  // for the badge tooltip. Null when it couldn't be resolved (merged marking is
  // then disabled entirely).
  private defaultBranch: string | null = null;
  // Guards against an in-flight fetch being overwritten by a slower earlier one.
  private fetchId = 0;
  // Bumped by "Show All" to re-key leaf items and so clear the visual selection.
  private selectionGen = 0;
  // Bumped by the Collapse button to re-key folder items: fresh ids fall back
  // to Collapsed while the group headings (stable ids) stay expanded.
  private folderGen = 0;

  constructor(private readonly deps: BranchesProviderDeps) {}

  getRepo(): string | null {
    return this.repo;
  }

  /** The tree as currently built, for deriving a batch action's targets (which
   *  needs the tree order, not the selection array's). */
  getRoots(): readonly BranchTreeNode[] {
    return this.roots;
  }

  setRepo(repo: string | null): void {
    if (repo === this.repo) return;
    this.repo = repo;
    this.roots = [];
    void this.reload();
  }

  /** Rebuild the tree. `hard` forces a real git read rather than one served
   *  from the shared read's coalescing window — for the user's own Refresh, not
   *  for the reloads that follow a toggle or a setting change. */
  refresh(opts?: { hard?: boolean }): void {
    void this.reload(opts?.hard === true);
  }

  private async reload(hard = false): Promise<void> {
    const id = ++this.fetchId;
    const repo = this.repo;
    const showInactive = repo !== null && this.deps.resolveShowInactive(repo);
    const showMerged = repo !== null && this.deps.resolveShowMerged(repo);
    // Keep the title toggles' icons in sync with the active repo's state.
    void vscode.commands.executeCommand(
      "setContext",
      "ging-git-view.branchView.showingRemote",
      repo !== null && this.deps.resolveShowRemote(repo)
    );
    void vscode.commands.executeCommand(
      "setContext",
      "ging-git-view.branchView.showingInactive",
      showInactive
    );
    void vscode.commands.executeCommand(
      "setContext",
      "ging-git-view.branchView.showingMerged",
      showMerged
    );
    if (repo === null) {
      this.roots = [];
      this.defaultBranch = null;
      this._onDidChangeTreeData.fire();
      return;
    }
    try {
      // One shared read: the graph's `loadBranches` consumes the same facts, so
      // neither surface can reach a different verdict about a branch.
      const facts = await this.deps.branchFacts.facts(repo, { hard });
      if (id !== this.fetchId) return; // superseded by a newer fetch
      this.defaultBranch = facts.defaultBranch;
      if (!facts.isRepo) {
        this.roots = [];
      } else {
        // Both rules yield a fact set and the hidable subset it implies. The
        // facts drive the markings (age label, merged badge) and apply even to
        // exempt branches; only the hidable sets are dimmed and dropped.
        //
        // Hiding is a union across the two toggles: a branch removed by either
        // rule is gone whatever the other says. Dimming covers the whole hidable
        // union, so the grey on a surviving branch always means "some toggle
        // would remove this". The toggles stay here rather than in BranchFacts:
        // they decide presentation, and the graph hides nothing at all.
        const hidden = new Set<string>();
        if (!showInactive) for (const branch of facts.inactive.hidable) hidden.add(branch);
        if (!showMerged) for (const branch of facts.merged.hidable) hidden.add(branch);
        // Candidacy is resolved from the same facts, but it is not `hidable`:
        // the exemptions differ by the branch filter, so a leaf can be a
        // candidate without being dimmed (ADR-0017). It changes nothing about
        // how a row looks — only whether it offers the cleanup menu item.
        const cleanupCandidates = new Set(
          resolveCleanupCandidates({
            branches: facts.branches,
            head: facts.head,
            defaultBranch: facts.defaultBranch,
            dates: facts.dates,
            merged: facts.merged,
            inactive: facts.inactive,
            patterns: this.deps.resolveExemptPatterns()
          }).candidates.map((c) => c.ref)
        );
        this.roots = buildGroupedBranchRoots(
          hidden.size === 0 ? facts.branches : facts.branches.filter((b) => !hidden.has(b)),
          facts.head,
          {
            merged: facts.merged.matched,
            inactive: facts.inactive.matched,
            hidable: facts.hidable,
            cleanupCandidates,
            dates: facts.dates
          }
        );
      }
    } catch {
      if (id !== this.fetchId) return;
      this.roots = [];
      this.defaultBranch = null;
    }
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: BranchItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: BranchItem): BranchItem[] {
    if (this.repo === null) return [];
    const nodes =
      element === undefined
        ? this.roots
        : element.node.type === "folder" || element.node.type === "group"
          ? element.node.children
          : [];
    return nodes.map(
      (node) =>
        new BranchItem(node, this.repo!, this.selectionGen, this.folderGen, this.defaultBranch)
    );
  }

  /** Required by `treeView.reveal`: the chain is rebuilt by walking the current
   *  roots for the element's node (nodes are compared structurally because
   *  BranchItems are constructed fresh on every getChildren call). */
  getParent(element: BranchItem): BranchItem | undefined {
    if (this.repo === null) return undefined;
    const chain = findNodeChain(this.roots, element.node);
    if (chain === null || chain.length < 2) return undefined;
    return new BranchItem(
      chain[chain.length - 2],
      this.repo,
      this.selectionGen,
      this.folderGen,
      this.defaultBranch
    );
  }

  /** Wrap the leaf for `ref` (if currently in the tree) so it can be revealed. */
  findLeafItem(ref: string): BranchItem | null {
    if (this.repo === null) return null;
    const chain = findNodeChain(this.roots, (n) => n.type === "leaf" && n.branch === ref);
    return chain === null
      ? null
      : new BranchItem(
          chain[chain.length - 1],
          this.repo,
          this.selectionGen,
          this.folderGen,
          this.defaultBranch
        );
  }

  /** All leaf refs currently in the tree (depth-first), for the search picker.
   *  Reflects what the view shows: hidden remotes, and branches removed by
   *  either hide toggle, are excluded. */
  visibleLeaves(): BranchTreeLeaf[] {
    const out: BranchTreeLeaf[] = [];
    const walk = (nodes: BranchTreeNode[]) => {
      for (const n of nodes) {
        if (n.type === "leaf") out.push(n);
        else walk(n.children);
      }
    };
    walk(this.roots);
    return out;
  }

  /** Clear the visual selection by re-keying leaf items (VSCode drops selection
   *  of ids that no longer exist); folder expansion is preserved. */
  clearSelection(): void {
    this.selectionGen++;
    this._onDidChangeTreeData.fire();
  }

  /** Collapse every folder while keeping the Remote/Local group headings
   *  expanded, by re-keying the folders (fresh ids default to Collapsed; the
   *  groups' stable ids keep their state). Replaces the native Collapse All,
   *  which would fold the headings too. */
  collapseFolders(): void {
    this.folderGen++;
    this._onDidChangeTreeData.fire();
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

/** Whether two nodes denote the same tree entry. Structural (not identity)
 *  because the view may hold nodes from an earlier `roots` build. */
function sameNode(a: BranchTreeNode, b: BranchTreeNode): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "leaf") return a.branch === (b as BranchTreeLeaf).branch;
  if (a.type === "folder") return a.path === (b as { path: string }).path;
  return a.kind === (b as { kind: string }).kind;
}

/** Depth-first search for `target` (a node, or a predicate); returns the chain
 *  of nodes from a root down to the match inclusive, or null when absent. */
function findNodeChain(
  roots: BranchTreeNode[],
  target: BranchTreeNode | ((n: BranchTreeNode) => boolean)
): BranchTreeNode[] | null {
  const matches =
    typeof target === "function" ? target : (n: BranchTreeNode) => sameNode(n, target);
  const walk = (nodes: BranchTreeNode[], trail: BranchTreeNode[]): BranchTreeNode[] | null => {
    for (const n of nodes) {
      if (matches(n)) return [...trail, n];
      if (n.type !== "leaf") {
        const found = walk(n.children, [...trail, n]);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return walk(roots, []);
}

/** The branch selection a TreeView selection denotes. The rule (folders and
 *  group headings denote nothing) lives in `branchTree.ts` so it can be
 *  unit-tested; this is only the unwrapping of the TreeItems. */
function selectedBranchRefs(items: BranchItem[]): string[] {
  return branchSelectionOf(items.map((i) => i.node));
}

/** A batch context-menu command's action targets, as refs rather than tree
 *  nodes — the form both the graph webview and the clipboard need. */
export type BranchActionTargets = {
  repo: string;
  /** Branch-list-format refs, in tree order. */
  targets: string[];
  skipped: BatchSkipped[];
};

/** The branch a context-menu command operates on. */
export type BranchActionTarget = {
  repo: string;
  branch: string;
  isRemote: boolean;
  isCurrent: boolean;
};

/** Resolve the action target from a context-menu command argument (the clicked
 *  tree item), or null when it isn't a branch leaf (e.g. a folder). */
export function branchActionTarget(item: unknown): BranchActionTarget | null {
  if (item instanceof BranchItem && item.node.type === "leaf") {
    return {
      repo: item.repo,
      branch: item.node.branch,
      isRemote: item.node.isRemote,
      isCurrent: item.node.isHead
    };
  }
  return null;
}

export type BranchesView = ReturnType<typeof createBranchesView>;

/**
 * Create and wire the Branches side-view: a native multi-select TreeView whose
 * selection drives the per-repo branch filter (empty selection = show all). The
 * view follows whichever repo is active and re-reads its branches on demand.
 *
 * The tree's selection and the filter are only **weakly** synchronised: a
 * non-empty selection always equals the filter, but a non-empty filter may have
 * no selection behind it (the multi-pick search, a config-seeded opening filter,
 * a filter restored after a repo switch). That is deliberate, not a gap to
 * close: `TreeView.selection` is readonly and `reveal` selects a single element,
 * so there is no way to put a multi-branch filter back onto the tree. Making it
 * symmetrical means moving the input to `TreeItem.checkboxState`, which is
 * programmatically settable — at the cost of the click-a-row-to-filter gesture,
 * a permanent checkbox on every row, and a highlight that no longer means
 * anything. The graph's filter chip therefore reports the *filter*, never the
 * selection, so it stays truthful in the asymmetric cases.
 */
export function createBranchesView(deps: BranchesProviderDeps) {
  const provider = new BranchesProvider(deps);
  const treeView = vscode.window.createTreeView<BranchItem>("ging-git-view.branches", {
    treeDataProvider: provider,
    canSelectMany: true,
    // The native Collapse All would fold the Remote/Local group headings too;
    // a custom title button (branches.collapseAll) collapses only the folders.
    showCollapseAll: false
  });

  // Renders the two independent leaf markings carried in the URI's flags:
  // dimmed (a hide toggle would remove this branch) and the merged badge.
  // Returns nothing for every other resource in the workbench.
  // No `tooltip` here: every leaf sets `TreeItem.tooltip` explicitly (the ref,
  // plus "merged into <default branch>" when badged), and that always wins over
  // a decoration tooltip — one set here would never be read.
  const dimColor = new vscode.ThemeColor("disabledForeground");
  const decorationSub = vscode.window.registerFileDecorationProvider({
    provideFileDecoration: (uri) =>
      uri.scheme === BRANCH_SCHEME
        ? {
            color: uri.authority.includes(FLAG_DIMMED) ? dimColor : undefined,
            badge: uri.authority.includes(FLAG_MERGED) ? "✓" : undefined
          }
        : undefined
  });

  // Which selection events write the filter — and which are TreeView artefacts
  // (the empty selection a repo-switch rebuild emits, the one the search path's
  // re-keying emits) that must not clobber it — is the reconciler's call,
  // unit-tested in isolation. This handler only pipes events in and interprets
  // the decisions; the one piece of machinery it owns is the debounce timer the
  // decisions ask for.
  const reconciler = createBranchSelectionReconciler();
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const cancelDebounce = (): void => {
    if (debounce !== undefined) {
      clearTimeout(debounce);
      debounce = undefined;
    }
  };
  const selectionSub = treeView.onDidChangeSelection((e) => {
    const decision = reconciler.onSelection(
      provider.getRepo(),
      selectedBranchRefs([...e.selection])
    );
    if (decision.kind !== "schedule") return;
    // Restarting the timer on every scheduled event is what coalesces a rapid
    // multi-select (Ctrl/Cmd-click several branches) into a single graph reload
    // rather than one per click.
    cancelDebounce();
    debounce = setTimeout(() => {
      debounce = undefined;
      const write = reconciler.onDebounceElapsed();
      if (write !== null) deps.filterStore.set(write.repo, write.branches);
    }, decision.delayMs);
  });

  // The view's half of a direct write, bound once. `provider.clearSelection()`
  // appearing nowhere else is the point (see `branchSelectionReconciler.ts`).
  const directWrite = createDirectFilterWriter(reconciler, {
    branchSelection: () => selectedBranchRefs([...treeView.selection]),
    cancelPendingWrite: cancelDebounce,
    writeFilter: (write) => {
      deps.filterStore.set(write.repo, write.branches);
    },
    clearVisualSelection: () => provider.clearSelection()
  });

  /** QuickPick over the branches currently in the tree, with one checkbox per
   *  branch (the current filter pre-checked) — confirming makes the checked set
   *  the graph filter. A single checked branch additionally reveals + selects
   *  it in the tree (the normal selection pipeline); checking none shows all.
   *  TreeView offers no API to set a multi-selection programmatically, so the
   *  multi case goes through `directWrite`, which clears the tree's visual
   *  selection instead of setting it. */
  const searchBranch = async (): Promise<void> => {
    const repo = provider.getRepo();
    if (repo === null) return;
    const leaves = provider.visibleLeaves();
    if (leaves.length === 0) return;
    const currentFilter = deps.filterStore.get(repo);
    type BranchPick = vscode.QuickPickItem & { ref?: string };
    const toPick = (leaf: BranchTreeLeaf): BranchPick => ({
      label:
        (leaf.isHead ? "$(check) " : leaf.isRemote ? "$(cloud) " : "$(git-branch) ") +
        (leaf.isRemote ? leaf.branch.slice(REMOTE_PREFIX.length) : leaf.branch),
      description: leaf.isHead ? l10n.t("branchView.current") : undefined,
      ref: leaf.branch,
      picked: currentFilter.includes(leaf.branch)
    });
    // Same order as the tree: the remote section first, then local.
    const remote = leaves.filter((leaf) => leaf.isRemote).map(toPick);
    const local = leaves.filter((leaf) => !leaf.isRemote).map(toPick);
    const items: BranchPick[] =
      remote.length > 0 && local.length > 0
        ? [
            {
              label: l10n.t("branchView.group.remote"),
              kind: vscode.QuickPickItemKind.Separator
            },
            ...remote,
            { label: l10n.t("branchView.group.local"), kind: vscode.QuickPickItemKind.Separator },
            ...local
          ]
        : [...remote, ...local];
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: l10n.t("branchView.search.placeholder"),
      matchOnDescription: true,
      canPickMany: true
    });
    if (picked === undefined) return; // cancelled
    const refs = picked.map((p) => p.ref).filter((r): r is string => r !== undefined);
    if (refs.length === 1) {
      const item = provider.findLeafItem(refs[0]);
      if (item !== null) {
        // select:true fires onDidChangeSelection, which sets the filter exactly
        // as a manual click would (same debounce, same repo guard).
        await treeView.reveal(item, { select: true, focus: true });
        return;
      }
    }
    // Zero (= show all) or several branches: no tree gesture can carry this, so
    // it is a direct write, which swallows the empty-selection event its own
    // clearing emits.
    directWrite(repo, refs);
    if (refs.length > 0) {
      const first = provider.findLeafItem(refs[0]);
      if (first !== null) await treeView.reveal(first, { select: false, focus: false });
    }
  };

  /** "Show All": the empty branch filter, plus the tree highlight going away so
   *  the two agree. Reached from the side-view title button, the command
   *  palette and the graph's filter chip. The emptiness of the set is all that
   *  separates it from the multi-pick search, so it is the same direct write. */
  const showAll = (): void => {
    const repo = provider.getRepo();
    if (repo === null) return;
    directWrite(repo, []);
  };

  /** Resolve a batch action's targets from a tree-view multi-selection. VSCode
   *  passes the clicked item first and the whole selection second, but only for
   *  a `canSelectMany` tree — a keybinding or the command palette supplies just
   *  the one, hence the `[item]` fallback at the call sites. */
  const actionTargetsForSelection = (
    items: unknown[],
    action: BatchAction
  ): BranchActionTargets | null => {
    const repo = provider.getRepo();
    if (repo === null) return null;
    const selected = selectedBranchRefs(
      items.filter((i): i is BranchItem => i instanceof BranchItem)
    );
    const { targets, skipped } = resolveActionTargets(provider.getRoots(), selected, action);
    return {
      repo,
      targets: targets.map((leaf) => leaf.branch),
      skipped: skipped.map((s) => ({ ref: s.leaf.branch, reason: s.reason }))
    };
  };

  return {
    actionTargetsForSelection,
    setActiveRepo: (repo: string | null): void => {
      // Drop any pending write from the previous repo before switching, and let
      // the reconciler see which repo this is: several callers re-point the view
      // at the repo it is already on, and what it gives up on depends on whether
      // this one moved anything. `provider.setRepo` ignores a re-point too, but
      // that guard runs last and so cannot stand in for this one.
      cancelDebounce();
      reconciler.onRepoSwitch(repo);
      provider.setRepo(repo);
    },
    getActiveRepo: (): string | null => provider.getRepo(),
    refresh: (opts?: { hard?: boolean }): void => provider.refresh(opts),
    collapseFolders: (): void => provider.collapseFolders(),
    searchBranch,
    showAll,
    dispose: (): void => {
      cancelDebounce();
      selectionSub.dispose();
      decorationSub.dispose();
      treeView.dispose();
      provider.dispose();
    }
  };
}
