/* The desktop window's own page (#393): the tab strip along the top and, under
 * it, the Welcome page (GLOSSARY.md). Each Tab's page is a view of its own the
 * host lays over the Welcome page, below the strip, so this page shows through
 * only where no Tab covers it: the strip always, the Welcome page when there is
 * no Tab. What the Welcome page offers is #394's; today it says, at most, why
 * a launch opened nothing. */

import { escapeHtml } from "@ging/webview/utils/html";
import { svgIcons } from "@ging/webview/utils/icons";
import { vscode } from "@ging/webview/utils/vscode";

import {
  isWindowStateMessage,
  TAB_STRIP_HEIGHT,
  type TabStripEntry,
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
#welcome h2, #welcome p { text-align: center; }
`;

const post = (message: WindowRequest) =>
  // Cast as the host prompt replies are (desktop/main.ts): the host API is
  // typed for the graph's requests, and the window's stay out of that protocol.
  (vscode.postMessage as unknown as (m: WindowRequest) => void)(message);

function tabHtml(tab: TabStripEntry, closeTab: string): string {
  return `<div class="tab${tab.focused ? " focused" : ""}" role="tab" tabindex="${tab.focused ? 0 : -1}" aria-selected="${tab.focused}" data-tab-id="${tab.id}" title="${escapeHtml(tab.tooltip)}">${
    tab.asking ? '<span class="tabAsking"></span>' : ""
  }<span class="tabTitle">${escapeHtml(tab.title)}</span><button class="tabClose" type="button" tabindex="-1" title="${escapeHtml(closeTab)}" aria-label="${escapeHtml(closeTab)}">${svgIcons.close}</button></div>`;
}

/** Draw `state`: the strip, hidden when there is no Tab, and the Welcome page. */
function render(strip: HTMLElement, welcome: HTMLElement, state: WindowStateMessage): void {
  strip.hidden = state.tabs.length === 0;
  strip.innerHTML = state.tabs.map((tab) => tabHtml(tab, state.strings.closeTab)).join("");
  welcome.innerHTML =
    state.notice === null
      ? ""
      : `<h2>${escapeHtml(state.notice.title)}</h2><p>${escapeHtml(state.notice.detail)}</p>`;
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
  window.addEventListener("message", (event: MessageEvent) => {
    if (isWindowStateMessage(event.data)) render(strip, welcome, event.data);
  });
  post({ command: "windowReady" });
}
