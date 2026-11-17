/* The desktop host's Stash side view (#400): VS Code's Stash TreeView, drawn
 * in the Tab's own page under the Branches and Remotes views. Every stash the
 * repository has, newest first, each expanding into the files it changed; a
 * click on a file opens its diff.
 *
 * Unlike a branch's, a stash's actions do not run in the graph, though it is
 * in this page: the graph's stash dialogs find their stash among the rows it
 * has loaded, and this view lists the ones it has not (ADR-0029). So each is
 * a request to the host, which runs core's own action on the stash as it
 * listed it, asking in the host prompt overlay — as VS Code's view asks in
 * its host. The menu is the shared stash catalogue's, under the graph's own
 * labels for the same actions. */

import {
  STASH_ACTION_CATALOGUE,
  type StashAction,
  stashActionShown,
  STASH_ACTIONS_IN_ORDER
} from "@ging/shared/backend/utils/stashActionCatalogue";
import type { ContextMenuActionsVisibility } from "@ging/shared/types";
import type { GraphInPage } from "@ging/webview/gitGraphView";
import { ELLIPSIS } from "@ging/webview/utils/git";
import { escapeHtml } from "@ging/webview/utils/html";
import { type SvgIconName, svgIcons } from "@ging/webview/utils/icons";

import type {
  SideViewRequest,
  SideViewStash,
  SideViewStashFile,
  SideViewStashFilesMessage,
  SideViewStateMessage
} from "./protocol";
import { keyboardMenuEvent, redrawTree, rowOf, treeKeys } from "./tree";

/** Each action's words and icon, as the graph's own stash menu has them
 *  (`refContextMenu`): the same actions, under the same names. */
const PRESENTATION: Record<StashAction, { label: () => string; icon?: SvgIconName }> = {
  apply: { label: () => l10n.stashApply + ELLIPSIS },
  pop: { label: () => l10n.stashPop + ELLIPSIS },
  rename: { label: () => l10n.stashRename + ELLIPSIS, icon: "pencil" },
  drop: { label: () => l10n.stashDrop + ELLIPSIS, icon: "trash" },
  copyName: { label: () => l10n.copyStashName, icon: "copy" }
};

/** A stash's menu: the catalogue's actions the settings show, in its order, a
 *  divider between two of its groups. */
export function stashMenu(
  cmv: Pick<ContextMenuActionsVisibility, "stash">,
  run: (action: StashAction) => void
): ContextMenuElement[] {
  const menu: ContextMenuElement[] = [];
  let group: string | null = null;
  for (const action of STASH_ACTIONS_IN_ORDER.filter((a) => stashActionShown(a, cmv))) {
    const next = STASH_ACTION_CATALOGUE[action].group;
    if (group !== null && next !== group) menu.push(null);
    group = next;
    const { label, icon } = PRESENTATION[action];
    menu.push({ title: label(), icon, onClick: () => run(action) });
  }
  return menu;
}

const stashKey = (id: string) => "stash:" + id;
const fileKey = (id: string, path: string) => "file:" + id + ":" + path;

export type StashView = {
  /** The host's state of every view: this one's part of it. */
  update(state: SideViewStateMessage): void;
  /** The files of a stash the view asked for. */
  receiveFiles(message: SideViewStashFilesMessage): void;
};

/** Draw the Stash view in `view`, its section of the side views' column. */
export function createStashView(
  view: HTMLElement,
  deps: {
    post(message: SideViewRequest): void;
    showContextMenu: GraphInPage["showContextMenu"];
  }
): StashView {
  const body = view.querySelector<HTMLElement>(".sideViewBody")!;
  let state: SideViewStateMessage | null = null;
  /** The stashes shown expanded, by id. */
  const expanded = new Set<string>();
  /** Each expanded stash's files: asked for and not yet here (`undefined`
   *  in the map), here, or unreadable (`null`). A stash never changes under
   *  its SHA, so they are kept while it is listed. */
  const files = new Map<string, SideViewStashFile[] | null | undefined>();
  /** The row holding the tree's tab stop, by key. */
  let focusKey: string | null = null;

  const stashes = (): SideViewStash[] => state?.stashes ?? [];
  const stashOf = (id: string | undefined) =>
    id === undefined ? undefined : stashes().find((stash) => stash.id === id);

  const stashHtml = (stash: SideViewStash, open: boolean): string => {
    const key = stashKey(stash.id);
    return `<div class="sideViewRow stash" role="treeitem" aria-level="1" aria-expanded="${open}" tabindex="${key === focusKey ? 0 : -1}" data-key="${escapeHtml(key)}" data-stash="${escapeHtml(stash.id)}" title="${escapeHtml(stash.tooltip)}" style="padding-left:4px"><span class="sideViewTwisty">${svgIcons.chevronDown}</span><span class="sideViewIcon">${svgIcons.stash}</span><span class="sideViewLabel">${escapeHtml(stash.message)}</span><span class="sideViewDescription">${escapeHtml(stash.selector)}</span></div>`;
  };

  const fileHtml = (id: string, file: SideViewStashFile): string => {
    const key = fileKey(id, file.path);
    return `<div class="sideViewRow stashFile" role="treeitem" aria-level="2" tabindex="${key === focusKey ? 0 : -1}" data-key="${escapeHtml(key)}" data-stash="${escapeHtml(id)}" data-path="${escapeHtml(file.path)}" title="${escapeHtml(file.tooltip)}" style="padding-left:16px"><span class="sideViewTwisty"></span><span class="sideViewLabel">${escapeHtml(file.name)}</span>${
      file.dir === "" ? "" : `<span class="sideViewDescription">${escapeHtml(file.dir)}</span>`
    }<span class="sideViewFileBadge badge${file.badge}">${file.badge}</span></div>`;
  };

  const render = () => {
    const strings = state?.strings;
    if (strings === undefined || state?.stashes === null) {
      body.innerHTML = "";
      return;
    }
    const listed = stashes();
    if (listed.length === 0) {
      body.innerHTML = `<div class="sideViewEmpty">${escapeHtml(strings.noStashes)}</div>`;
      return;
    }
    const keys: string[] = [];
    const html: string[] = [];
    for (const stash of listed) {
      const open = expanded.has(stash.id);
      keys.push(stashKey(stash.id));
      html.push(stashHtml(stash, open));
      if (!open) continue;
      for (const file of files.get(stash.id) ?? []) {
        keys.push(fileKey(stash.id, file.path));
        html.push(fileHtml(stash.id, file));
      }
    }
    if (focusKey === null || !keys.includes(focusKey)) {
      // The tab stop goes to a row the tree has: drawn again with it.
      focusKey = keys[0];
      render();
      return;
    }
    redrawTree(body, html.join(""), focusKey);
  };

  const toggle = (id: string) => {
    if (expanded.delete(id)) {
      render();
      return;
    }
    expanded.add(id);
    // Asked once per stash; one that could not be read is asked again.
    if (!files.has(id) || files.get(id) === null) {
      files.set(id, undefined);
      deps.post({ command: "sideViewStashFiles", id });
    }
    render();
  };

  const openMenu = (e: Event, row: HTMLElement) => {
    const stash = stashOf(row.dataset.stash);
    if (stash === undefined || state === null) return;
    deps.showContextMenu(
      e,
      stashMenu(state.cmv, (action) =>
        deps.post({ command: "sideViewStash", action, id: stash.id })
      ),
      row
    );
  };

  const activate = (row: HTMLElement) => {
    focusKey = row.dataset.key!;
    const id = row.dataset.stash;
    if (id === undefined) return;
    if (row.dataset.path !== undefined) {
      deps.post({ command: "sideViewStashDiff", id, path: row.dataset.path });
    } else toggle(id);
  };

  body.addEventListener("click", (e) => {
    const row = rowOf(e.target);
    if (row !== null) activate(row);
  });
  body.addEventListener("contextmenu", (e) => {
    const row = rowOf(e.target);
    if (row === null || row.dataset.path !== undefined || row.dataset.stash === undefined) return;
    e.preventDefault();
    // Not on to the document, whose listener closes the menu just raised.
    e.stopPropagation();
    focusKey = row.dataset.key!;
    openMenu(e, row);
  });

  /** Draw, with the keyboard on `focusKey` whether or not it was in the tree. */
  const renderFocused = () => {
    render();
    Array.from(body.querySelectorAll<HTMLElement>("[data-key]"))
      .find((row) => row.dataset.key === focusKey)
      ?.focus();
  };

  treeKeys(
    body,
    (row, e) => {
      const id = row.dataset.stash;
      if (id === undefined) return false;
      const isFile = row.dataset.path !== undefined;
      if (e.key === "Enter" || e.key === " ") {
        activate(row);
        return true;
      }
      if (e.key === "ContextMenu" || e.key === "F10") {
        if (isFile) return false;
        openMenu(keyboardMenuEvent(), row);
        return true;
      }
      if (isFile) {
        // Left from a file goes up to its stash, as in any tree.
        if (e.key !== "ArrowLeft") return false;
        focusKey = stashKey(id);
        renderFocused();
        return true;
      }
      const open = expanded.has(id);
      if ((e.key === "ArrowRight" && !open) || (e.key === "ArrowLeft" && open)) {
        focusKey = stashKey(id);
        toggle(id);
        return true;
      }
      return false;
    },
    (next) => {
      focusKey = next.dataset.key!;
    }
  );

  return {
    update(next) {
      // Another repository's stashes are none of these.
      if (state !== null && state.repo !== next.repo) {
        expanded.clear();
        files.clear();
      }
      state = next;
      const listed = new Set(stashes().map((stash) => stash.id));
      // Deleting what was already visited is safe while iterating a Set or Map.
      for (const id of expanded) if (!listed.has(id)) expanded.delete(id);
      for (const id of files.keys()) if (!listed.has(id)) files.delete(id);
      render();
    },
    receiveFiles(message) {
      if (state === null || message.repo !== state.repo || !files.has(message.id)) return;
      files.set(message.id, message.files);
      render();
    }
  };
}
