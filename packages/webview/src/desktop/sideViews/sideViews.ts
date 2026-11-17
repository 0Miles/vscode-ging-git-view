/* The desktop host's Branches and Remotes side views (#399): VS Code's two
 * TreeViews, drawn in the Tab's own page beside its graph. What is listed, and
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
 * host for a new one. */

import {
  type BranchActionTargets,
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
import type { GraphInPage } from "@ging/webview/gitGraphView";
import { escapeHtml } from "@ging/webview/utils/html";
import { type SvgIconName, svgIcons } from "@ging/webview/utils/icons";
import { sendMessage, vscode } from "@ging/webview/utils/vscode";

import {
  batchBranchMenu,
  type BranchMenuContext,
  singleActionApplies,
  singleBranchMenu
} from "./branchMenu";
import {
  isSideViewStateMessage,
  type SideViewRemoteAction,
  type SideViewRequest,
  type SideViewStateMessage
} from "./protocol";
import { SIDE_VIEW_STYLES } from "./styles";

/** How long the tree waits after a click before it writes the filter, so a
 *  run of Ctrl/Cmd-clicks reloads the graph once: VS Code's side view waits as
 *  long (`SELECTION_WRITE_DEBOUNCE_MS`). */
export const FILTER_WRITE_DELAY_MS = 200;

const post = (message: SideViewRequest) =>
  // Cast as the host prompt replies are (desktop/main.ts): the host API is
  // typed for the graph's requests, and the side views' stay out of it.
  (vscode.postMessage as unknown as (m: SideViewRequest) => void)(message);

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

/** The row of `body` keyed `key`. Compared, not put in a selector: a key holds
 *  a branch name, which may hold anything a selector would read as syntax. */
const rowKeyed = (body: HTMLElement, key: string | null): HTMLElement | null =>
  key === null
    ? null
    : (Array.from(body.querySelectorAll<HTMLElement>("[data-key]")).find(
        (row) => row.dataset.key === key
      ) ?? null);

const rowOf = (target: EventTarget | null) =>
  target instanceof Element ? target.closest<HTMLElement>(".sideViewRow") : null;

/** A menu raised from the keyboard: no pointer, so the graph's menu hangs it
 *  off the row, as it does its own (`menuAnchorPoint`). */
const keyboardMenuEvent = () => new Event("contextmenu");

/** Set the heading of a side view. */
function setTitle(view: HTMLElement, text: string) {
  view.querySelector<HTMLElement>(".sideViewTitleText")!.textContent = text;
}

/** Whether a node starts expanded: the Remote / Local headings do, folders do
 *  not, as in VS Code's side view. */
const expandedByDefault = (node: BranchTreeNode) => node.type === "group";

/** Keys a browser's tree takes, and what they do here. */
const TREE_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "Enter",
  " ",
  "ContextMenu"
]);

/** Start the side views in this page, beside `graph`. Once per page. */
export function startSideViews(graph: GraphInPage): void {
  const style = document.createElement("style");
  style.textContent = SIDE_VIEW_STYLES;
  document.head.appendChild(style);

  const aside = document.createElement("aside");
  aside.id = "sideViews";
  aside.innerHTML =
    sectionHtml("branchesView", true) + sectionHtml("remotesView", false /* VS Code's too */);
  // First in the page, so Tab reaches it before the graph, as it sits.
  document.body.insertBefore(aside, document.body.firstChild);
  document.body.classList.add("gingSideViews");

  const branchesView = aside.querySelector<HTMLElement>("#branchesView")!;
  const remotesView = aside.querySelector<HTMLElement>("#remotesView")!;
  const branchesBody = branchesView.querySelector<HTMLElement>(".sideViewBody")!;
  const remotesBody = remotesView.querySelector<HTMLElement>(".sideViewBody")!;

  let state: SideViewStateMessage | null = null;
  /** The highlighted branches: the filter the host last said, or the one a
   *  click is about to write. */
  let selected: string[] = [];
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
    const isSelected = selected.includes(node.branch);
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

  /** Draw, keeping the keyboard where it was when it was in the tree. */
  const redraw = (body: HTMLElement, html: string, focused: string | null) => {
    const hadFocus = body.contains(document.activeElement);
    body.innerHTML = html;
    if (!hadFocus || focused === null) return;
    (rowKeyed(body, focused) ?? body.querySelector<HTMLElement>('[role="treeitem"]'))?.focus({
      preventScroll: true
    });
  };

  const renderBranches = () => {
    const strings = state?.strings;
    const branches = state?.branches ?? null;
    if (strings === undefined || branches === null) {
      branchRows = [];
      branchesBody.innerHTML = "";
      return;
    }
    branchRows = visibleRows(branches.roots);
    if (branchRows.length === 0) {
      branchesBody.innerHTML = `<div class="sideViewEmpty">${escapeHtml(strings.noBranches)}</div>`;
      return;
    }
    if (focusKey === null || !branchRows.some((r) => r.key === focusKey)) {
      focusKey = (
        branchRows.find((r) => r.node.type === "leaf" && selected.includes(r.node.branch)) ??
        branchRows[0]
      ).key;
    }
    redraw(
      branchesBody,
      branchRows.map((row) => rowHtml(row, row.key === focusKey)).join(""),
      focusKey
    );
  };

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
    redraw(
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
    const actions = (view: HTMLElement, buttons: [string, string, string][]) => {
      view.querySelector<HTMLElement>(".sideViewActions")!.innerHTML = buttons
        .map(
          ([action, icon, label]) =>
            `<button type="button" data-action="${action}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${icon}</button>`
        )
        .join("");
    };
    actions(branchesView, [
      ["showAll", svgIcons.filter, strings.showAll],
      ["refresh", svgIcons.refresh, strings.refresh],
      ["more", svgIcons.chevronDown, strings.more]
    ]);
    actions(remotesView, [
      ["refresh", svgIcons.refresh, strings.refresh],
      ["more", svgIcons.chevronDown, strings.more]
    ]);
  };

  const render = () => {
    renderHeaders();
    renderBranches();
    renderRemotes();
  };

  // --- The branch filter -------------------------------------------------

  const writeFilter = () => {
    if (pendingWrite !== null) clearTimeout(pendingWrite);
    pendingWrite = null;
    if (state !== null)
      post({ command: "sideViewSetFilter", repo: state.repo, branches: selected });
  };
  const select = (ref: string, toggle: boolean) => {
    selected = toggle
      ? selected.includes(ref)
        ? selected.filter((r) => r !== ref)
        : [...selected, ref]
      : [ref];
    renderBranches();
    if (pendingWrite !== null) clearTimeout(pendingWrite);
    pendingWrite = setTimeout(writeFilter, FILTER_WRITE_DELAY_MS);
  };
  /** Show All: the empty filter, at once. */
  const showAll = () => {
    selected = [];
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
    const resolved = resolveActionTargets(state.branches.roots, selected, action);
    const targets: BranchActionTargets = {
      repo: state.repo,
      targets: resolved.targets.map((leaf) => leaf.branch),
      skipped: resolved.skipped.map((s) => ({ ref: s.leaf.branch, reason: s.reason }))
    };
    if (isHostAction(action)) {
      if (targets.targets.length > 0) PAGE_HOST_ACTIONS[action](targets.targets);
      return;
    }
    if (targets.targets.length === 0) {
      post({ command: "sideViewNoTargets", skipped: targets.skipped });
      return;
    }
    graph.runRefBatchAction(action, targets.targets, targets.skipped, targets.repo);
  };

  const openBranchMenu = (e: Event, row: HTMLElement) => {
    const ref = row.dataset.ref;
    const leaf = ref === undefined ? null : leafOf(ref);
    if (leaf === null || state === null) return;
    const repo = state.repo;
    const strings = state.strings;
    const items =
      selected.length > 1 && selected.includes(leaf.branch)
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

  /** A tree's keys, on the tree: they are not the graph's to move its rows by. */
  const treeKeys = (body: HTMLElement, onRow: (row: HTMLElement, e: KeyboardEvent) => boolean) => {
    body.addEventListener("keydown", (e) => {
      const isMenuKey = e.key === "ContextMenu" || (e.shiftKey && e.key === "F10");
      if (!TREE_KEYS.has(e.key) && !isMenuKey) return;
      const row = rowOf(document.activeElement);
      if (row === null || !body.contains(row)) return;
      const rows = Array.from(body.querySelectorAll<HTMLElement>(".sideViewRow"));
      const at = rows.indexOf(row);
      let next: HTMLElement | null = null;
      if (e.key === "ArrowUp") next = rows[at - 1] ?? null;
      else if (e.key === "ArrowDown") next = rows[at + 1] ?? null;
      else if (e.key === "Home") next = rows[0] ?? null;
      else if (e.key === "End") next = rows[rows.length - 1] ?? null;
      else if (!onRow(row, e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (next === null) return;
      row.tabIndex = -1;
      next.tabIndex = 0;
      next.focus();
      if (typeof next.scrollIntoView === "function") next.scrollIntoView({ block: "nearest" });
      if (body === branchesBody) focusKey = next.dataset.key!;
      else remoteFocus = next.dataset.key!;
    });
  };

  treeKeys(branchesBody, (row, e) => {
    const key = row.dataset.key!;
    const branchRow = branchRows.find((r) => r.key === key);
    if (branchRow === undefined) return false;
    if (e.key === "Enter" || e.key === " ") {
      activateBranchRow(row, e.ctrlKey || e.metaKey);
      return true;
    }
    if (e.key === "ContextMenu" || e.key === "F10") {
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
  });
  treeKeys(remotesBody, (row, e) => {
    if (e.key !== "ContextMenu" && e.key !== "F10") return false;
    if (row.dataset.remote === undefined || state === null) return false;
    graph.showContextMenu(keyboardMenuEvent(), remoteMenu(row.dataset.remote), row);
    return true;
  });

  /** Draw, with the keyboard on `focusKey` whether or not it was in the tree. */
  const renderBranchesFocused = () => {
    renderBranches();
    rowKeyed(branchesBody, focusKey)?.focus();
  };

  for (const [view, name] of [
    [branchesView, "branches"],
    [remotesView, "remotes"]
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
        case "showAll":
          showAll();
          break;
        case "refresh":
          post({ command: "sideViewRefresh" });
          break;
        case "more":
          graph.showContextMenu(e, moreMenu(name), button);
          break;
      }
    });
  }

  window.addEventListener("message", (event: MessageEvent) => {
    if (!isSideViewStateMessage(event.data)) return;
    state = event.data;
    // A write still waiting is the user's latest word, and the host's state
    // is from before it.
    if (pendingWrite === null) selected = state.branches?.filter ?? [];
    render();
  });
  post({ command: "sideViewReady" });
}

function sectionHtml(id: string, open: boolean): string {
  return `<section class="sideView${open ? " open" : ""}" id="${id}"><div class="sideViewHeader"><button type="button" class="sideViewTitle" aria-expanded="${open}">${svgIcons.chevronDown}<span class="sideViewTitleText"></span></button><span class="sideViewActions"></span></div><div class="sideViewBody" role="tree"${
    id === "branchesView" ? ' aria-multiselectable="true"' : ""
  }></div></section>`;
}
