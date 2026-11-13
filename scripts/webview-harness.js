// @ts-check
/**
 * Local webview rendering harness for visual / layout verification, and the
 * page the webview E2E (e2e/webview) drives.
 *
 * The GING webview is plain HTML/CSS/JS, but jsdom (used by the unit
 * tests) does no layout, so CSS / positioning / SVG changes can't be verified
 * there. This script builds a self-contained page that loads a *real* webview
 * bundle with mock VS Code theme variables, a mock
 * `viewState`/`l10n`/`acquireVsCodeApi`, and sample commit data, so it can be
 * opened in a real browser (manually, or via Playwright) to inspect computed
 * styles and take screenshots.
 *
 * The page loads one of the webview's two entries (ADR-0031):
 *   --entry=vscode   (the default) apps/vscode/out/web.min.js, the bundle the
 *                    extension ships, so `pnpm run compile` has to run first.
 *   --entry=desktop  packages/webview/src/desktop/main.ts, bundled here: no app
 *                    builds it yet (apps/desktop, #386).
 *
 * Usage:
 *   pnpm run compile                                  # for --entry=vscode
 *   node scripts/webview-harness.js [--entry=desktop] # writes out/webview-harness/<entry>/
 *   (cd out/webview-harness/vscode && python3 -m http.server 8771)
 *   open http://localhost:8771/                       # or file://, or drive with Playwright
 *
 * Edit SAMPLE_COMMITS, HOST_ANSWERS, or the overrides passed to makeViewState
 * in buildWebviewHarness, below to exercise specific scenarios.
 */

const fs = require("node:fs");
const path = require("node:path");

// The package's entry by path: the root tsconfig's `baseUrl` would otherwise
// resolve a bare "esbuild" to the repo's own esbuild.js for the typecheck.
const esbuild = require("esbuild/lib/main.js");

const ROOT = path.resolve(__dirname, "..");
const APP = path.join(ROOT, "apps", "vscode");
const WEBVIEW = path.join(ROOT, "packages", "webview");
const OUT = path.join(ROOT, "out", "webview-harness");

/** @typedef {"vscode" | "desktop"} HarnessEntry */

/** @type {readonly HarnessEntry[]} */
const ENTRIES = ["vscode", "desktop"];

/** @typedef {import("../packages/shared/src/types").ResponseMessage} ResponseMessage */
/** @typedef {import("../packages/shared/src/backend/types/git.types").GitCommitNode} GitCommitNode */

/**
 * The host's answer to one request, as written here: the response message
 * without its `command`, which the page takes from the request, and without the
 * `hard` and `token` the page copies off the request, as the real host does.
 *
 * @template {ResponseMessage["command"]} C
 * @typedef {Omit<Extract<ResponseMessage, { command: C }>, "command" | "hard" | "token">} HostAnswer
 */

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

/** @type {GitCommitNode[]} */
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

/**
 * The host's half: each load request the webview posts is answered with the
 * entry for its command, and the answer echoes the request's `hard` and
 * `token` as the real host does (messageHandler.ts). Seeding unasked-for
 * answers instead is what drew 0 rows once the webview began dropping answers
 * whose token is not the navigation it is on (#84, #235); taking the token off
 * the request keeps it right however the webview comes to number its
 * navigations.
 *
 * Typed by ResponseMessage, so an answer the protocol no longer accepts fails
 * the typecheck instead of drawing an empty table.
 *
 * @type {{ [C in ResponseMessage["command"]]?: HostAnswer<C> }}
 */
const HOST_ANSWERS = {
  loadRemotes: { remotes: ["origin"], pushDefault: null },
  loadBranches: {
    branches: ["main", "feature/long-branch-name"],
    head: "main",
    isRepo: true,
    filter: [],
    dimmedBranches: []
  },
  loadCommits: { commits: SAMPLE_COMMITS, head: "aaaaaaa1", moreCommitsAvailable: false }
};

/**
 * The webview suites' viewState fixture, loaded rather than copied so the two
 * cannot drift (issue #76). It is TypeScript importing the workspace packages,
 * so esbuild bundles it into the harness output (resolving them from the
 * webview package's node_modules) and node requires the bundle.
 *
 * @param {string} out
 * @returns {typeof import("../packages/webview/tests/viewStateFixture")}
 */
function loadViewStateFixture(out) {
  const outfile = path.join(out, "viewStateFixture.cjs");
  esbuild.buildSync({
    entryPoints: [path.join(WEBVIEW, "tests", "viewStateFixture.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile,
    logLevel: "silent"
  });
  return require(outfile);
}

/**
 * The palette a user who never touched `ging-git-view.graph.palette` gets,
 * read from the manifest that ships it. The fixture's single colour is enough
 * for the suites, but every graph column here would draw in it.
 *
 * @returns {string[]}
 */
function shippedPalette() {
  const manifest = JSON.parse(fs.readFileSync(path.join(APP, "package.json"), "utf8"));
  return manifest.contributes.configuration.properties["ging-git-view.graph.palette"].default;
}

/**
 * Puts the entry's bundle at `out/webview.js` and its stylesheet at
 * `out/main.css`.
 *
 * @param {HarnessEntry} entry
 * @param {string} out
 */
function placeEntryBundle(entry, out) {
  if (entry === "vscode") {
    // Both come out of the extension's compile: the bundle and the stylesheet it serves.
    const bundle = path.join(APP, "out", "web.min.js");
    if (!fs.existsSync(bundle)) {
      throw new Error(bundle + " is missing; run `pnpm run compile` first.");
    }
    fs.copyFileSync(bundle, path.join(out, "webview.js"));
    fs.copyFileSync(path.join(APP, "media", "main.css"), path.join(out, "main.css"));
  } else {
    // The options apps/vscode/esbuild.js builds the VS Code entry with.
    esbuild.buildSync({
      entryPoints: [path.join(WEBVIEW, "src", "desktop", "main.ts")],
      bundle: true,
      format: "iife",
      target: "es6",
      outfile: path.join(out, "webview.js"),
      logLevel: "silent"
    });
    fs.copyFileSync(path.join(WEBVIEW, "media", "main.css"), path.join(out, "main.css"));
  }
}

/**
 * Writes the harness page for one webview entry to
 * out/webview-harness/<entry>/index.html, a folder per entry so the two pages
 * can be built side by side. The E2E opens it at that path.
 *
 * @param {HarnessEntry} entry
 * @returns {string} The page's absolute path.
 */
function buildWebviewHarness(entry) {
  const out = path.join(OUT, entry);
  fs.mkdirSync(out, { recursive: true });

  // Only where the harness deliberately departs from the fixture is spelled out.
  const viewState = loadViewStateFixture(out).makeViewState({
    graphColours: shippedPalette(),
    // Commit subjects render as they ship, with Markdown on.
    markdown: true,
    // A static page has nothing to answer the extra loadCommits a scroll would send.
    loadMoreAutomatically: false
  });

  const rootVars = Object.entries(THEME_VARS)
    .map(([k, v]) => `${k}:${v};`)
    .join("");

  // Mirror buildWebviewHtml: per-column graph colour variables on <body>, plus
  // the [data-color] → --git-graph-color mapping the graph SVG relies on.
  let colorVars = "",
    colorParams = "";
  for (let i = 0; i < viewState.graphColours.length; i++) {
    colorVars += "--git-graph-color" + i + ":" + viewState.graphColours[i] + "; ";
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
    window.viewState = ${JSON.stringify(viewState)};
    // HOST_ANSWERS in scripts/webview-harness.js says how these are answered.
    // Every request is kept on window.harnessRequests for drivers to read.
    const HOST_ANSWERS = ${JSON.stringify(HOST_ANSWERS)};
    window.harnessRequests = [];
    window.acquireVsCodeApi = () => ({
      postMessage(msg) {
        window.harnessRequests.push(msg);
        const answer = HOST_ANSWERS[msg.command];
        if (answer === undefined) return;
        const data = { command: msg.command, ...answer };
        if ("token" in msg) Object.assign(data, { hard: msg.hard, token: msg.token });
        // Asynchronous, as from the real host, but a microtask so the answers
        // have landed before the page's load event.
        queueMicrotask(() => window.dispatchEvent(new MessageEvent("message", { data })));
      },
      getState() { return null; },
      setState() {}
    });
  </script>
  <script src="./webview.js"></script>
  <script>
    // Guard against silently-dropped answers (issues #14, #235): the whole point
    // of this harness is to render commit rows, so an empty table is a failure.
    window.addEventListener("load", () => {
      if (document.querySelectorAll("#commitTable tr.commit").length === 0) {
        console.error(
          "webview-harness: no tr.commit rows rendered; the webview requested: " +
          (window.harnessRequests.map((m) => m.command).join(", ") || "nothing") +
          ". The answers are probably out of sync with ResponseMessage in packages/shared/src/types.ts"
        );
      }
    });
  </script>
</body>
</html>`;

  placeEntryBundle(entry, out);
  const index = path.join(out, "index.html");
  fs.writeFileSync(index, html);
  return index;
}

/**
 * @param {string} value
 * @returns {value is HarnessEntry}
 */
function isHarnessEntry(value) {
  return /** @type {readonly string[]} */ (ENTRIES).includes(value);
}

const flag = process.argv.slice(2).find((a) => a.startsWith("--entry="));
const entry = flag === undefined ? "vscode" : flag.slice("--entry=".length);
if (!isHarnessEntry(entry)) {
  process.stderr.write(`Unknown --entry "${entry}"; expected one of: ${ENTRIES.join(", ")}.\n`);
  process.exit(1);
}
process.stdout.write(
  "Wrote " +
    buildWebviewHarness(entry) +
    " — serve it (python3 -m http.server) and open in a browser.\n"
);
