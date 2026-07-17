import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

// The real vscode.setState persists state as JSON, so anything that doesn't
// survive a JSON round-trip (Map, Set, DOM elements) is silently lost. Model
// that here, otherwise tests restore live objects the real webview never gets.
function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

export function createVscodeMock(initialState: WebViewState | null = null) {
  const sent: GG.RequestMessage[] = [];
  // The real getState() yields undefined (not null) when nothing was saved —
  // model that exactly, so a boot path that only handles null fails here too.
  let state: WebViewState | undefined =
    initialState === null ? undefined : jsonRoundTrip(initialState);

  const mock = {
    postMessage: (msg: GG.RequestMessage) => sent.push(msg),
    getState: () => state,
    setState: (s: WebViewState) => {
      state = jsonRoundTrip(s);
    }
  };

  global.acquireVsCodeApi = () => mock;

  return {
    sentMessages: sent,
    clearMessages: () => sent.splice(0),
    getState: () => state
  };
}

export function setupHtml(viewState: GG.GitGraphViewState) {
  document.body.innerHTML = `
    <div id="controls">
      <div id="repoTitle">
        <span id="repoTitleName"></span>
        <span id="repoTitleBranch"></span>
      </div>
      <div id="refreshBtn" class="roundedBtn">Refresh</div>
      <div id="blinkHeadBtn" class="roundedBtn">Locate HEAD</div>
      <div id="findBtn" class="roundedBtn">Find</div>
    </div>
    <div id="content">
      <div id="commitGraph"></div>
      <div id="commitTable"></div>
    </div>
    <div id="footer"></div>
    <div id="findWidget">
      <input id="findInput" type="text">
      <span id="findCount"></span>
      <div id="findPrev" class="findBtn"></div>
      <div id="findNext" class="findBtn"></div>
      <div id="findClose" class="findBtn"></div>
    </div>
    <ul id="contextMenu"></ul>
    <div id="dialogBacking"></div>
    <div id="dialog"></div>
    <div id="scrollShadow"></div>
  `;

  (global as unknown as { viewState: GG.GitGraphViewState }).viewState = viewState;
  global["l10n"] = getWebviewLocalizedStrings();
}

export function receive(msg: GG.ResponseMessage) {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}
