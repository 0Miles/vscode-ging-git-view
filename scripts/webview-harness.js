/**
 * Local webview rendering harness for visual / layout verification.
 *
 * The GING webview is plain HTML/CSS/JS, but jsdom (used by the unit
 * tests) does no layout, so CSS / positioning / SVG changes can't be verified
 * there. This script builds a self-contained page that loads the *real* built
 * webview bundle (out/web.min.js) with mock VS Code theme variables, a mock
 * `viewState`/`l10n`/`acquireVsCodeApi`, and sample commit data, so it can be
 * opened in a real browser (manually, or via Playwright) to inspect computed
 * styles and take screenshots.
 *
 * Usage:
 *   node esbuild.js                       # build out/web.min.js first
 *   node scripts/webview-harness.js       # writes out/webview-harness/
 *   (cd out/webview-harness && python3 -m http.server 8771)
 *   open http://localhost:8771/           # or drive with Playwright
 *
 * Edit SAMPLE_COMMITS / VIEW_STATE below to exercise specific scenarios.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "out", "webview-harness");

// Stub VS Code theme variables the webview CSS reads (a dark-theme-ish palette).
const THEME_VARS = {
  "--vscode-descriptionForeground": "#9d9d9d",
  "--vscode-editor-background": "#1e1e1e",
  "--vscode-editor-font-family": "monospace",
  "--vscode-editor-foreground": "#d4d4d4",
  "--vscode-editorWidget-background": "#252526",
  "--vscode-errorForeground": "#f48771",
  "--vscode-gitDecoration-addedResourceForeground": "#81b88b",
  "--vscode-gitDecoration-deletedResourceForeground": "#c74e39",
  "--vscode-gitDecoration-modifiedResourceForeground": "#e2c08d",
  "--vscode-gitDecoration-untrackedResourceForeground": "#73c991",
  "--vscode-input-background": "#3c3c3c",
  "--vscode-input-foreground": "#cccccc",
  "--vscode-dropdown-background": "#3c3c3c",
  "--vscode-dropdown-foreground": "#f0f0f0",
  "--vscode-dropdown-border": "#3c3c3c",
  "--vscode-checkbox-background": "#3c3c3c",
  "--vscode-checkbox-foreground": "#f0f0f0",
  "--vscode-checkbox-border": "#6b6b6b",
  "--vscode-checkbox-selectBackground": "#0e639c",
  "--vscode-button-background": "#0e639c",
  "--vscode-button-foreground": "#ffffff",
  "--vscode-menu-background": "#252526",
  "--vscode-menu-foreground": "#cccccc",
  "--vscode-menu-selectionBackground": "#094771",
  "--vscode-menu-selectionForeground": "#ffffff",
  "--vscode-menu-separatorBackground": "#454545",
  "--vscode-scrollbar-shadow": "#000000",
  "--vscode-selection-background": "#264f78",
  "--vscode-widget-shadow": "#000000"
};

const REPO = "/workspace/demo";

const VIEW_STATE = {
  autoCenterCommitDetailsView: true,
  commitDetailsViewLocation: "Inline",

  referenceLabelAlignment: "Normal",

  combineLocalAndRemoteBranchLabels: true,
  dialogDeleteBranchForceDelete: false,
  dialogCherryPickNoCommit: false,
  dialogAddTagType: "annotated",
  dialogCreateBranchCheckOut: false,
  dialogMergeNoFastForward: true,
  dialogMergeSquash: false,
  dialogResetMode: "mixed",
  customBranchGlobPatterns: [],
  // Remembered dialog options; the extension always injects this store.
  dialogMemory: {},
  // Fully-populated so every context menu renders (the extension always sends a
  // complete object; an empty {} would make `cmv.branch.x` throw).
  contextMenuActionsVisibility: {
    commit: {
      addTag: true,
      createBranch: true,
      checkout: true,
      cherrypick: true,
      revert: true,
      merge: true,
      reset: true,
      rebase: true,
      drop: true,
      copyHash: true,
      copySubject: true
    },
    branch: {
      checkout: true,
      rename: true,
      push: true,
      createArchive: true,
      delete: true,
      merge: true,
      rebase: true,
      checkRedundancy: true,
      copyName: true
    },
    remoteBranch: {
      checkout: true,
      merge: true,
      pull: true,
      fetch: true,
      delete: true,
      checkRedundancy: true,
      copyName: true
    },
    tag: { viewDetails: true, delete: true, push: true, createArchive: true, copyName: true },
    stash: { apply: true, pop: true, drop: true, copyName: true },
    uncommittedChanges: { openSourceControlView: true, reset: true, clean: true },
    commitDetailsViewFile: {
      viewDiff: true,
      viewFileAtThisRevision: true,
      viewDiffWithWorkingFile: true,
      openFile: true,
      resetFileToThisRevision: true,
      copyFilePath: true
    }
  },
  customEmojiShortcodeMappings: {},
  dateFormat: "Date & Time",
  dateCustomFormat: "DD MMM YYYY",
  defaultColumnVisibility: { date: true, author: true, commit: true },
  enhancedAccessibility: false,
  fetchAvatars: false,
  fileTreeCompactFolders: true,
  fileViewType: "File Tree",
  graphColours: ["#0085d9", "#d9008f", "#00d90a", "#d98500", "#a300d9", "#ff0000"],
  graphStyle: "rounded",
  initialLoadCommits: 300,
  issueLinkingRegex: "",
  issueLinkingUrl: "",
  keybindings: { find: "f", refresh: "r", scrollToHead: "h", scrollToStash: "s" },
  lastActiveRepo: REPO,
  loadMoreAutomatically: false,
  loadMoreCommits: 75,
  markdown: true,
  muteCommitsNotAncestorsOfHead: false,
  muteMergeCommits: true,
  onLoadScrollToHead: false,
  referenceInputSpaceSubstitution: "None",
  repos: { [REPO]: { columnWidths: null } },
  showCurrentBranchByDefault: false,

  uncommittedChangesAtHead: false,
  showSpecificBranches: [],
  showRemoteBranches: true,
  showTags: true
};

const SAMPLE_COMMITS = [
  {
    hash: "aaaaaaa1",
    parentHashes: ["bbbbbbb2"],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000300,
    message: "Add the login feature",
    refs: [
      { hash: "aaaaaaa1", name: "main", type: "head" },
      { hash: "aaaaaaa1", name: "origin/main", type: "remote" },
      { hash: "aaaaaaa1", name: "v1.2.0", type: "tag" }
    ]
  },
  {
    hash: "bbbbbbb2",
    parentHashes: ["ccccccc3"],
    author: "Bob",
    email: "bob@example.com",
    date: 1700000200,
    message: "Refactor the data layer",
    refs: [{ hash: "bbbbbbb2", name: "feature/long-branch-name", type: "head" }]
  },
  {
    hash: "ccccccc3",
    parentHashes: [],
    author: "Carol",
    email: "carol@example.com",
    date: 1700000100,
    message: "Initial commit",
    refs: []
  }
];

const rootVars = Object.entries(THEME_VARS)
  .map(([k, v]) => `${k}:${v};`)
  .join("");

// Mirror buildWebviewHtml: per-column graph colour variables on <body>, plus
// the [data-color] → --git-graph-color mapping the graph SVG relies on.
let colorVars = "",
  colorParams = "";
for (let i = 0; i < VIEW_STATE.graphColours.length; i++) {
  colorVars += "--git-graph-color" + i + ":" + VIEW_STATE.graphColours[i] + "; ";
  colorParams += '[data-color="' + i + '"]{--git-graph-color:var(--git-graph-color' + i + ");} ";
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="stylesheet" type="text/css" href="./main.css">
<style>:root{${rootVars}} html,body{height:100%;} ${colorParams}</style>
</head>
<body style="${colorVars}">
  <div id="controls">
    <div id="controlsLeft">
      <div id="repoTitle">
        <span id="repoTitleName"></span>
        <span id="repoTitleBranch"></span>
      </div>
      <div id="branchFilterChip">
        <span id="branchFilterIcon"></span>
        <span id="branchFilterText"></span>
        <div id="branchFilterClear" title="Show All"></div>
      </div>
    </div>
    <div id="findBtn" class="iconBtn" title="Find"></div>
    <div id="terminalBtn" class="iconBtn" title="Terminal"></div>
    <div id="blinkHeadBtn" class="iconBtn" title="Locate HEAD"></div>
    <div id="fetchBtn" class="iconBtn" title="Fetch"></div>
    <div id="refreshBtn" class="iconBtn" title="Refresh"></div>
  </div>
  <div id="conflictBanner"></div>
  <div id="content"><div id="commitGraph"></div><div id="commitTable"></div></div>
  <div id="footer"></div>
  <div id="findWidget"><input id="findInput" type="text"><span id="findCount"></span><div id="findPrev" class="findBtn"></div><div id="findNext" class="findBtn"></div><div id="findOpenCdv" class="findBtn">&#9776;</div><div id="findClose" class="findBtn"></div></div>
  <ul id="contextMenu" role="menu" tabindex="-1"></ul>
  <div id="dialogBacking"></div>
  <div id="dialog"></div>
  <div id="scrollShadow"></div>
  <script>
    window.l10n = new Proxy({}, { get: (_, p) => (typeof p === "string" ? p : "") });
    window.viewState = ${JSON.stringify(VIEW_STATE)};
    window.acquireVsCodeApi = () => ({ postMessage() {}, getState() { return null; }, setState() {} });
  </script>
  <script src="./web.min.js"></script>
  <script>
    const receive = (msg) => window.dispatchEvent(new MessageEvent("message", { data: msg }));
    receive({ command: "loadRemotes", remotes: ["origin"], pushDefault: null });
    receive({ command: "loadBranches", branches: ["main", "feature/long-branch-name"], head: "main", hard: true, isRepo: true, filter: [], dimmedBranches: [] });
    receive({ command: "loadCommits", commits: ${JSON.stringify(SAMPLE_COMMITS)}, head: "aaaaaaa1", moreCommitsAvailable: false, hard: true });
    // Guard against silently-dropped seed messages (issue #14): the whole point
    // of this harness is to render commit rows, so an empty table is a failure.
    if (document.querySelectorAll("tr.commit").length === 0) {
      console.error(
        "webview-harness: no tr.commit rows rendered after seeding — " +
        "the seeded messages are probably out of sync with ResponseMessage in src/types.ts"
      );
    }
  </script>
</body>
</html>`;

fs.mkdirSync(OUT, { recursive: true });
for (const f of ["main.css"]) {
  fs.copyFileSync(path.join(ROOT, "media", f), path.join(OUT, f));
}
fs.copyFileSync(path.join(ROOT, "out", "web.min.js"), path.join(OUT, "web.min.js"));
fs.writeFileSync(path.join(OUT, "index.html"), html);
process.stdout.write(
  "Wrote " + OUT + "/index.html — serve it (python3 -m http.server) and open in a browser.\n"
);
