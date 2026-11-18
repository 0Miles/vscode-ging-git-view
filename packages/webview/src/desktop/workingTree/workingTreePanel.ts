/* The working tree panel (#403): the desktop graph page's right-hand column
 * (ADR-0031's layout), listing what is staged, what is not and what is in
 * conflict, staging and unstaging whole files, and committing what is staged
 * or amending the last commit, signed off or not (#407); in a conflict
 * (#410), handing a file to the user's merge tool, marking it resolved, and
 * continuing or aborting the operation in progress. Every change is the
 * host's to make; the panel only asks, and draws the status each answer
 * brings back. */

import type {
  AmendBasis,
  CommitRefusal,
  HunkArea,
  WorkingTreeFile,
  WorkingTreeStatus
} from "@ging/shared/backend/types";
import { escapeHtml } from "@ging/webview/utils/html";
import { svgIcons } from "@ging/webview/utils/icons";
import { vscode } from "@ging/webview/utils/vscode";

import {
  isWorkingTreeMessage,
  type WorkingTreeCommitRequest,
  type WorkingTreeRequest,
  type WorkingTreeStatusMessage,
  type WorkingTreeStrings
} from "./protocol";

/** The column's width, which `body` gives up on its right while it is open. */
export const WORKING_TREE_WIDTH = 320;

/** The most rows a list draws; the rest are counted under it. "Stage All" still
 *  names them all. A folder of build output nobody ignored can list thousands. */
const MAX_ROWS = 500;

/** Whether the panel was open, kept per viewer across reloads and restarts. */
const OPEN_KEY = "ging.workingTree.open";

/** Only the desktop bundle carries these, so they live here rather than in
 *  `media/main.css`, which ships in the extension too (ADR-0031). The column
 *  owns `body`'s right padding; the docked Commit Details View, the scroll
 *  shadow and the find widget step back from it, and the diff viewer by the
 *  width it is given in `--ging-working-tree-width` (#404, ADR-0031). */
const STYLES = `
body.workingTreeOpen { padding-right: ${WORKING_TREE_WIDTH}px; --ging-working-tree-width: ${WORKING_TREE_WIDTH}px; }
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
#workingTree .wtPart { display: contents; }
#workingTree .wtCommit[hidden] { display: none; }
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
#workingTree .wtIconButton:hover:not([aria-disabled="true"]) { background: var(--vscode-toolbar-hoverBackground); }
#workingTree .wtIconButton[aria-disabled="true"] { color: var(--vscode-disabledForeground); cursor: default; }
#workingTree button:focus-visible, #workingTree textarea:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
#workingTree .wtCommit { display: flex; flex-direction: column; gap: 6px; padding: 0 12px 8px; flex: 0 0 auto; }
#workingTree textarea {
  resize: vertical; min-height: 54px; box-sizing: border-box; width: 100%; padding: 4px 6px;
  font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
}
#workingTree textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
#workingTree .wtOptions { display: flex; flex-wrap: wrap; gap: 2px 12px; }
#workingTree .wtOption { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
#workingTree .wtOption input { margin: 0; accent-color: var(--vscode-focusBorder); cursor: inherit; }
#workingTree .wtOption:has(input:disabled) { color: var(--vscode-disabledForeground); cursor: default; }
#workingTree .wtCommitButton {
  padding: 4px 8px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px;
  color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; font: inherit;
}
#workingTree .wtCommitButton:hover:not([aria-disabled="true"]) { background: var(--vscode-button-hoverBackground); }
#workingTree .wtCommitButton[aria-disabled="true"] { opacity: 0.5; cursor: default; }
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
#workingTree .wtFile.opensDiff { cursor: pointer; }
#workingTree .wtFile:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
#workingTree .wtName { flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#workingTree .wtDir { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
#workingTree .wtFile .wtIconButton { opacity: 0; }
#workingTree .wtFile:hover .wtIconButton, #workingTree .wtFile:focus-within .wtIconButton { opacity: 1; }
#workingTree .wtFile.submodule .wtName { font-style: italic; }
#workingTree .wtMore { padding: 1px 6px 1px 20px; line-height: 22px; color: var(--vscode-descriptionForeground); }
#workingTree .wtLetter { flex: 0 0 auto; width: 12px; text-align: center; font-weight: 600; }
#workingTree .wtLetter.added, #workingTree .wtLetter.copied { color: var(--vscode-gitDecoration-addedResourceForeground); }
#workingTree .wtLetter.modified, #workingTree .wtLetter.renamed, #workingTree .wtLetter.typeChanged { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
#workingTree .wtLetter.deleted { color: var(--vscode-gitDecoration-deletedResourceForeground); }
#workingTree .wtLetter.untracked { color: var(--vscode-gitDecoration-untrackedResourceForeground); }
#workingTree .wtLetter.conflicted { color: var(--vscode-errorForeground); }
#workingTree .wtClean { padding: 4px 12px; color: var(--vscode-descriptionForeground); }
#workingTree .wtOperation { display: flex; align-items: center; gap: 6px; padding: 0 12px 8px; flex: 0 0 auto; }
#workingTree .wtOperationTitle { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
#workingTree .wtTextButton {
  flex: 0 0 auto; padding: 2px 8px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px;
  color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); cursor: pointer; font: inherit;
}
#workingTree .wtTextButton:hover:not([aria-disabled="true"]) { background: var(--vscode-button-secondaryHoverBackground); }
#workingTree .wtTextButton[aria-disabled="true"] { opacity: 0.5; cursor: default; }
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
   * Show the change to `file` in `area` in the diff viewer (#460), where its
   * hunks are staged or unstaged (#406). The panel's file rows open it, by
   * click, Enter or Space, only once it is given — and never a conflicted
   * file's (#410's merge tool is how one is worked on) nor a submodule's,
   * which has no text to compare.
   */
  showDiff?: (file: WorkingTreeFile, area: HunkArea) => void;
  /**
   * Ask whether to go on, in the page's own dialog (#407): `html` is markup,
   * `actionName` the button that goes on, `confirmed` what it does. The
   * desktop entry gives the graph's dialog (`askInGraphDialog`). Without it,
   * nothing that needs asking is done, and why is said instead.
   */
  confirm?: (html: string, actionName: string, confirmed: () => void) => void;
};

/** A tick box under the message, `action` naming it. */
const tickBox = (action: string, on: boolean, off: boolean) =>
  `<input type="checkbox" data-action="${action}"${on ? " checked" : ""}${off ? " disabled" : ""}>`;

/** A part of the panel's frame that each draw writes anew; no box of its own
 *  in the layout (`display: contents`). */
function part(): HTMLElement {
  const div = document.createElement("div");
  div.className = "wtPart";
  return div;
}

/** How many of the remote branches a pushed HEAD is on the warning names. */
const NAMED_BRANCHES = 3;

/** The warning before amending a pushed HEAD: its template, the first few of
 *  `branches` in it. `name` writes each branch, `text` the template around
 *  them: plain text, or markup for a dialog. */
function pushedWarning(
  branches: string[],
  s: WorkingTreeStrings,
  name: (branch: string) => string,
  text: (template: string) => string = (template) => template
): string {
  const named =
    branches.slice(0, NAMED_BRANCHES).map(name).join(", ") +
    (branches.length > NAMED_BRANCHES ? ", …" : "");
  return text(s.amendPushed).replace("{0}", named);
}

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
  /** The panel's frame: the message box, which is never taken out of the
   *  page, and around it the parts each draw writes anew. Taking the box out
   *  would blur it (the keyboard lost mid-sentence, an IME composition cut
   *  short) whenever an answer or a refresh redraws the panel while the user
   *  types (#479). The parts' wrappers are `display: contents`, so the layout
   *  is the panel's children as before. The commit area stays hidden until
   *  the first draw brings the box its words. */
  const frame = {
    header: part(),
    commitArea: document.createElement("div"),
    box: document.createElement("textarea"),
    commitPart: part(),
    body: part()
  };
  frame.commitArea.className = "wtCommit";
  frame.commitArea.hidden = true;
  frame.commitArea.append(frame.box, frame.commitPart);
  panel.append(frame.header, frame.commitArea, frame.body);
  document.body.appendChild(panel);

  let strings: WorkingTreeStrings | null = null;
  let status: WorkingTreeStatus | null = null;
  /**
   * Why the last request failed, and whether it was a read or a change (#466).
   * A change's reason stays until the viewer makes the next change: the
   * graph refreshes after every change, failed or not, and the panel reads
   * itself anew then — a read that must not wipe what the viewer has yet to
   * see, nor put its own failure in its place. A read's own failure, shown
   * when no change's is, goes once a read succeeds.
   */
  let error: { text: string; from: "read" | "change" } | null = null;
  /** A request is out: the buttons wait for its answer. */
  let busy = false;
  /** The graph refreshed while a request was out: read again once it is in. */
  let stale = false;
  /** The commit message, kept across redraws. */
  let message = "";
  /** What an amend of HEAD would start from, as last read. */
  let amendBasis: AmendBasis | null = null;
  /** The Amend and Sign off tick boxes. Neither is kept past the page:
   *  signing off is a statement made to one project, and the page is every
   *  repository's. */
  let amend = false;
  let signOff = false;
  /** HEAD's message, as Amend put it into the empty box; taken back out when
   *  Amend is unticked with the box still holding it as it was. */
  let prefilled: string | null = null;
  /** The commit last asked for: an amend refused for HEAD being pushed is
   *  asked again as it was, once the user says to go on. */
  let lastCommit: WorkingTreeCommitRequest | null = null;

  const send = (request: WorkingTreeRequest) => {
    busy = true;
    if (request.command !== "workingTreeLoad") error = null;
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

  /** The files of `area` its "all" button names: every one listed but the
   *  submodules, each by every path it has in the index. */
  const allPathsOf = (files: WorkingTreeFile[]) =>
    files.filter((file) => file.submodule !== true).flatMap(pathsOf);

  /** Whether `file`'s row opens its diff (`WorkingTreePanelOptions.showDiff`). */
  const opensDiff = (file: WorkingTreeFile, area: Area): area is HunkArea =>
    options.showDiff !== undefined && area !== "conflicted" && file.submodule !== true;

  /** Open the diff of the file `row` lists, if it opens one. */
  const openRow = (row: HTMLElement) => {
    const file = fileOf(row);
    const area = row.dataset.area as Area;
    if (file !== null && opensDiff(file, area)) options.showDiff?.(file, area);
  };

  /** A button; `aria-disabled` rather than `disabled`, which would drop the
   *  keyboard's focus off it while a request is out. */
  const iconButton = (action: string, label: string, text: string, off: boolean) =>
    `<button class="wtIconButton" type="button" data-action="${action}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"${off ? ' aria-disabled="true"' : ""}>${text}</button>`;

  /** The rows of `area`, each with its button — a conflict with two: its
   *  merge tool, and marking it resolved — and a submodule with none; at most
   *  `MAX_ROWS`, the rest counted. */
  const fileRows = (files: WorkingTreeFile[], area: Area, s: WorkingTreeStrings) =>
    files
      .slice(0, MAX_ROWS)
      .map((file, index) => {
        const slash = file.path.lastIndexOf("/");
        const name = file.path.slice(slash + 1);
        const dir = slash === -1 ? "" : file.path.slice(0, slash);
        const action =
          file.submodule === true
            ? ""
            : area === "staged"
              ? iconButton("unstage", s.unstage, "&minus;", busy)
              : area === "unstaged"
                ? iconButton("stage", s.stage, "+", busy)
                : iconButton("mergeTool", s.openMergeTool, svgIcons.gitMerge, busy) +
                  iconButton("resolve", s.markResolved, svgIcons.check, busy);
        const where = file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}`;
        const tooltip = file.submodule === true ? `${where}\n${s.submodule}` : where;
        const opens = opensDiff(file, area);
        return `<div class="wtFile${file.submodule === true ? " submodule" : ""}${opens ? " opensDiff" : ""}" role="listitem" data-area="${area}" data-index="${index}" data-path="${escapeHtml(file.path)}" title="${escapeHtml(tooltip)}"${opens ? ' tabindex="0"' : ""}><span class="wtName">${escapeHtml(name)}</span><span class="wtDir">${escapeHtml(dir)}</span>${action}<span class="wtLetter ${file.change}" title="${escapeHtml(s.changes[file.change])}">${LETTERS[file.change]}</span></div>`;
      })
      .join("") +
    (files.length > MAX_ROWS
      ? `<div class="wtMore">${escapeHtml(s.more.replace("{0}", String(files.length - MAX_ROWS)))}</div>`
      : "");

  const group = (
    area: Area,
    title: string,
    files: WorkingTreeFile[],
    all: { action: string; label: string; text: string } | null,
    s: WorkingTreeStrings
  ) =>
    files.length === 0
      ? ""
      : `<div class="wtGroup" data-area="${area}"><div class="wtGroupHeader"><span class="wtGroupTitle">${escapeHtml(title)} <span class="wtCount">${files.length}</span></span>${
          all === null ? "" : iconButton(all.action, all.label, all.text, busy)
        }</div><div role="list">${fileRows(files, area, s)}</div></div>`;

  /** Nothing to commit, or nothing to commit with. An amend needs nothing
   *  staged: it may change the message alone. */
  const cannotCommit = () =>
    busy ||
    message.trim() === "" ||
    (amend ? amendBasis?.possible !== true : (status?.staged.length ?? 0) === 0);

  /** Tick or untick Amend: an empty box takes HEAD's message to start from,
   *  and gives it back when unticked untouched. What the user wrote stays. */
  const setAmend = (on: boolean) => {
    amend = on;
    if (on && message.trim() === "" && amendBasis?.possible === true) {
      message = amendBasis.message;
      prefilled = message;
    } else if (!on) {
      if (prefilled !== null && message === prefilled) message = "";
      prefilled = null;
    }
  };

  /** The tick boxes under the message. Amend is off, its tooltip saying why,
   *  when HEAD cannot be amended. */
  const tickBoxes = (s: WorkingTreeStrings) => {
    const reason = amendBasis?.possible === false ? s.cannotAmend[amendBasis.reason] : null;
    return `<div class="wtOptions"><label class="wtOption"${
      reason === null ? "" : ` title="${escapeHtml(reason)}"`
    }>${tickBox("amend", amend, amendBasis?.possible !== true)}<span>${escapeHtml(s.amend)}</span></label><label class="wtOption" title="${escapeHtml(s.signOffDetail)}">${tickBox("signOff", signOff, false)}<span>${escapeHtml(s.signOff)}</span></label></div>`;
  };

  /** What a refusal says in the panel; a pushed HEAD is asked about instead. */
  const refusalText = (refused: CommitRefusal, s: WorkingTreeStrings) => {
    switch (refused.kind) {
      case "pushed":
        return pushedWarning(refused.remoteBranches, s, (name) => name);
      case "cannotAmend":
        return s.cannotAmend[refused.reason];
      case "identityUnknown":
        return s.identityUnknown;
    }
  };

  /** A text button; `aria-disabled` for the reason `iconButton`'s is. */
  const textButton = (action: string, label: string, off: boolean) =>
    `<button class="wtTextButton" type="button" data-action="${action}"${off ? ' aria-disabled="true"' : ""}>${escapeHtml(label)}</button>`;

  /** The merge, rebase, cherry-pick or revert in progress (#410), to continue
   *  once no conflict is left, or to abort. */
  const operationBar = (s: WorkingTreeStrings) => {
    const operation = status?.operation;
    if (operation === undefined) return "";
    const title = s.inProgress.replace("{0}", s.operations[operation]);
    const conflicts = status?.conflicted.length ?? 0;
    return `<div class="wtOperation" role="status"><span class="wtOperationTitle" title="${escapeHtml(title)}">${escapeHtml(title)}</span>${textButton(
      "continue",
      s.continue,
      busy || conflicts > 0
    )}${textButton("abort", s.abort, busy)}</div>`;
  };

  /** Where the keyboard is in the panel, so a redraw can put it back. */
  type FocusAt = { action: string; area: string | null; path: string | null; index: number };
  const focusAt = (): FocusAt | null => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !panel.contains(active)) return null;
    const row = active.closest<HTMLElement>(".wtFile");
    return {
      action: active.dataset.action ?? (row === active ? "row" : ""),
      area: active.closest<HTMLElement>("[data-area]")?.dataset.area ?? null,
      path: row?.dataset.path ?? null,
      index: Number(row?.dataset.index ?? -1)
    };
  };
  /** The keyboard back where it was: the same button on the same file; with
   *  that file gone from its list (staged, say), the same button on the file
   *  that took its place, or the list's own; failing those, the first
   *  button left in the lists. */
  const refocus = (at: FocusAt) => {
    const inArea = (selector: string) =>
      Array.from(panel.querySelectorAll<HTMLElement>(`[data-area="${at.area}"] ${selector}`));
    const onRow = (row: HTMLElement | undefined) =>
      row === undefined
        ? null
        : at.action === "row"
          ? row
          : row.querySelector<HTMLElement>(`[data-action="${at.action}"]`);
    const rows = inArea(".wtFile");
    const target =
      (at.path === null
        ? panel.querySelector<HTMLElement>(
            at.area === null
              ? `[data-action="${at.action}"]`
              : `[data-area="${at.area}"] .wtGroupHeader [data-action="${at.action}"]`
          )
        : (onRow(rows.find((row) => row.dataset.path === at.path)) ??
          onRow(rows[Math.min(at.index, rows.length - 1)]) ??
          inArea(".wtGroupHeader button")[0])) ??
      panel.querySelector<HTMLElement>(".wtLists button") ??
      panel.querySelector<HTMLElement>("textarea");
    target?.focus();
  };

  function render(): void {
    const s = strings;
    if (s === null) return;
    const at = focusAt();
    const { header, box, commitArea, commitPart, body } = frame;
    commitArea.hidden = false;
    box.placeholder = s.message;
    box.setAttribute("aria-label", s.message);
    if (box.value !== message) box.value = message;
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
              { action: "unstageAll", label: s.unstageAll, text: "&minus;" },
              s
            ) +
            group(
              "unstaged",
              s.unstaged,
              status.unstaged,
              { action: "stageAll", label: s.stageAll, text: "+" },
              s
            );
    header.innerHTML = `<div class="wtHeader"><span class="wtTitle">${escapeHtml(s.title)}${
      status?.branch ? ` <span class="wtBranch">${escapeHtml(status.branch)}</span>` : ""
    }</span>${iconButton("close", s.close, svgIcons.close, false)}</div>`;
    commitPart.innerHTML = `${tickBoxes(s)}<button class="wtCommitButton" id="wtCommitButton" type="button" data-action="commit"${
      cannotCommit() ? ' aria-disabled="true"' : ""
    }>${escapeHtml(amend ? s.amendCommit : s.commit)}</button><div class="wtError" role="alert">${escapeHtml(error?.text ?? "")}</div>`;
    body.innerHTML = `${operationBar(s)}<div class="wtLists">${lists}</div>`;
    // Only what the draw took away is given the keyboard back: the message
    // box, never taken away, keeps it, its caret and selection untouched.
    if (at !== null && !panel.contains(document.activeElement)) refocus(at);
  }

  const commit = () => {
    if (cannotCommit()) return;
    lastCommit = {
      command: "workingTreeCommit",
      message,
      ...(amend && { amend: true as const }),
      ...(signOff && { signOff: true as const })
    };
    send(lastCommit);
  };

  /** An amend refused for HEAD, commit `head`, being on `remoteBranches`:
   *  ask, and ask the host again as it was, now to rewrite that commit, once
   *  the user says so. The question may wait behind another dialog; should
   *  HEAD have moved by the answer, the host refuses again and this asks
   *  about the new one. */
  const askToRewrite = (head: string, remoteBranches: string[], s: WorkingTreeStrings) => {
    const refusedCommit = lastCommit;
    // Nowhere to ask: said instead (`answered`), and left undone.
    if (refusedCommit === null || options.confirm === undefined) return;
    options.confirm(
      pushedWarning(remoteBranches, s, (name) => `<b>${escapeHtml(name)}</b>`, escapeHtml),
      s.amendPushedConfirm,
      () => {
        lastCommit = { ...refusedCommit, rewritePushed: head };
        send(lastCommit);
      }
    );
  };

  const fileOf = (row: HTMLElement): WorkingTreeFile | null => {
    const area = row.dataset.area as Area;
    return status?.[area][Number(row.dataset.index)] ?? null;
  };

  /** Ask for `paths`, when there are any. */
  const sendPaths = (
    command: "workingTreeStage" | "workingTreeUnstage" | "workingTreeResolve",
    paths: string[]
  ) => {
    if (paths.length > 0) send({ command, paths });
  };

  panel.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest<HTMLButtonElement>("button[data-action]") ?? null;
    if (button !== null) {
      if (button.getAttribute("aria-disabled") === "true") return;
      const row = button.closest<HTMLElement>(".wtFile");
      const file = row === null ? null : fileOf(row);
      switch (button.dataset.action) {
        case "close":
          setOpen(false);
          break;
        case "commit":
          commit();
          break;
        // Every file listed, by name: never "everything", which would take
        // in the conflicted files too (#410's).
        case "stageAll":
          sendPaths("workingTreeStage", allPathsOf(status?.unstaged ?? []));
          break;
        case "unstageAll":
          sendPaths("workingTreeUnstage", allPathsOf(status?.staged ?? []));
          break;
        case "stage":
          if (file !== null) sendPaths("workingTreeStage", pathsOf(file));
          break;
        case "unstage":
          if (file !== null) sendPaths("workingTreeUnstage", pathsOf(file));
          break;
        // A conflicted file's (#410).
        case "mergeTool":
          if (file !== null) send({ command: "workingTreeMergeTool", path: file.path });
          break;
        case "resolve":
          if (file !== null) sendPaths("workingTreeResolve", [file.path]);
          break;
        case "continue":
          send({ command: "workingTreeContinue" });
          break;
        case "abort":
          send({ command: "workingTreeAbort" });
          break;
      }
      return;
    }
    const row = target?.closest<HTMLElement>(".wtFile") ?? null;
    if (row !== null) openRow(row);
  });
  panel.addEventListener("change", (event) => {
    const box = event.target;
    if (!(box instanceof HTMLInputElement) || box.type !== "checkbox") return;
    if (box.dataset.action === "amend") setAmend(box.checked);
    else if (box.dataset.action === "signOff") signOff = box.checked;
    else return;
    render();
  });
  panel.addEventListener("input", (event) => {
    if (!(event.target instanceof HTMLTextAreaElement)) return;
    message = event.target.value;
    const button = panel.querySelector<HTMLButtonElement>(".wtCommitButton");
    if (button === null) return;
    if (cannotCommit()) button.setAttribute("aria-disabled", "true");
    else button.removeAttribute("aria-disabled");
  });
  // The panel's keys are its own: the graph's document listener would take
  // the arrows, Enter and Space for its rows.
  panel.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      commit();
      return;
    }
    // A row with the keyboard on it opens as a click does; not on keys
    // pressed on its buttons, which are theirs.
    const row = event.target instanceof HTMLElement ? event.target : null;
    if ((event.key === "Enter" || event.key === " ") && row?.classList.contains("opensDiff")) {
      event.preventDefault();
      openRow(row);
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
    const s = answer.strings;
    strings = s;
    status = answer.status ?? status;
    // Unreadable this time: what was last read stands, as for the status.
    amendBasis = answer.amend ?? amendBasis;
    if (answer.request !== "workingTreeLoad") {
      error = answer.error === null ? null : { text: answer.error, from: "change" };
    } else if (error?.from !== "change") {
      // A change's failure stays through every read, a failed one included:
      // it is what the viewer has yet to see.
      error = answer.error === null ? null : { text: answer.error, from: "read" };
    }
    busy = false;
    const refused = answer.refused;
    if (answer.request === "workingTreeCommit" && error === null && refused === undefined) {
      // Made: the box is empty for the next one, which is a commit again.
      message = "";
      prefilled = null;
      amend = false;
    }
    // HEAD can no longer be amended (an operation began, say): unticked, as
    // the user would have to.
    if (amend && amendBasis?.possible === false) setAmend(false);
    // HEAD moved while the box still held its old message untouched: the new
    // HEAD's, as ticking Amend now would give.
    if (
      amend &&
      amendBasis?.possible === true &&
      prefilled !== null &&
      message === prefilled &&
      amendBasis.message !== prefilled
    ) {
      message = amendBasis.message;
      prefilled = message;
    }
    const pushed = refused?.kind === "pushed" ? refused : null;
    // Said in the panel, unless it is a question to ask, and there is a way to.
    if (refused !== undefined && (pushed === null || options.confirm === undefined)) {
      error = { text: refusalText(refused, s), from: "change" };
    }
    render();
    // Asked after the redraw, so the dialog takes the keyboard from where it
    // was and gives it back there.
    if (pushed !== null) askToRewrite(pushed.head, pushed.remoteBranches, s);
    if (stale) {
      stale = false;
      load();
    }
  }

  if (readOpen()) setOpen(true);
}
