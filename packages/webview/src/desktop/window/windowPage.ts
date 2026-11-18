/* The desktop window's own page (#393): the tab strip along the top and, under
 * it, the Welcome page (GLOSSARY.md). Each Tab's page is a view of its own the
 * host lays over the Welcome page, below the strip, so this page shows through
 * only where no Tab covers it: the strip always, the Welcome page when there is
 * no Tab. The Welcome page (#394) says why a launch opened nothing, if it did
 * not, and offers Open Folder, Clone Repository (#395), Initialize Repository
 * and the recently opened list; each is only asked of the host, which does the
 * rest. A clone running is shown over it, with a way to cancel it. */

import { postToHost } from "@ging/webview/desktop/postToHost";
import { escapeHtml } from "@ging/webview/utils/html";
import { svgIcons } from "@ging/webview/utils/icons";

import {
  type ClonePanel,
  isWindowStateMessage,
  type RecentRepoEntry,
  TAB_STRIP_HEIGHT,
  type TabStripEntry,
  type WelcomeContent,
  type WindowRequest,
  type WindowStateMessage
} from "./protocol";

/** Only the desktop bundle carries these, so they live here rather than in
 *  `media/main.css`, which ships in the extension too (ADR-0031). The strip is
 *  `TAB_STRIP_HEIGHT` tall whatever it holds: the host lays the Tabs' views
 *  out by that number, not by measuring the page. */
const STYLES = `
body.windowPage { margin: 0; padding: 0; overflow: hidden; }
#tabStrip {
  position: fixed; top: 0; left: 0; right: 0; height: ${TAB_STRIP_HEIGHT}px; box-sizing: border-box;
  display: flex; align-items: stretch; overflow-x: auto; overflow-y: hidden;
  background: var(--vscode-editorWidget-background); border-bottom: 1px solid var(--vscode-panel-border);
  user-select: none;
}
#tabStrip[hidden] { display: none; }
.tab {
  display: flex; align-items: center; gap: 6px; max-width: 220px; min-width: 80px; padding: 0 6px 0 12px;
  border-right: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground);
  cursor: pointer; box-sizing: border-box; flex: 0 0 auto;
}
.tab:hover { background: var(--vscode-toolbar-hoverBackground); }
.tab.focused { background: var(--vscode-editor-background); color: var(--vscode-foreground); box-shadow: inset 0 2px 0 var(--vscode-focusBorder); }
.tab:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.tabTitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; }
.tabAsking { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-editorWarning-foreground); flex: 0 0 auto; }
.tabClose {
  display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0;
  border: 0; border-radius: 4px; background: transparent; color: inherit; cursor: pointer; flex: 0 0 auto;
}
.tabClose svg { fill: currentColor; width: 12px; height: 12px; }
.tabClose:hover { background: var(--vscode-toolbar-hoverBackground); }
#tabStrip { z-index: 1; }
#welcome { position: fixed; inset: 0; overflow: auto; padding: 0 20px; }
.welcomeBody { max-width: 640px; margin: 48px auto; }
.welcomeBody > h2, .welcomeBody > p { text-align: center; }
.welcomeBody > p { margin-bottom: 24px; }
.welcomeActions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
.welcomeAction {
  display: flex; align-items: center; gap: 6px; padding: 6px 14px; border-radius: 2px; cursor: pointer;
  border: 1px solid var(--vscode-button-border); font: inherit;
  background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
}
.welcomeAction:hover { background: var(--vscode-button-secondaryHoverBackground); }
.welcomeAction:focus-visible, .recentOpen:focus-visible, .recentForget:focus-visible {
  outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px;
}
.welcomeAction svg { fill: currentColor; width: 16px; height: 16px; }
.recent h3 { margin: 32px 0 8px; font-size: 1em; font-weight: 600; }
.recentList { list-style: none; margin: 0; padding: 0; }
.recentRepo { display: flex; align-items: center; border-radius: 2px; }
.recentRepo:hover { background: var(--vscode-list-hoverBackground); }
.recentOpen {
  display: flex; align-items: baseline; gap: 8px; flex: 1 1 auto; min-width: 0; padding: 4px 6px;
  border: 0; background: transparent; color: var(--vscode-textLink-foreground); font: inherit; text-align: left; cursor: pointer;
}
.recentName { flex: 0 0 auto; }
.recentPath {
  flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--vscode-descriptionForeground);
}
.recentRepo.missing .recentName { color: var(--vscode-descriptionForeground); text-decoration: line-through; }
.recentMissing { flex: 0 0 auto; color: var(--vscode-errorForeground); }
.recentForget {
  display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; margin-right: 4px;
  border: 0; border-radius: 4px; background: transparent; color: var(--vscode-descriptionForeground); cursor: pointer; flex: 0 0 auto;
}
.recentForget svg { fill: currentColor; width: 12px; height: 12px; }
.recentForget:hover { background: var(--vscode-toolbar-hoverBackground); }
.recentEmpty { color: var(--vscode-descriptionForeground); }
#clonePanel {
  position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; padding: 0 20px;
  background: var(--vscode-editor-background);
}
#clonePanel[hidden] { display: none; }
.cloneBox {
  width: 100%; max-width: 520px; box-sizing: border-box; padding: 16px 20px;
  background: var(--vscode-editorWidget-background); color: var(--vscode-editorWidget-foreground);
  border: 1px solid var(--vscode-widget-border); border-radius: 4px; box-shadow: 0 0 8px 2px var(--vscode-widget-shadow);
}
.cloneTitle { margin: 0 0 4px; font-size: 1em; font-weight: 600; overflow-wrap: anywhere; }
.cloneFolder, .cloneStage { color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
.cloneStage { margin-top: 6px; min-height: 1.4em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cloneBar { position: relative; height: 4px; margin-top: 12px; overflow: hidden; border-radius: 2px; background: var(--vscode-widget-border); }
.cloneBarFill { position: absolute; top: 0; bottom: 0; left: 0; background: var(--vscode-button-background); }
.cloneBar.indeterminate .cloneBarFill { width: 30%; animation: cloneSweep 1.2s ease-in-out infinite; }
@keyframes cloneSweep { from { left: -30%; } to { left: 100%; } }
.cloneButtons { display: flex; justify-content: flex-end; margin-top: 16px; }
.cloneCancel:disabled { cursor: default; opacity: 0.6; }
`;

const post: (message: WindowRequest) => void = postToHost;

function tabHtml(tab: TabStripEntry, closeTab: string): string {
  return `<div class="tab${tab.focused ? " focused" : ""}" role="tab" tabindex="${tab.focused ? 0 : -1}" aria-selected="${tab.focused}" data-tab-id="${tab.id}" title="${escapeHtml(tab.tooltip)}">${
    tab.asking ? '<span class="tabAsking"></span>' : ""
  }<span class="tabTitle">${escapeHtml(tab.title)}</span><button class="tabClose" type="button" tabindex="-1" title="${escapeHtml(closeTab)}" aria-label="${escapeHtml(closeTab)}">${svgIcons.close}</button></div>`;
}

function recentHtml(repo: RecentRepoEntry, strings: WelcomeContent["strings"]): string {
  const path = escapeHtml(repo.path);
  return `<li class="recentRepo${repo.missing ? " missing" : ""}"><button class="recentOpen" type="button" data-path="${path}" title="${path}"><span class="recentName">${escapeHtml(repo.name)}</span><span class="recentPath">${path}</span>${
    repo.missing ? `<span class="recentMissing">${escapeHtml(strings.missing)}</span>` : ""
  }</button><button class="recentForget" type="button" data-path="${path}" title="${escapeHtml(strings.forget)}" aria-label="${escapeHtml(strings.forget)}">${svgIcons.close}</button></li>`;
}

/** The Welcome page's entries and its recent list. */
function welcomeHtml({ recent, strings }: WelcomeContent): string {
  const action = (command: string, icon: string, label: string) =>
    `<button class="welcomeAction" type="button" data-welcome="${command}">${icon}<span>${escapeHtml(label)}</span></button>`;
  return `<div class="welcomeActions">${action("openFolder", svgIcons.openFolder, strings.openFolder)}${action("cloneRepo", svgIcons.download, strings.cloneRepo)}${action("initRepo", svgIcons.branch, strings.initRepo)}</div><section class="recent"><h3>${escapeHtml(strings.recent)}</h3>${
    recent.length === 0
      ? `<p class="recentEmpty">${escapeHtml(strings.noRecent)}</p>`
      : `<ul class="recentList">${recent.map((repo) => recentHtml(repo, strings)).join("")}</ul>`
  }</section>`;
}

/** Draw `state`: the strip, hidden when there is no Tab, and the Welcome page:
 *  why a launch opened nothing, if it did not, over what it offers. */
function render(strip: HTMLElement, welcome: HTMLElement, state: WindowStateMessage): void {
  strip.hidden = state.tabs.length === 0;
  strip.innerHTML = state.tabs.map((tab) => tabHtml(tab, state.strings.closeTab)).join("");
  const notice =
    state.notice === null
      ? ""
      : `<h2>${escapeHtml(state.notice.title)}</h2><p>${escapeHtml(state.notice.detail)}</p>`;
  const offers = state.welcome ? welcomeHtml(state.welcome) : "";
  welcome.innerHTML =
    notice === "" && offers === "" ? "" : `<div class="welcomeBody">${notice}${offers}</div>`;
}

/** The clone panel's parts (#395). Made once and changed in place as the
 *  clone goes, never drawn anew: the Cancel button being pressed must be the
 *  one still there when the press ends, and progress comes several times a
 *  second. */
type ClonePanelParts = {
  root: HTMLElement;
  title: HTMLElement;
  folder: HTMLElement;
  bar: HTMLElement;
  fill: HTMLElement;
  stage: HTMLElement;
  cancel: HTMLButtonElement;
};

function createClonePanel(): ClonePanelParts {
  const root = document.createElement("div");
  root.id = "clonePanel";
  root.hidden = true;
  root.innerHTML =
    '<div class="cloneBox" role="dialog" aria-modal="true" aria-labelledby="cloneTitle">' +
    '<h3 class="cloneTitle" id="cloneTitle"></h3><div class="cloneFolder"></div>' +
    '<div class="cloneBar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-labelledby="cloneTitle"><div class="cloneBarFill"></div></div>' +
    '<div class="cloneStage" aria-live="polite"></div>' +
    '<div class="cloneButtons"><button class="welcomeAction cloneCancel" type="button"></button></div></div>';
  const part = (selector: string) => root.querySelector<HTMLElement>(selector)!;
  return {
    root,
    title: part(".cloneTitle"),
    folder: part(".cloneFolder"),
    bar: part(".cloneBar"),
    fill: part(".cloneBarFill"),
    stage: part(".cloneStage"),
    cancel: part(".cloneCancel") as HTMLButtonElement
  };
}

/** Show the clone running over the Welcome page, or put the panel away with
 *  none. The Welcome page behind it takes no clicks meanwhile: one clone at a
 *  time, and nothing else opened from under it. */
function showClonePanel(parts: ClonePanelParts, welcome: HTMLElement, panel: ClonePanel | null) {
  const appearing = parts.root.hidden && panel !== null;
  parts.root.hidden = panel === null;
  welcome.inert = panel !== null;
  if (panel === null) return;
  parts.title.textContent = panel.title;
  parts.folder.textContent = panel.folder;
  parts.stage.textContent = panel.stage;
  parts.stage.title = panel.stage;
  parts.bar.classList.toggle("indeterminate", panel.percent === null);
  if (panel.percent === null) {
    parts.fill.style.removeProperty("width");
    parts.bar.removeAttribute("aria-valuenow");
  } else {
    parts.fill.style.width = `${panel.percent}%`;
    parts.bar.setAttribute("aria-valuenow", String(panel.percent));
  }
  parts.cancel.textContent = panel.cancel;
  parts.cancel.disabled = panel.cancelling;
  // Where the keyboard goes once the folder dialog has closed: to the way out.
  if (appearing) parts.cancel.focus();
}

/** What a click in the Welcome page asks of the host, if anything. */
function welcomeRequest(target: EventTarget | null): WindowRequest | null {
  if (!(target instanceof Element)) return null;
  const action = target.closest<HTMLElement>("[data-welcome]")?.dataset.welcome;
  if (action === "openFolder" || action === "cloneRepo" || action === "initRepo") {
    return { command: action };
  }
  const forget = target.closest<HTMLElement>(".recentForget")?.dataset.path;
  if (forget !== undefined) return { command: "forgetRecent", path: forget };
  const open = target.closest<HTMLElement>(".recentOpen")?.dataset.path;
  if (open !== undefined) return { command: "openRecent", path: open };
  return null;
}

/** The Tab whose strip entry `target` is in, by id. */
function tabIdOf(target: EventTarget | null): number | null {
  const tab = target instanceof Element ? target.closest<HTMLElement>(".tab") : null;
  return tab === null ? null : Number(tab.dataset.tabId);
}

/**
 * Start the window's page in `strip` and `welcome`: draw what the host sends,
 * and tell it which Tab was clicked or closed. A click on a Tab only asks for
 * it; the strip changes when the host says it has.
 */
export function startWindowPage(strip: HTMLElement, welcome: HTMLElement): void {
  const style = document.createElement("style");
  style.textContent = STYLES;
  document.head.appendChild(style);
  document.body.classList.add("windowPage");
  strip.setAttribute("role", "tablist");

  strip.addEventListener("click", (event) => {
    const id = tabIdOf(event.target);
    if (id === null) return;
    const closing = event.target instanceof Element && event.target.closest(".tabClose") !== null;
    post({ command: closing ? "closeTab" : "focusTab", id });
  });
  // A middle click closes a Tab, as in a browser's tab strip.
  strip.addEventListener("auxclick", (event) => {
    const id = tabIdOf(event.target);
    if (id !== null && event.button === 1) post({ command: "closeTab", id });
  });
  strip.addEventListener("keydown", (event) => {
    const id = tabIdOf(event.target);
    if (id === null || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    post({ command: "focusTab", id });
  });
  // The Welcome page's buttons, as the strip's Tabs are: asked, not done.
  welcome.addEventListener("click", (event) => {
    const request = welcomeRequest(event.target);
    if (request !== null) post(request);
  });
  const clonePanel = createClonePanel();
  welcome.after(clonePanel.root);
  clonePanel.cancel.addEventListener("click", () => post({ command: "cancelClone" }));
  window.addEventListener("message", (event: MessageEvent) => {
    if (!isWindowStateMessage(event.data)) return;
    render(strip, welcome, event.data);
    showClonePanel(clonePanel, welcome, event.data.clone ?? null);
  });
  post({ command: "windowReady" });
}
