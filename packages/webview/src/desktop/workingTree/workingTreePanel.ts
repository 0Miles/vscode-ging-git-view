/* The working tree panel (#403): the desktop graph page's right-hand column
 * (ADR-0031's layout), listing what is staged, what is not and what is in
 * conflict, staging and unstaging whole files, and committing what is staged.
 * Every change is the host's to make; the panel only asks, and draws the
 * status each answer brings back. */

import type { WorkingTreeFile, WorkingTreeStatus } from "@ging/shared/backend/types";
import { escapeHtml } from "@ging/webview/utils/html";
import { svgIcons } from "@ging/webview/utils/icons";
import { vscode } from "@ging/webview/utils/vscode";

import {
  isWorkingTreeMessage,
  type WorkingTreeRequest,
  type WorkingTreeStatusMessage,
  type WorkingTreeStrings
} from "./protocol";

/** The column's width, which `body` gives up on its right while it is open. */
export const WORKING_TREE_WIDTH = 320;

/** Whether the panel was open, kept per viewer across reloads and restarts. */
const OPEN_KEY = "ging.workingTree.open";

/** Only the desktop bundle carries these, so they live here rather than in
 *  `media/main.css`, which ships in the extension too (ADR-0031). The column
 *  owns `body`'s right padding; the docked Commit Details View, the scroll
 *  shadow and the find widget step back from it. */
const STYLES = `
body.workingTreeOpen { padding-right: ${WORKING_TREE_WIDTH}px; }
body.workingTreeOpen #commitDetails.docked { right: ${WORKING_TREE_WIDTH}px; }
body.workingTreeOpen #scrollShadow.active { width: calc(100% - ${WORKING_TREE_WIDTH}px); }
body.workingTreeOpen #findWidget { right: ${WORKING_TREE_WIDTH + 14}px; }
#workingTree {
  position: fixed; top: 0; right: 0; bottom: 0; width: ${WORKING_TREE_WIDTH}px; box-sizing: border-box;
  display: flex; flex-direction: column; z-index: 90;
  background: var(--vscode-editorWidget-background); color: var(--vscode-foreground);
  border-left: 1px solid var(--vscode-panel-border);
  font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
}
#workingTree[hidden] { display: none; }
#workingTree .wtHeader {
  display: flex; align-items: center; gap: 6px; padding: 6px 6px 6px 12px; flex: 0 0 auto;
  font-weight: 600; text-transform: uppercase; font-size: 11px;
}
#workingTree .wtTitle { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#workingTree .wtBranch { font-weight: normal; text-transform: none; color: var(--vscode-descriptionForeground); }
#workingTree .wtIconButton {
  display: flex; align-items: center; justify-content: center; min-width: 20px; height: 20px; padding: 0 4px;
  border: 0; border-radius: 4px; background: transparent; color: inherit; cursor: pointer; flex: 0 0 auto;
  font: inherit; font-weight: normal; text-transform: none;
}
#workingTree .wtIconButton svg { fill: currentColor; width: 12px; height: 12px; }
#workingTree .wtIconButton:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
#workingTree .wtIconButton:disabled { color: var(--vscode-disabledForeground); cursor: default; }
#workingTree button:focus-visible, #workingTree textarea:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
#workingTree .wtCommit { display: flex; flex-direction: column; gap: 6px; padding: 0 12px 8px; flex: 0 0 auto; }
#workingTree textarea {
  resize: vertical; min-height: 54px; box-sizing: border-box; width: 100%; padding: 4px 6px;
  font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
}
#workingTree textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
#workingTree .wtCommitButton {
  padding: 4px 8px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px;
  color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; font: inherit;
}
#workingTree .wtCommitButton:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
#workingTree .wtCommitButton:disabled { opacity: 0.5; cursor: default; }
#workingTree .wtError { color: var(--vscode-errorForeground); white-space: pre-wrap; overflow-wrap: anywhere; }
#workingTree .wtError:empty { display: none; }
#workingTree .wtLists { flex: 1 1 auto; overflow: auto; padding-bottom: 8px; }
#workingTree .wtGroupHeader {
  display: flex; align-items: center; gap: 4px; padding: 4px 6px 4px 12px; font-weight: 600; font-size: 11px;
  text-transform: uppercase;
}
#workingTree .wtGroupTitle { flex: 1 1 auto; }
#workingTree .wtCount { color: var(--vscode-descriptionForeground); font-weight: normal; }
#workingTree .wtFile { display: flex; align-items: center; gap: 6px; padding: 1px 6px 1px 20px; line-height: 22px; }
#workingTree .wtFile:hover { background: var(--vscode-list-hoverBackground); }
#workingTree .wtName { flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#workingTree .wtDir { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
#workingTree .wtFile .wtIconButton { visibility: hidden; }
#workingTree .wtFile:hover .wtIconButton, #workingTree .wtFile:focus-within .wtIconButton { visibility: visible; }
#workingTree .wtLetter { flex: 0 0 auto; width: 12px; text-align: center; font-weight: 600; }
#workingTree .wtLetter.added, #workingTree .wtLetter.copied { color: var(--vscode-gitDecoration-addedResourceForeground); }
#workingTree .wtLetter.modified, #workingTree .wtLetter.renamed, #workingTree .wtLetter.typeChanged { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
#workingTree .wtLetter.deleted { color: var(--vscode-gitDecoration-deletedResourceForeground); }
#workingTree .wtLetter.untracked { color: var(--vscode-gitDecoration-untrackedResourceForeground); }
#workingTree .wtLetter.conflicted { color: var(--vscode-errorForeground); }
#workingTree .wtClean { padding: 4px 12px; color: var(--vscode-descriptionForeground); }
`;

/** The letter each change is drawn as, as `git status --short` writes it. */
const LETTERS: Record<WorkingTreeFile["change"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typeChanged: "T",
  untracked: "U",
  conflicted: "!"
};

const post = (message: WorkingTreeRequest) =>
  // Cast as the host prompt replies are (desktop/main.ts): the host API is
  // typed for the graph's requests, and the panel's stay out of that protocol.
  (vscode.postMessage as unknown as (m: WorkingTreeRequest) => void)(message);

/** The paths that name `file` in the index: a staged rename by both its ends. */
function pathsOf(file: WorkingTreeFile): string[] {
  return file.oldPath === undefined ? [file.path] : [file.path, file.oldPath];
}

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "true";
  } catch {
    return false;
  }
}

function writeOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, String(open));
  } catch {
    // Only a convenience: the panel opens closed next time.
  }
}

type Area = "staged" | "unstaged" | "conflicted";

export type WorkingTreePanelOptions = {
  /**
   * Show the change to `file` in `area` (#404's diff viewer, which is not
   * here yet). The panel's file rows are clickable only once it is given.
   */
  showDiff?: (file: WorkingTreeFile, area: Area) => void;
};

/**
 * Start the panel on a graph page: closed or open as the viewer last left it,
 * opened by the host (`workingTreeShow`, the graph's Open Source Control View),
 * read anew whenever the graph is told to refresh.
 */
export function startWorkingTreePanel(options: WorkingTreePanelOptions = {}): void {
  const style = document.createElement("style");
  style.textContent = STYLES;
  document.head.appendChild(style);

  const panel = document.createElement("aside");
  panel.id = "workingTree";
  panel.hidden = true;
  document.body.appendChild(panel);

  let strings: WorkingTreeStrings | null = null;
  let status: WorkingTreeStatus | null = null;
  let error: string | null = null;
  /** A request is out: the buttons wait for its answer. */
  let busy = false;
  /** The graph refreshed while a request was out: read again once it is in. */
  let stale = false;
  /** The commit message, kept across redraws. */
  let message = "";

  const send = (request: WorkingTreeRequest) => {
    busy = true;
    error = null;
    render();
    post(request);
  };
  const load = () => {
    if (busy) stale = true;
    else send({ command: "workingTreeLoad" });
  };

  const setOpen = (open: boolean) => {
    panel.hidden = !open;
    document.body.classList.toggle("workingTreeOpen", open);
    writeOpen(open);
    if (open) load();
  };

  /** The rows of `area`, each with its button, or none for a conflict. */
  const fileRows = (files: WorkingTreeFile[], area: Area, s: WorkingTreeStrings) =>
    files
      .map((file, index) => {
        const slash = file.path.lastIndexOf("/");
        const name = file.path.slice(slash + 1);
        const dir = slash === -1 ? "" : file.path.slice(0, slash);
        const action =
          area === "staged"
            ? `<button class="wtIconButton" type="button" data-action="unstage" title="${escapeHtml(s.unstage)}" aria-label="${escapeHtml(s.unstage)}"${busy ? " disabled" : ""}>&minus;</button>`
            : area === "unstaged"
              ? `<button class="wtIconButton" type="button" data-action="stage" title="${escapeHtml(s.stage)}" aria-label="${escapeHtml(s.stage)}"${busy ? " disabled" : ""}>+</button>`
              : "";
        const tooltip = file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}`;
        return `<div class="wtFile" role="listitem" data-area="${area}" data-index="${index}" data-path="${escapeHtml(file.path)}" title="${escapeHtml(tooltip)}"${options.showDiff ? ' tabindex="0"' : ""}><span class="wtName">${escapeHtml(name)}</span><span class="wtDir">${escapeHtml(dir)}</span>${action}<span class="wtLetter ${file.change}" title="${escapeHtml(s.changes[file.change])}">${LETTERS[file.change]}</span></div>`;
      })
      .join("");

  const group = (
    area: Area,
    title: string,
    files: WorkingTreeFile[],
    all: { action: string; label: string } | null,
    s: WorkingTreeStrings
  ) =>
    files.length === 0
      ? ""
      : `<div class="wtGroup" data-area="${area}"><div class="wtGroupHeader"><span class="wtGroupTitle">${escapeHtml(title)} <span class="wtCount">${files.length}</span></span>${
          all === null
            ? ""
            : `<button class="wtIconButton" type="button" data-action="${all.action}" title="${escapeHtml(all.label)}" aria-label="${escapeHtml(all.label)}"${busy ? " disabled" : ""}>${all.action === "stageAll" ? "+" : "&minus;"}</button>`
        }</div><div role="list">${fileRows(files, area, s)}</div></div>`;

  function render(): void {
    const s = strings;
    if (s === null) return;
    // The box keeps its text, caret and focus across redraws: it is built
    // once and only moved back in.
    const box =
      panel.querySelector<HTMLTextAreaElement>("textarea") ?? document.createElement("textarea");
    const hadFocus = document.activeElement === box;
    box.placeholder = s.message;
    box.setAttribute("aria-label", s.message);
    if (box.value !== message) box.value = message;
    const staged = status?.staged ?? [];
    const lists =
      status === null
        ? ""
        : status.staged.length + status.unstaged.length + status.conflicted.length === 0
          ? `<div class="wtClean">${escapeHtml(s.clean)}</div>`
          : group("conflicted", s.conflicted, status.conflicted, null, s) +
            group(
              "staged",
              s.staged,
              status.staged,
              { action: "unstageAll", label: s.unstageAll },
              s
            ) +
            group(
              "unstaged",
              s.unstaged,
              status.unstaged,
              { action: "stageAll", label: s.stageAll },
              s
            );
    panel.innerHTML = `<div class="wtHeader"><span class="wtTitle">${escapeHtml(s.title)}${
      status?.branch ? ` <span class="wtBranch">${escapeHtml(status.branch)}</span>` : ""
    }</span><button class="wtIconButton" type="button" data-action="close" title="${escapeHtml(s.close)}" aria-label="${escapeHtml(s.close)}">${svgIcons.close}</button></div><div class="wtCommit"><button class="wtCommitButton" type="button" data-action="commit"${
      busy || staged.length === 0 || message.trim() === "" ? " disabled" : ""
    }>${escapeHtml(s.commit)}</button><div class="wtError" role="alert">${escapeHtml(error ?? "")}</div></div><div class="wtLists">${lists}</div>`;
    panel.querySelector(".wtCommit")!.prepend(box);
    if (hadFocus) box.focus();
  }

  const commit = () => {
    if (busy || (status?.staged.length ?? 0) === 0 || message.trim() === "") return;
    send({ command: "workingTreeCommit", message });
  };

  const fileOf = (row: HTMLElement): WorkingTreeFile | null => {
    const area = row.dataset.area as Area;
    return status?.[area][Number(row.dataset.index)] ?? null;
  };

  panel.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest<HTMLButtonElement>("button[data-action]") ?? null;
    if (button !== null) {
      if (button.disabled) return;
      const row = button.closest<HTMLElement>(".wtFile");
      const file = row === null ? null : fileOf(row);
      switch (button.dataset.action) {
        case "close":
          setOpen(false);
          break;
        case "commit":
          commit();
          break;
        case "stageAll":
          send({ command: "workingTreeStage", paths: null });
          break;
        case "unstageAll":
          send({ command: "workingTreeUnstage", paths: null });
          break;
        case "stage":
          if (file !== null) send({ command: "workingTreeStage", paths: pathsOf(file) });
          break;
        case "unstage":
          if (file !== null) send({ command: "workingTreeUnstage", paths: pathsOf(file) });
          break;
      }
      return;
    }
    const row = target?.closest<HTMLElement>(".wtFile") ?? null;
    const file = row === null ? null : fileOf(row);
    if (row !== null && file !== null) options.showDiff?.(file, row.dataset.area as Area);
  });
  panel.addEventListener("input", (event) => {
    if (!(event.target instanceof HTMLTextAreaElement)) return;
    message = event.target.value;
    const button = panel.querySelector<HTMLButtonElement>(".wtCommitButton");
    if (button !== null) {
      button.disabled = busy || (status?.staged.length ?? 0) === 0 || message.trim() === "";
    }
  });
  // The panel's keys are its own: the graph's document listener would take
  // the arrows, Enter and Space for its rows.
  panel.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      commit();
    }
  });

  window.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data;
    // The graph is told to refresh after every change to the repository, its
    // own or the panel's, and when the file watcher sees one.
    if ((data as { command?: unknown } | null)?.command === "refresh") {
      if (!panel.hidden) load();
      return;
    }
    if (!isWorkingTreeMessage(data)) return;
    if (data.command === "workingTreeShow") {
      if (panel.hidden) setOpen(true);
      return;
    }
    answered(data);
  });

  function answered(answer: WorkingTreeStatusMessage): void {
    strings = answer.strings;
    status = answer.status ?? status;
    error = answer.error;
    busy = false;
    if (answer.request === "workingTreeCommit" && answer.error === null) message = "";
    render();
    if (stale) {
      stale = false;
      load();
    }
  }

  if (readOpen()) setOpen(true);
}
