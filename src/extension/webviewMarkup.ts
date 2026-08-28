import type { LocalizedStrings } from "./webviewL10n";

/**
 * The static markup of the loaded graph view: everything inside <body> except
 * the bootstrap <script> tags that buildWebviewHtml appends after it.
 *
 * Kept as a pure function (no vscode imports) so the webview test setup can
 * render the exact DOM the extension ships — the tests' HTML and the real
 * webview's HTML have one source and cannot silently diverge.
 */
export function buildWebviewMarkup(l10n: LocalizedStrings): string {
  return `<div id="controls">
      <div id="controlsLeft">
        <div id="repoDropdown">
          <div id="repoTitle">
            <span id="repoTitleName"></span>
            <span id="repoTitleChevron"></span>
          </div>
          <ul id="repoDropdownList" role="listbox" tabindex="-1"></ul>
        </div>
        <span id="repoTitleBranch"></span>
        <div id="branchFilterChip">
          <span id="branchFilterIcon"></span>
          <span id="branchFilterText"></span>
          <div id="branchFilterClear" title="${l10n.showAll}"></div>
        </div>
      </div>
      <div id="findBtn" class="iconBtn" title="${l10n.find}"></div>
      <div id="terminalBtn" class="iconBtn" title="${l10n.openTerminal}"></div>
      <div id="blinkHeadBtn" class="iconBtn" title="${l10n.locateHead}"></div>
      <div id="fetchBtn" class="iconBtn" title="${l10n.fetch}"></div>
      <div id="refreshBtn" class="iconBtn" title="${l10n.refresh}"></div>
    </div>
    <div id="conflictBanner"></div>
    <div id="content">
      <div id="commitGraph"></div>
      <div id="commitTable"></div>
    </div>
    <!-- tabindex="-1" so focus can be *put* here without Tab ever stopping
         here: the footer's controls are rewritten wholesale on every redraw,
         and this is where focus waits when the one it was on is gone (#82). -->
    <div id="footer" tabindex="-1"></div>
    <div id="findWidget">
      <input id="findInput" type="text" placeholder="${l10n.findPlaceholder}">
      <span id="findCount"></span>
      <div id="findPrev" class="findBtn" title="${l10n.findPrevious}">&#9650;</div>
      <div id="findNext" class="findBtn" title="${l10n.findNext}">&#9660;</div>
      <div id="findOpenCdv" class="findBtn" title="${l10n.findOpenCommitDetails}">&#9776;</div>
      <div id="findClose" class="findBtn" title="${l10n.findClose}">&#10005;</div>
    </div>
    <ul id="contextMenu" role="menu" tabindex="-1"></ul>
    <div id="dialogBacking"></div>
    <div id="dialog"></div>
    <div id="scrollShadow"></div>`;
}
