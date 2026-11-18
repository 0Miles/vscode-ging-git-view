/* The file history panel (#408): a column over the left of the graph's area,
 * beside the side views (ADR-0031's layout), listing the commits that changed
 * one file, each under the path the file had there. Clicking one asks the
 * host for that commit's diff of the file, which the diff viewer (#404) shows
 * to the panel's right, so the list stays in view to step through.
 *
 * Opened from a Commit Details View file's context menu — the history up to
 * that commit — or by the host, from the application menu's File History…
 * (HEAD's). Every read is the host's; the panel only asks, and draws what
 * each answer brings back. Keys pressed in it stay in it, as the diff
 * viewer's do: the graph's shortcuts listen on the document. */

import type { FileHistoryEntry } from "@ging/shared/backend/types";
import type { CdvFileMenuTarget, GraphInPage } from "@ging/webview/gitGraphView";
import { svgIcons } from "@ging/webview/utils/icons";
import { vscode } from "@ging/webview/utils/vscode";

import {
  type FileHistoryHostMessage,
  type FileHistoryRequest,
  type FileHistoryStrings,
  isFileHistoryHostMessage
} from "./protocol";

/** The column's width. While it is open `body` says so in
 *  `--ging-file-history-width`, and the diff viewer starts that much further
 *  right (diffPanelStyles.ts). */
export const FILE_HISTORY_WIDTH = 340;

/** The uncommitted changes' row in the graph: its files' history is HEAD's. */
const UNCOMMITTED = "*";

/** Only the desktop bundle carries these (ADR-0031); only `--vscode-*`
 *  variables the desktop theme gives (`apps/desktop/tests/theme.test.ts`).
 *  Over the graph as the diff viewer is, and at its level: between the
 *  graph's floating layers (300) and its dialog's backing (400). */
const STYLES = `
body.fileHistoryOpen { --ging-file-history-width: ${FILE_HISTORY_WIDTH}px; }
#fileHistory {
  position: fixed; top: 0; bottom: 0; left: var(--ging-side-view-width, 0px); width: ${FILE_HISTORY_WIDTH}px;
  box-sizing: border-box; z-index: 350; display: flex; flex-direction: column;
  background: var(--vscode-editorWidget-background); color: var(--vscode-foreground);
  border-right: 1px solid var(--vscode-panel-border);
  font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
}
#fileHistory[hidden] { display: none; }
#fileHistory:focus { outline: none; }
#fileHistory .fhHeader { display: flex; align-items: flex-start; gap: 6px; padding: 6px 6px 6px 12px; flex: 0 0 auto; border-bottom: 1px solid var(--vscode-panel-border); }
#fileHistory .fhHeading { flex: 1 1 auto; min-width: 0; }
#fileHistory .fhTitle { margin: 0; font-size: 11px; font-weight: 600; text-transform: uppercase; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#fileHistory .fhPath { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#fileHistory .fhClose {
  display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; flex: 0 0 auto;
  border: 0; border-radius: 4px; background: transparent; color: inherit; cursor: pointer;
}
#fileHistory .fhClose svg { fill: currentColor; width: 14px; height: 14px; }
#fileHistory .fhClose:hover { background: var(--vscode-toolbar-hoverBackground); }
#fileHistory button:focus-visible, #fileHistory .fhEntry:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
#fileHistory .fhList { flex: 1 1 auto; overflow: auto; margin: 0; padding: 0; list-style: none; }
#fileHistory .fhEntry { padding: 4px 8px 4px 12px; cursor: pointer; border-bottom: 1px solid var(--vscode-panel-border); }
#fileHistory .fhEntry:hover { background: var(--vscode-list-hoverBackground); }
#fileHistory .fhEntry[aria-selected="true"] { background: var(--vscode-list-inactiveSelectionBackground); }
#fileHistory .fhEntry[aria-disabled="true"] { cursor: default; }
#fileHistory .fhSubject { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#fileHistory .fhMeta, #fileHistory .fhNote { color: var(--vscode-descriptionForeground); font-size: 0.9em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#fileHistory .fhHash { font-family: var(--vscode-editor-font-family); }
#fileHistory .fhFooter { flex: 0 0 auto; padding: 6px 12px; }
#fileHistory .fhFooter:empty { display: none; }
#fileHistory .fhMore {
  padding: 2px 8px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px;
  color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); cursor: pointer; font: inherit;
}
#fileHistory .fhMore:hover:not([aria-disabled="true"]) { background: var(--vscode-button-secondaryHoverBackground); }
#fileHistory .fhMore[aria-disabled="true"] { opacity: 0.5; cursor: default; }
#fileHistory .fhEmpty { padding: 8px 12px; color: var(--vscode-descriptionForeground); }
#fileHistory .fhError { padding: 8px 12px; color: var(--vscode-errorForeground); white-space: pre-wrap; overflow-wrap: anywhere; }
#fileHistory .fhError:empty { display: none; }
`;

const post = (message: FileHistoryRequest) =>
  // Cast as the working tree panel's are: the host API is typed for the
  // graph's requests, and the panel's stay out of that protocol.
  (vscode.postMessage as unknown as (m: FileHistoryRequest) => void)(message);

/** `template` with `{0}`, `{1}` filled in, in one pass. */
function fill(template: string, ...args: string[]): string {
  return template.replace(/\{(\d)\}/g, (whole, i: string) => args[Number(i)] ?? whole);
}

const abbrev = (hash: string) => hash.slice(0, 7);

/** The history shown: what it is of, and how far it has been read. */
type Shown = {
  /** The `fileHistoryOpen` it answers; null for one the host opened. */
  request: number | null;
  path: string;
  start: string | null;
  entries: FileHistoryEntry[];
  more: boolean;
  error: string | null;
};

export type FileHistoryPanelDeps = {
  /** The graph's date, as it writes one: seconds since the epoch. */
  formatDate: (seconds: number) => string;
};

export type FileHistoryPanel = {
  /** Open on `path`'s history from commit `start` (HEAD when null), and ask
   *  the host for it. */
  open(path: string, start: string | null): void;
  /** A message the host sent: a page of a history, or the words alone. */
  receive(message: FileHistoryHostMessage): void;
  /** The CDV menu item's words; null until the host has said them. */
  menuItem(): string | null;
  close(): void;
};

export function createFileHistoryPanel(deps: FileHistoryPanelDeps): FileHistoryPanel {
  let parts: ReturnType<typeof build> | null = null;
  let shown: Shown | null = null;
  let strings: FileHistoryStrings | null = null;
  /** A page is asked for and not yet here. */
  let loading = false;
  /** The last `fileHistoryOpen` sent. */
  let requests = 0;
  /** The one whose first page is waited for; null when none is — after the
   *  first page came, or once the host opened a history of its own, which
   *  supersedes every one asked for before it. */
  let waitingFor: number | null = null;
  /** The entry whose diff was last asked for, by its hash. */
  let selected: string | null = null;
  /** What had the keyboard before the panel opened. */
  let returnFocus: Element | null = null;
  /** As the diff viewer's: Escape closes on its way up, not down, or its
   *  going up reaches the graph, which closes its CDV on it. */
  let escapeDown = false;

  function build() {
    const style = document.createElement("style");
    style.textContent = STYLES;
    document.head.append(style);

    const panel = document.createElement("section");
    panel.id = "fileHistory";
    panel.hidden = true;
    panel.tabIndex = -1;
    panel.setAttribute("aria-labelledby", "fileHistoryTitle");

    const header = document.createElement("div");
    header.className = "fhHeader";
    const heading = document.createElement("div");
    heading.className = "fhHeading";
    const title = document.createElement("h2");
    title.id = "fileHistoryTitle";
    title.className = "fhTitle";
    const where = document.createElement("div");
    where.className = "fhPath";
    heading.append(title, where);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "fhClose";
    close.innerHTML = svgIcons.close;
    close.addEventListener("click", () => closePanel());
    header.append(heading, close);

    const error = document.createElement("div");
    error.className = "fhError";
    error.setAttribute("role", "alert");
    const list = document.createElement("ul");
    list.className = "fhList";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-labelledby", "fileHistoryTitle");
    const footer = document.createElement("div");
    footer.className = "fhFooter";
    panel.append(header, error, list, footer);

    list.addEventListener("click", (e) => {
      const row = (e.target as Element).closest<HTMLElement>(".fhEntry");
      if (row !== null) openDiff(row);
    });
    footer.addEventListener("click", (e) => {
      if ((e.target as Element).closest(".fhMore") !== null) loadMore();
    });
    panel.addEventListener("keydown", (e) => {
      keydown(e);
      e.stopPropagation();
    });
    panel.addEventListener("keyup", (e) => {
      if (e.key === "Escape" && escapeDown) {
        escapeDown = false;
        closePanel();
      }
      e.stopPropagation();
    });

    document.body.append(panel);
    return { panel, title, where, close, error, list, footer };
  }

  const rows = (): HTMLElement[] =>
    parts === null ? [] : Array.from(parts.list.querySelectorAll<HTMLElement>(".fhEntry"));

  /** One tab stop in the list: `row`, which also takes the keyboard. */
  function focusRow(row: HTMLElement) {
    for (const other of rows()) other.tabIndex = other === row ? 0 : -1;
    row.focus();
  }

  function keydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (!e.defaultPrevented) {
        e.preventDefault();
        escapeDown = true;
      }
      return;
    }
    const row = (e.target as Element).closest?.<HTMLElement>(".fhEntry") ?? null;
    if (row === null) return;
    const all = rows();
    const at = all.indexOf(row);
    const to =
      e.key === "ArrowDown"
        ? all[at + 1]
        : e.key === "ArrowUp"
          ? all[at - 1]
          : e.key === "Home"
            ? all[0]
            : e.key === "End"
              ? all.at(-1)
              : undefined;
    if (to !== undefined) {
      e.preventDefault();
      focusRow(to);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openDiff(row);
    }
  }

  function entryOf(row: HTMLElement): FileHistoryEntry | undefined {
    return shown?.entries[Number(row.dataset.index)];
  }

  function openDiff(row: HTMLElement) {
    const entry = entryOf(row);
    if (entry === undefined || entry.submodule !== null) return;
    selected = entry.hash;
    for (const other of rows()) other.setAttribute("aria-selected", String(other === row));
    focusRow(row);
    const { hash, change, path, oldPath, submodule } = entry;
    post({ command: "fileHistoryDiff", entry: { hash, change, path, oldPath, submodule } });
  }

  function loadMore() {
    if (shown === null || !shown.more || loading) return;
    loading = true;
    draw();
    post({ command: "fileHistoryMore", request: shown.request });
  }

  /** What an entry says of the file beyond its commit: how the commit
   *  changed it, when that is more than a change, and the path it had. */
  function noteOf(entry: FileHistoryEntry, s: FileHistoryStrings, path: string): string {
    if (entry.submodule !== null) {
      const side = (sha: string | null) => (sha === null ? "—" : abbrev(sha));
      return fill(s.submodule, side(entry.submodule.from), side(entry.submodule.to));
    }
    const notes: string[] = [];
    if (entry.parents.length > 1) notes.push(s.merge);
    if (entry.change === "R") notes.push(fill(s.renamedFrom, entry.oldPath));
    else if (entry.change === "C") notes.push(fill(s.copiedFrom, entry.oldPath));
    else if (entry.change === "A") notes.push(s.added);
    else if (entry.change === "D") notes.push(s.deleted);
    if (entry.path !== path && entry.change !== "R" && entry.change !== "C") {
      notes.push(fill(s.asPath, entry.path));
    }
    return notes.join(" · ");
  }

  function rowOf(entry: FileHistoryEntry, index: number, s: FileHistoryStrings, path: string) {
    const row = document.createElement("li");
    row.className = "fhEntry";
    row.setAttribute("role", "option");
    row.dataset.index = String(index);
    row.dataset.hash = entry.hash;
    row.tabIndex = -1;
    row.setAttribute("aria-selected", String(entry.hash === selected));
    if (entry.submodule !== null) row.setAttribute("aria-disabled", "true");
    const subject = document.createElement("div");
    subject.className = "fhSubject";
    subject.textContent = entry.subject;
    subject.title = entry.subject;
    const meta = document.createElement("div");
    meta.className = "fhMeta";
    const hash = document.createElement("span");
    hash.className = "fhHash";
    hash.textContent = abbrev(entry.hash);
    meta.append(hash, ` · ${entry.author} · ${deps.formatDate(entry.date)}`);
    row.append(subject, meta);
    const note = noteOf(entry, s, path);
    if (note !== "") {
      const line = document.createElement("div");
      line.className = "fhNote";
      line.textContent = note;
      line.title = note;
      row.append(line);
    }
    return row;
  }

  /** Draw `shown` anew, the keyboard kept on the entry it was on. */
  function draw() {
    if (parts === null || shown === null || strings === null) return;
    const p = parts;
    const s = strings;
    const { path, start, entries, more: hasMore, error } = shown;
    const name = path.split("/").at(-1) ?? path;
    p.title.textContent = fill(s.title, name);
    p.title.title = path;
    p.where.textContent = start === null ? path : `${path} · ${fill(s.upTo, abbrev(start))}`;
    p.where.title = p.where.textContent;
    p.close.title = s.close;
    p.close.setAttribute("aria-label", s.close);
    p.error.textContent = error ?? "";

    const focused = p.list.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.hash
      : undefined;
    const stop =
      rows().find((row) => row.tabIndex === 0)?.dataset.hash ?? selected ?? entries[0]?.hash;
    p.list.replaceChildren(...entries.map((entry, i) => rowOf(entry, i, s, path)));
    const all = rows();
    const stopRow = all.find((row) => row.dataset.hash === stop) ?? all[0];
    if (stopRow !== undefined) stopRow.tabIndex = 0;
    if (focused !== undefined) all.find((row) => row.dataset.hash === focused)?.focus();

    const empty = entries.length === 0 && error === null && !loading && !hasMore;
    if (empty) {
      const line = document.createElement("li");
      line.className = "fhEmpty";
      line.textContent = s.empty;
      p.list.append(line);
    }
    const hadKeyboard = p.footer.contains(document.activeElement);
    p.footer.replaceChildren();
    if (hasMore) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "fhMore";
      more.textContent = s.loadMore;
      // Not `disabled`, which would take the keyboard off it as it is pressed.
      if (loading) more.setAttribute("aria-disabled", "true");
      p.footer.append(more);
      if (hadKeyboard) more.focus();
    } else if (hadKeyboard) {
      (all.at(-1) ?? p.panel).focus();
    }
    if (loading) p.panel.setAttribute("aria-busy", "true");
    else p.panel.removeAttribute("aria-busy");
  }

  function show() {
    parts ??= build();
    if (parts.panel.hidden) {
      returnFocus = document.activeElement;
      parts.panel.hidden = false;
      document.body.classList.add("fileHistoryOpen");
    }
  }

  function closePanel() {
    if (parts === null || parts.panel.hidden) return;
    escapeDown = false;
    const back = returnFocus;
    returnFocus = null;
    if (back instanceof HTMLElement && back.isConnected) back.focus();
    if (parts.panel.contains(document.activeElement)) {
      (document.activeElement as HTMLElement).blur();
    }
    parts.panel.hidden = true;
    document.body.classList.remove("fileHistoryOpen");
    // What a later page of it would add to is gone, and so is its git.
    shown = null;
    loading = false;
    waitingFor = null;
    post({ command: "fileHistoryClose" });
  }

  return {
    open(path, start) {
      if (strings === null) return;
      show();
      const request = ++requests;
      waitingFor = request;
      shown = { request, path, start, entries: [], more: false, error: null };
      selected = null;
      loading = true;
      draw();
      parts!.panel.focus();
      post({ command: "fileHistoryOpen", request, path, start });
    },
    receive(message) {
      strings = message.strings;
      if (message.command === "fileHistoryStrings") return;
      const { request, path, start, first, entries, more, error } = message;
      if (first) {
        // The latest one opened, or one the host opened itself, which
        // supersedes every one asked for before it. A first page of an older
        // one — its git slower than the next one's — is not shown over it.
        if (request !== null && request !== waitingFor) return;
        waitingFor = null;
        const opening = parts === null || parts.panel.hidden;
        show();
        if (shown === null || shown.path !== path || shown.start !== start) selected = null;
        shown = { request, path, start, entries, more, error };
        loading = false;
        draw();
        if (opening || parts!.panel === document.activeElement) {
          (rows().find((row) => row.tabIndex === 0) ?? parts!.panel).focus();
        }
        return;
      }
      // The page after the one shown, of the history shown, asked for; anything
      // else is an answer to a history since closed or replaced.
      if (shown === null || shown.request !== request || waitingFor !== null || !loading) return;
      shown = {
        ...shown,
        entries: error === null ? [...shown.entries, ...entries] : shown.entries,
        more: error === null ? more : shown.more,
        error
      };
      loading = false;
      draw();
    },
    close: closePanel,
    menuItem: () => strings?.menuItem ?? null
  };
}

/**
 * Start the file history panel on the graph's page: listen for the host's
 * messages, offer the history in each Commit Details View file's context menu
 * once the host has said in what words, and tell the host the page listens.
 */
export function startFileHistoryPanel(
  graph: Pick<GraphInPage, "addCdvFileMenuItems">,
  deps: FileHistoryPanelDeps
): FileHistoryPanel {
  const panel = createFileHistoryPanel(deps);
  window.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data;
    if (isFileHistoryHostMessage(data)) panel.receive(data);
  });
  graph.addCdvFileMenuItems((file: CdvFileMenuTarget) => {
    const menuItem = panel.menuItem();
    // A stash's untracked file is kept in the stash's third parent, not in a
    // history of its own: nothing to offer.
    if (menuItem === null || file.origin === "untracked") return [];
    const start = file.commitHash === UNCOMMITTED ? null : file.commitHash;
    return [{ title: menuItem, icon: "history", onClick: () => panel.open(file.filePath, start) }];
  });
  post({ command: "fileHistoryReady" });
  return panel;
}
