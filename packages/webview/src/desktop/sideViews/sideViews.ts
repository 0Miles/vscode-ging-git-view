/* The desktop host's Branches and Remotes side views (#399): VS Code's two
 * TreeViews, drawn in the Tab's own page beside its graph, with the Stash
 * view under them (stashView.ts, #400). What is listed, and
 * how each branch is marked, the host reads through core (`branchSideView`),
 * as VS Code's side view does; this module only draws it and answers the
 * user's gestures.
 *
 * Two of those gestures go where VS Code's go, by another road (ADR-0033):
 *
 * - **A branch action** runs in the graph, in its in-graph flow, dialogs
 *   included — called directly, since the graph is in this page. The action
 *   list is the shared catalogue's (branchMenu.ts), and so is the head guard.
 * - **A remote's action** is core's command service, asked through the host's
 *   `Prompts` (the host prompt overlay): the graph has no dialog for it.
 *
 * The tree's selection is the branch filter. VS Code cannot set a TreeView's
 * selection, which is why its side view has direct writes and a one-shot
 * suppression (GLOSSARY.md); a page can draw any selection, so here the
 * highlight is simply the filter the host last said, and a click asks the
 * host for a new one. Each ask is numbered, and the host says which one it
 * had taken when it read each state, so a state read before the latest click
 * cannot flip the highlight back while the click is on its way. */

import {
  actionTargetRefs,
  planBatch,
  resolveActionTargets
} from "@ging/shared/backend/utils/branchActionTargets";
import { displayRef } from "@ging/shared/backend/utils/branchRef";
import type { BranchTreeLeaf, BranchTreeNode } from "@ging/shared/backend/utils/branchTree";
import {
  type CatalogueRefAction,
  type HostRefAction,
  isHostAction
} from "@ging/shared/backend/utils/refActionCatalogue";
import type { BatchAction } from "@ging/shared/types";
import { postToHost } from "@ging/webview/desktop/postToHost";
import type { GraphInPage } from "@ging/webview/gitGraphView";
import { escapeHtml } from "@ging/webview/utils/html";
import { type SvgIconName, svgIcons } from "@ging/webview/utils/icons";
import { sendMessage } from "@ging/webview/utils/vscode";

import {
  batchBranchMenu,
  type BranchMenuContext,
  singleActionApplies,
  singleBranchMenu
} from "./branchMenu";
import {
  clampSideViewWidth,
  DEFAULT_SIDE_VIEW_LAYOUT,
  isSideViewLayoutMessage,
  isSideViewStashFilesMessage,
  isSideViewStateMessage,
  SIDE_VIEW_MAX_WIDTH,
  SIDE_VIEW_MIN_WIDTH,
  type SideViewLayout,
  type SideViewRemoteAction,
  type SideViewRequest,
  type SideViewStateMessage
} from "./protocol";
import { createStashView } from "./stashView";
import { SIDE_VIEW_ROW_HEIGHT, SIDE_VIEW_STYLES } from "./styles";
import {
  isMenuKey,
  isTreeKey,
  keyboardMenuEvent,
  redrawTree,
  rowKeyed,
  rowOf,
  treeKeys
} from "./tree";

/** How long the tree waits after a click before it writes the filter, so a
 *  run of Ctrl/Cmd-clicks reloads the graph once: VS Code's side view waits as
 *  long (`SELECTION_WRITE_DEBOUNCE_MS`). */
export const FILTER_WRITE_DELAY_MS = 200;

/** Rows the Branches tree draws past each edge of what shows (#459), so a
 *  scroll finds them there. 19, not 20: what shows can be cut by both edges,
 *  two rows more than its height holds, so the rows drawn never exceed its
 *  height's worth and 40. */
const BRANCH_ROWS_OVERSCAN = 19;

/** How far a step of the keyboard moves the column's edge (#459). */
const SIDE_VIEW_WIDTH_STEP = 10;

const post: (message: SideViewRequest) => void = postToHost;

/** The actions that run in the host in VS Code because they ask nothing
 *  (ADR-0009). Here they are the page's own requests to the host, with no
 *  graph flow to run: `copyName` is the graph's copy request, so its failure
 *  is told the way the graph tells it. Display refs, one per line. */
const PAGE_HOST_ACTIONS: Record<HostRefAction, (refs: string[]) => void> = {
  copyName: (refs) =>
    sendMessage({
      command: "copyToClipboard",
      type: "Branch Name",
      data: refs.map(displayRef).join("\n")
    })
};

/** A row of the Branches tree as drawn: a node, where it sits, and its key —
 *  stable across redraws, so expansion and focus survive them. */
type BranchRow = { node: BranchTreeNode; key: string; depth: number; parent: string | null };

const leafKey = (ref: string) => "leaf:" + ref;

/** Set the heading of a side view. */
function setTitle(view: HTMLElement, text: string) {
  view.querySelector<HTMLElement>(".sideViewTitleText")!.textContent = text;
}

/** Whether a node starts expanded: the Remote / Local headings do, folders do
 *  not, as in VS Code's side view. */
const expandedByDefault = (node: BranchTreeNode) => node.type === "group";

/** Start the side views in this page, beside `graph`, laid out as `layout`
 *  says — the app's, which the host served the page with (#459). Once per
 *  page. */
export function startSideViews(
  graph: GraphInPage,
  initialLayout: SideViewLayout = DEFAULT_SIDE_VIEW_LAYOUT
): void {
  let layout = initialLayout;
  const style = document.createElement("style");
  style.textContent = SIDE_VIEW_STYLES;
  document.head.appendChild(style);

  const aside = document.createElement("aside");
  aside.id = "sideViews";
  aside.innerHTML =
    sectionHtml("branchesView", true) +
    sectionHtml("remotesView", false /* VS Code's too */) +
    sectionHtml("stashView", true);
  // The column's edge, dragged or moved by the arrows to resize it (#459):
  // beside the column rather than in it, which clips what overflows it.
  const resizer = document.createElement("div");
  resizer.id = "sideViewResizer";
  resizer.setAttribute("role", "separator");
  resizer.setAttribute("aria-orientation", "vertical");
  resizer.setAttribute("aria-valuemin", String(SIDE_VIEW_MIN_WIDTH));
  resizer.setAttribute("aria-valuemax", String(SIDE_VIEW_MAX_WIDTH));
  resizer.tabIndex = 0;
  // First in the page, so Tab reaches it before the graph, as it sits; its
  // edge after it.
  document.body.insertBefore(resizer, document.body.firstChild);
  document.body.insertBefore(aside, resizer);

  const branchesView = aside.querySelector<HTMLElement>("#branchesView")!;
  const remotesView = aside.querySelector<HTMLElement>("#remotesView")!;
  const branchesBody = branchesView.querySelector<HTMLElement>(".sideViewBody")!;
  const remotesBody = remotesView.querySelector<HTMLElement>(".sideViewBody")!;
  const stashView = aside.querySelector<HTMLElement>("#stashView")!;
  const stashes = createStashView(stashView, {
    post,
    showContextMenu: (e, items, source) => graph.showContextMenu(e, items, source)
  });

  let state: SideViewStateMessage | null = null;
  /** The highlighted branches: the filter the host last said, or the one a
   *  click is about to write. */
  let selected = new Set<string>();
  /** The number of the last filter this page asked the host for. */
  let filterAsked = 0;
  let pendingWrite: ReturnType<typeof setTimeout> | null = null;
  /** Overrides of `expandedByDefault`, by row key. */
  const expanded = new Map<string, boolean>();
  let branchRows: BranchRow[] = [];
  /** The row holding the tree's tab stop, by key. */
  let focusKey: string | null = null;
  let remoteFocus: string | null = null;
  /** The words the headings were last drawn in: redrawn only when they change,
   *  so a state arriving does not take the keyboard off a heading's button. */
  let headerWords: string | null = null;

  // --- The column's layout (#459) ----------------------------------------

  /** Lay the column out as `layout` says. Hidden, it gives up its width
   *  altogether: `--ging-side-view-width` is what the panels beside it (the
   *  file history, the diff viewer) start from too. */
  const applyLayout = () => {
    const { width, shown } = layout;
    document.documentElement.style.setProperty(
      "--ging-side-view-width",
      shown ? `${width}px` : "0px"
    );
    aside.hidden = !shown;
    resizer.hidden = !shown;
    document.body.classList.toggle("gingSideViews", shown);
    resizer.setAttribute("aria-valuenow", String(width));
  };
  applyLayout();

  /** The column `width` wide, as far as its bounds let it be. */
  const resizeTo = (width: number) => {
    layout = { ...layout, width: clampSideViewWidth(width) };
    applyLayout();
  };
  /** The user left the column where it is: the app's from now on, and the
   *  graph laid out again for the width it has, as after a pane resized. */
  let resizeAsked = 0;
  const resized = () => {
    resizeAsked += 1;
    post({ command: "sideViewResize", width: layout.width, seq: resizeAsked });
    window.dispatchEvent(new Event("resize"));
  };

  resizer.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    // Not a text selection, nor the focus taken from where it is.
    e.preventDefault();
    const from = { x: e.clientX, width: layout.width };
    resizer.setPointerCapture(e.pointerId);
    document.body.classList.add("sideViewResizing");
    const move = (ev: PointerEvent) => resizeTo(from.width + ev.clientX - from.x);
    const end = () => {
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", end);
      resizer.removeEventListener("pointercancel", end);
      document.body.classList.remove("sideViewResizing");
      if (layout.width !== from.width) resized();
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", end);
    resizer.addEventListener("pointercancel", end);
  });
  resizer.addEventListener("keydown", (e) => {
    const step =
      e.key === "ArrowLeft"
        ? -SIDE_VIEW_WIDTH_STEP
        : e.key === "ArrowRight"
          ? SIDE_VIEW_WIDTH_STEP
          : 0;
    if (step === 0) return;
    // The graph's arrows move its rows: not these.
    e.preventDefault();
    e.stopPropagation();
    const before = layout.width;
    resizeTo(before + step);
    if (layout.width !== before) resized();
  });

  const menuContext = (): BranchMenuContext => ({
    cmv: state!.cmv,
    hasRemotes: (state?.remotes?.length ?? 0) > 0
  });
  const isExpanded = (row: { node: BranchTreeNode; key: string }) =>
    expanded.get(row.key) ?? expandedByDefault(row.node);

  /** The rows the tree shows, depth first, collapsed nodes' children left out. */
  const visibleRows = (roots: readonly BranchTreeNode[]): BranchRow[] => {
    const rows: BranchRow[] = [];
    const walk = (
      nodes: readonly BranchTreeNode[],
      depth: number,
      scope: string,
      parent: string | null
    ) => {
      for (const node of nodes) {
        const key =
          node.type === "leaf"
            ? leafKey(node.branch)
            : node.type === "group"
              ? "group:" + node.kind
              : scope + "folder:" + node.path;
        const row = { node, key, depth, parent };
        rows.push(row);
        if (node.type !== "leaf" && isExpanded(row)) {
          // Folders of the Remote and Local groups may share a path.
          walk(node.children, depth + 1, node.type === "group" ? node.kind + ":" : scope, key);
        }
      }
    };
    walk(roots, 0, "", null);
    return rows;
  };

  const rowHtml = (row: BranchRow, tabStop: boolean): string => {
    const { node } = row;
    const pad = `style="padding-left:${4 + row.depth * 12}px"`;
    const common = `role="treeitem" tabindex="${tabStop ? 0 : -1}" aria-level="${row.depth + 1}" data-key="${escapeHtml(row.key)}" ${pad}`;
    if (node.type !== "leaf") {
      const open = isExpanded(row);
      const label =
        node.type === "group"
          ? node.kind === "remote"
            ? state!.strings.groupRemote
            : state!.strings.groupLocal
          : node.name;
      const icon =
        node.type === "folder" ? (open ? svgIcons.openFolder : svgIcons.closedFolder) : "";
      return `<div class="sideViewRow ${node.type}" ${common} aria-expanded="${open}"><span class="sideViewTwisty">${svgIcons.chevronDown}</span>${
        icon === "" ? "" : `<span class="sideViewIcon">${icon}</span>`
      }<span class="sideViewLabel">${escapeHtml(label)}</span></div>`;
    }
    const text = state!.branches!.rows[node.branch];
    const isSelected = selected.has(node.branch);
    const classes = [
      "sideViewRow",
      "leaf",
      isSelected ? "selected" : "",
      node.isHidable ? "dimmed" : ""
    ]
      .filter((c) => c !== "")
      .join(" ");
    return `<div class="${classes}" ${common} aria-selected="${isSelected}" data-ref="${escapeHtml(node.branch)}" title="${escapeHtml(text?.tooltip ?? node.branch)}"><span class="sideViewTwisty"></span><span class="sideViewIcon">${
      node.isHead ? svgIcons.check : svgIcons.branch
    }</span><span class="sideViewLabel">${escapeHtml(node.name)}</span>${
      text !== undefined && text.description !== ""
        ? `<span class="sideViewDescription">${escapeHtml(text.description)}</span>`
        : ""
    }${node.isMerged ? '<span class="sideViewBadge">✓</span>' : ""}</div>`;
  };

  /** The rows of `branchRows` drawn now, `[first, end)`; null when none are. */
  let drawnBranches: [number, number] | null = null;

  /** The rows that show at the tree's scroll, and `BRANCH_ROWS_OVERSCAN`
   *  more past each edge. */
  const branchWindow = (): [number, number] => {
    const height = branchesBody.clientHeight;
    // As far as the rows now reach: fewer than before, the scroll is still
    // where they ended until the page is laid out again.
    const top = Math.min(
      branchesBody.scrollTop,
      Math.max(0, branchRows.length * SIDE_VIEW_ROW_HEIGHT - height)
    );
    return [
      Math.max(0, Math.floor(top / SIDE_VIEW_ROW_HEIGHT) - BRANCH_ROWS_OVERSCAN),
      Math.min(
        branchRows.length,
        Math.ceil((top + height) / SIDE_VIEW_ROW_HEIGHT) + BRANCH_ROWS_OVERSCAN
      )
    ];
  };

  /**
   * Draw the rows of the Branches tree that are in its window (#459): a
   * repository with thousands of branches puts tens of rows in the page, not
   * thousands. The rows sit in a block as tall as every row would be, pushed
   * down to where the first drawn one sits, so the tree scrolls as if all
   * were there. Not again for a window already drawn, unless `force`d: what
   * the rows say has changed.
   *
   * The keyboard stays where it was: on the row it was on, or — that row
   * scrolled out of the window — on the tree itself, which then holds the
   * tab stop, and whose keys still act on that row (`branchKeys`).
   */
  const drawBranchWindow = (force: boolean) => {
    if (state === null || branchRows.length === 0 || focusKey === null) return;
    const [first, end] = branchWindow();
    if (
      !force &&
      drawnBranches !== null &&
      drawnBranches[0] === first &&
      drawnBranches[1] === end
    ) {
      return;
    }
    drawnBranches = [first, end];
    const at = branchRows.findIndex((r) => r.key === focusKey);
    const focusDrawn = at >= first && at < end;
    const hadFocus = branchesBody.contains(document.activeElement);
    branchesBody.innerHTML = `<div class="sideViewRows" style="height:${
      branchRows.length * SIDE_VIEW_ROW_HEIGHT
    }px;padding-top:${first * SIDE_VIEW_ROW_HEIGHT}px">${branchRows
      .slice(first, end)
      .map((row) => rowHtml(row, row.key === focusKey))
      .join("")}</div>`;
    branchesBody.tabIndex = focusDrawn ? -1 : 0;
    if (hadFocus) {
      (focusDrawn ? rowKeyed(branchesBody, focusKey)! : branchesBody).focus({
        preventScroll: true
      });
    }
  };

  const renderBranches = () => {
    const strings = state?.strings;
    const branches = state?.branches ?? null;
    drawnBranches = null;
    branchRows = branches === null ? [] : visibleRows(branches.roots);
    if (strings === undefined || branchRows.length === 0) {
      // No row to hold the tab stop, and none for the tree to stand in for.
      branchesBody.removeAttribute("tabindex");
      branchesBody.innerHTML =
        strings === undefined || branches === null
          ? ""
          : `<div class="sideViewEmpty">${escapeHtml(strings.noBranches)}</div>`;
      return;
    }
    if (focusKey === null || !branchRows.some((r) => r.key === focusKey)) {
      focusKey = (
        branchRows.find((r) => r.node.type === "leaf" && selected.has(r.node.branch)) ??
        branchRows[0]
      ).key;
    }
    drawBranchWindow(true);
  };

  /** Scroll the Branches tree just far enough to show the row at `index`,
   *  draw it there, and put the keyboard on it. */
  const focusBranchRow = (index: number): HTMLElement | null => {
    const top = index * SIDE_VIEW_ROW_HEIGHT;
    const height = branchesBody.clientHeight;
    if (top < branchesBody.scrollTop) branchesBody.scrollTop = top;
    else if (top + SIDE_VIEW_ROW_HEIGHT > branchesBody.scrollTop + height) {
      branchesBody.scrollTop = Math.max(0, top + SIDE_VIEW_ROW_HEIGHT - height);
    }
    focusKey = branchRows[index].key;
    drawBranchWindow(true);
    const row = rowKeyed(branchesBody, focusKey);
    row?.focus({ preventScroll: true });
    return row;
  };

  branchesBody.addEventListener("scroll", () => drawBranchWindow(false));
  // The tree's height moves as the other views open and close, the window
  // resizes and the column comes back: as many rows again as then show. Not
  // in jsdom, which lays nothing out.
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => drawBranchWindow(false)).observe(branchesBody);
  }

  const renderRemotes = () => {
    const strings = state?.strings;
    const remotes = state?.remotes ?? null;
    if (strings === undefined || remotes === null) {
      remotesBody.innerHTML = "";
      return;
    }
    if (remotes.length === 0) {
      remotesBody.innerHTML = `<div class="sideViewEmpty">${escapeHtml(strings.noRemotes)}<button type="button" class="sideViewAddRemote">${escapeHtml(strings.addRemote)}</button></div>`;
      return;
    }
    if (remoteFocus === null || !remotes.some((r) => "remote:" + r.name === remoteFocus)) {
      remoteFocus = "remote:" + remotes[0].name;
    }
    redrawTree(
      remotesBody,
      remotes
        .map((remote) => {
          const key = "remote:" + remote.name;
          const tooltip =
            remote.pushUrl !== remote.fetchUrl
              ? `${remote.name}\nfetch: ${remote.fetchUrl}\npush: ${remote.pushUrl}`
              : `${remote.name}\n${remote.fetchUrl}`;
          return `<div class="sideViewRow remote" role="treeitem" aria-level="1" tabindex="${key === remoteFocus ? 0 : -1}" data-key="${escapeHtml(key)}" data-remote="${escapeHtml(remote.name)}" title="${escapeHtml(tooltip)}" style="padding-left:8px"><span class="sideViewLabel">${escapeHtml(remote.name)}</span><span class="sideViewDescription">${escapeHtml(remote.fetchUrl)}</span></div>`;
        })
        .join(""),
      remoteFocus
    );
  };

  const renderHeaders = () => {
    const strings = state?.strings;
    if (strings === undefined || JSON.stringify(strings) === headerWords) return;
    headerWords = JSON.stringify(strings);
    setTitle(branchesView, strings.branches);
    setTitle(remotesView, strings.remotes);
    setTitle(stashView, strings.stashes);
    const actions = (view: HTMLElement, buttons: [string, string, string][]) => {
      view.querySelector<HTMLElement>(".sideViewActions")!.innerHTML = buttons
        .map(
          ([action, icon, label]) =>
            `<button type="button" data-action="${action}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${icon}</button>`
        )
        .join("");
    };
    resizer.setAttribute("aria-label", strings.resize);
    actions(branchesView, [
      ["search", svgIcons.search, strings.search],
      ["showAll", svgIcons.filter, strings.showAll],
      ["refresh", svgIcons.refresh, strings.refresh],
      ["more", svgIcons.chevronDown, strings.more]
    ]);
    actions(remotesView, [
      ["refresh", svgIcons.refresh, strings.refresh],
      ["more", svgIcons.chevronDown, strings.more]
    ]);
    actions(stashView, [["refresh", svgIcons.refresh, strings.refresh]]);
  };

  const render = () => {
    renderHeaders();
    renderBranches();
    renderRemotes();
    if (state !== null) stashes.update(state);
  };

  // --- The branch filter -------------------------------------------------

  const writeFilter = () => {
    if (pendingWrite !== null) clearTimeout(pendingWrite);
    pendingWrite = null;
    if (state === null) return;
    post({
      command: "sideViewSetFilter",
      repo: state.repo,
      branches: [...selected],
      seq: ++filterAsked
    });
  };
  const select = (ref: string, toggle: boolean) => {
    if (!toggle) selected = new Set([ref]);
    else if (!selected.delete(ref)) selected.add(ref);
    renderBranches();
    if (pendingWrite !== null) clearTimeout(pendingWrite);
    pendingWrite = setTimeout(writeFilter, FILTER_WRITE_DELAY_MS);
  };
  /** Show All: the empty filter, at once. */
  const showAll = () => {
    selected = new Set();
    renderBranches();
    writeFilter();
  };

  // --- Branch actions ------------------------------------------------------

  const leafOf = (ref: string): BranchTreeLeaf | null => {
    const walk = (nodes: readonly BranchTreeNode[]): BranchTreeLeaf | null => {
      for (const node of nodes) {
        if (node.type === "leaf") {
          if (node.branch === ref) return node;
        } else {
          const found = walk(node.children);
          if (found !== null) return found;
        }
      }
      return null;
    };
    return walk(state?.branches?.roots ?? []);
  };

  /** Run `action` on one row. Whatever the catalogue rules out for it — the
   *  head guard among them — does nothing, and says nothing: the menu never
   *  offered it (ADR-0033). */
  const runOn = (action: CatalogueRefAction, leaf: BranchTreeLeaf) => {
    if (state === null || !singleActionApplies(action, leaf, menuContext())) return;
    if (isHostAction(action)) PAGE_HOST_ACTIONS[action]([leaf.branch]);
    else graph.runRefAction(action, leaf.branch, state.repo);
  };

  /** Run a batch `action` on the selection, in the tree's order. */
  const runOnSelection = (action: BatchAction) => {
    if (state === null || state.branches === null) return;
    const resolved = resolveActionTargets(state.branches.roots, [...selected], action);
    // What the batch comes to is VS Code's delegate's decision too
    // (`planBatch`); only carrying it out is this page's.
    const plan = planBatch(action, actionTargetRefs(state.repo, resolved));
    switch (plan.kind) {
      case "none":
        return;
      case "host":
        PAGE_HOST_ACTIONS[plan.action](plan.targets);
        return;
      case "noTargets":
        post({ command: "sideViewNoTargets", skipped: plan.skipped });
        return;
      case "graph":
        graph.runRefBatchAction(plan.action, plan.targets, plan.skipped, plan.repo);
    }
  };

  const openBranchMenu = (e: Event, row: HTMLElement) => {
    const ref = row.dataset.ref;
    const leaf = ref === undefined ? null : leafOf(ref);
    if (leaf === null || state === null) return;
    const repo = state.repo;
    const strings = state.strings;
    const items =
      selected.size > 1 && selected.has(leaf.branch)
        ? batchBranchMenu(
            menuContext(),
            {
              delete: escapeHtml(strings.deleteSelected),
              push: escapeHtml(strings.pushSelected),
              fastForward: escapeHtml(strings.fastForwardSelected),
              copyName: escapeHtml(strings.copyNameSelected)
            },
            runOnSelection
          )
        : singleBranchMenu(leaf, menuContext(), {
            run: (action) => runOn(action, leaf),
            cleanup: () => graph.openCleanup(repo)
          });
    graph.showContextMenu(e, items, row);
  };

  const remoteMenu = (name: string): ContextMenuElement[] => {
    const strings = state!.strings;
    const item = (title: string, action: SideViewRemoteAction, icon?: SvgIconName) => ({
      title: escapeHtml(title),
      icon,
      onClick: () => post({ command: "sideViewRemote", action, name })
    });
    return [
      item(strings.fetchRemote, "fetch", "download"),
      null,
      item(strings.editUrl, "editUrl", "pencil"),
      item(strings.renameRemote, "rename"),
      item(strings.removeRemote, "remove", "trash"),
      null,
      item(strings.copyUrl, "copyUrl", "copy")
    ];
  };

  const moreMenu = (view: "branches" | "remotes"): ContextMenuElement[] => {
    const strings = state!.strings;
    if (view === "remotes") {
      return [
        {
          title: escapeHtml(strings.addRemote),
          onClick: () => post({ command: "sideViewAddRemote" })
        },
        null,
        {
          title: escapeHtml(strings.managePullRequestProviders),
          icon: "gitPullRequest",
          onClick: () => post({ command: "sideViewManagePullRequestProviders" })
        }
      ];
    }
    const toggles = state!.branches?.toggles;
    const toggle = (title: string, field: keyof NonNullable<typeof toggles>) => ({
      title: escapeHtml(title),
      checked: toggles?.[field] ?? false,
      onClick: () => post({ command: "sideViewToggle", field })
    });
    return [
      toggle(strings.showRemoteBranches, "showRemoteBranches"),
      toggle(strings.showInactive, "showInactiveBranches"),
      toggle(strings.showMerged, "showMergedBranches"),
      null,
      {
        title: escapeHtml(strings.collapseAll),
        onClick: () => {
          for (const key of expanded.keys()) if (!key.startsWith("group:")) expanded.delete(key);
          renderBranches();
        }
      },
      // VS Code's Branches title has it among its tools (`2_tools`); here it
      // is the application menu's, run on this Tab's repository.
      {
        title: escapeHtml(strings.viewReflog),
        icon: "history",
        onClick: () => post({ command: "sideViewViewReflog" })
      },
      {
        title: escapeHtml(strings.cleanup),
        icon: "trash",
        onClick: () => {
          if (state !== null) graph.openCleanup(state.repo);
        }
      }
    ];
  };

  // --- Gestures ------------------------------------------------------------

  const toggleExpanded = (key: string) => {
    const row = branchRows.find((r) => r.key === key);
    if (row === undefined || row.node.type === "leaf") return;
    expanded.set(key, !isExpanded(row));
    renderBranches();
  };

  const activateBranchRow = (row: HTMLElement, toggle: boolean) => {
    const key = row.dataset.key!;
    focusKey = key;
    if (row.dataset.ref !== undefined) select(row.dataset.ref, toggle);
    else toggleExpanded(key);
  };

  branchesBody.addEventListener("click", (e) => {
    const row = rowOf(e.target);
    if (row !== null) activateBranchRow(row, e.ctrlKey || e.metaKey);
  });
  branchesBody.addEventListener("contextmenu", (e) => {
    const row = rowOf(e.target);
    if (row === null || row.dataset.ref === undefined) return;
    e.preventDefault();
    // Not on to the document, whose listener closes the menu just raised.
    e.stopPropagation();
    focusKey = row.dataset.key!;
    openBranchMenu(e, row);
  });
  remotesBody.addEventListener("click", (e) => {
    if (e.target instanceof Element && e.target.closest(".sideViewAddRemote") !== null) {
      post({ command: "sideViewAddRemote" });
      return;
    }
    const row = rowOf(e.target);
    if (row !== null) remoteFocus = row.dataset.key!;
  });
  remotesBody.addEventListener("contextmenu", (e) => {
    const row = rowOf(e.target);
    if (row === null || row.dataset.remote === undefined || state === null) return;
    e.preventDefault();
    e.stopPropagation();
    remoteFocus = row.dataset.key!;
    graph.showContextMenu(e, remoteMenu(row.dataset.remote), row);
  });

  /** What a key other than the moves does to the row with the keyboard;
   *  whether it took it. */
  const onBranchRow = (row: HTMLElement, e: KeyboardEvent): boolean => {
    const key = row.dataset.key!;
    const branchRow = branchRows.find((r) => r.key === key);
    if (branchRow === undefined) return false;
    if (e.key === "Enter" || e.key === " ") {
      activateBranchRow(row, e.ctrlKey || e.metaKey);
      return true;
    }
    if (isMenuKey(e)) {
      if (row.dataset.ref === undefined) return false;
      openBranchMenu(keyboardMenuEvent(), row);
      return true;
    }
    if (branchRow.node.type === "leaf") {
      // Left from a leaf goes up to its folder, as in any tree.
      if (e.key !== "ArrowLeft" || branchRow.parent === null) return false;
      focusKey = branchRow.parent;
      renderBranchesFocused();
      return true;
    }
    const open = isExpanded(branchRow);
    if (e.key === "ArrowRight" && !open) toggleExpanded(key);
    else if (e.key === "ArrowLeft" && open) toggleExpanded(key);
    else if (e.key === "ArrowLeft" && branchRow.parent !== null) {
      focusKey = branchRow.parent;
      renderBranchesFocused();
    } else return false;
    return true;
  };

  // The Branches tree's keys, on the tree (`treeKeys`' own, but over every row
  // of the tree, drawn or not, #459): Up, Down, Home and End move the keyboard
  // to a row, scrolled to and drawn first; every other key acts on the row
  // the keyboard is on, even one scrolled out of the window since.
  branchesBody.addEventListener("keydown", (e) => {
    if (!isTreeKey(e) || state === null) return;
    const key = rowOf(document.activeElement)?.dataset.key ?? focusKey;
    if (!branchesBody.contains(document.activeElement)) return;
    const at = branchRows.findIndex((r) => r.key === key);
    if (at === -1) return;
    const moves: Record<string, number> = {
      ArrowUp: at - 1,
      ArrowDown: at + 1,
      Home: 0,
      End: branchRows.length - 1
    };
    const next = Object.hasOwn(moves, e.key) ? moves[e.key] : null;
    if (next === null) {
      const row = focusBranchRow(at);
      if (row === null || !onBranchRow(row, e)) return;
    } else if (next >= 0 && next < branchRows.length) {
      focusBranchRow(next);
    }
    e.preventDefault();
    e.stopPropagation();
  });
  treeKeys(
    remotesBody,
    (row, e) => {
      if (e.key !== "ContextMenu" && e.key !== "F10") return false;
      if (row.dataset.remote === undefined || state === null) return false;
      graph.showContextMenu(keyboardMenuEvent(), remoteMenu(row.dataset.remote), row);
      return true;
    },
    (next) => {
      remoteFocus = next.dataset.key!;
    }
  );

  /** Draw, with the keyboard on `focusKey` whether or not it was in the tree,
   *  scrolled to where it shows. */
  const renderBranchesFocused = () => {
    renderBranches();
    const at = branchRows.findIndex((r) => r.key === focusKey);
    if (at !== -1) focusBranchRow(at);
  };

  for (const [view, name] of [
    [branchesView, "branches"],
    [remotesView, "remotes"],
    [stashView, "stashes"]
  ] as const) {
    view.querySelector(".sideViewTitle")!.addEventListener("click", () => {
      const open = view.classList.toggle("open");
      view.querySelector(".sideViewTitle")!.setAttribute("aria-expanded", String(open));
    });
    view.querySelector(".sideViewActions")!.addEventListener("click", (e) => {
      const button = e.target instanceof Element ? e.target.closest<HTMLElement>("button") : null;
      if (button === null || state === null) return;
      e.stopPropagation();
      switch (button.dataset.action) {
        case "search":
          // A click's filter still waiting is written first: the search
          // starts from what the user last chose.
          if (pendingWrite !== null) writeFilter();
          post({ command: "sideViewSearch" });
          break;
        case "showAll":
          showAll();
          break;
        case "refresh":
          post({ command: "sideViewRefresh" });
          break;
        case "more":
          // The Stash view has no More Actions, as VS Code's has none.
          if (name !== "stashes") graph.showContextMenu(e, moreMenu(name), button);
          break;
      }
    });
  }

  window.addEventListener("message", (event: MessageEvent) => {
    if (isSideViewStashFilesMessage(event.data)) {
      stashes.receiveFiles(event.data);
      return;
    }
    if (isSideViewLayoutMessage(event.data)) {
      const { shown } = event.data.layout;
      // Sent before the host heard this page's latest width — the echo of an
      // earlier step among them — so older than what the page shows: the
      // width stays the page's own.
      const width =
        (event.data.resizeSeq ?? 0) < resizeAsked
          ? layout.width
          : clampSideViewWidth(event.data.layout.width);
      const moved = width !== layout.width || shown !== layout.shown;
      layout = { width, shown };
      applyLayout();
      if (moved) {
        // The graph laid out again for the width it has now; the tree's
        // window drawn for the height it shows at.
        window.dispatchEvent(new Event("resize"));
        drawBranchWindow(false);
      }
      return;
    }
    if (!isSideViewStateMessage(event.data)) return;
    state = event.data;
    // A write still waiting, or one the host had not taken when it read this
    // state, is the user's latest word: the state is from before it.
    if (pendingWrite === null && state.filterSeq >= filterAsked) {
      selected = new Set(state.branches?.filter ?? []);
    }
    render();
  });
  post({ command: "sideViewReady" });
}

function sectionHtml(id: string, open: boolean): string {
  return `<section class="sideView${open ? " open" : ""}" id="${id}"><div class="sideViewHeader"><button type="button" class="sideViewTitle" aria-expanded="${open}">${svgIcons.chevronDown}<span class="sideViewTitleText"></span></button><span class="sideViewActions"></span></div><div class="sideViewBody" role="tree"${
    id === "branchesView" ? ' aria-multiselectable="true"' : ""
  }></div></section>`;
}
