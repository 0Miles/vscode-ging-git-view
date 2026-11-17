const fs = require("node:fs");
const path = require("node:path");

const esbuild = require("esbuild");

// The page asks for out/web.js and out/main.css by name: PAGE_ASSETS in
// src/page.ts, which main.ts serves; and, on its first diff, for the editor's
// files: EDITOR_ASSETS in src/editorAssets.ts. Rename one, rename both.
//
// The page's bundle is the webview's desktop entry (ADR-0031) as the app
// starts it (src/web/page.ts); its stylesheet is found through the package's
// `exports`, as apps/vscode/esbuild.js finds its own.
const webviewCss = require.resolve("@ging/webview/media/main.css");
// The helpers git runs as GIT_ASKPASS and GIT_SEQUENCE_EDITOR, and the shell
// scripts that start them; the main process points git at them in out/, beside
// itself (#388), as the extension does at its own out/.
const askpassMain = require.resolve("@ging/core/extension/askpass/askpassMain");
const sequenceEditorMain =
  require.resolve("@ging/core/extension/sequenceEditor/sequenceEditorMain");
const helperScripts = [
  path.join(path.dirname(askpassMain), "askpass.sh"),
  path.join(path.dirname(askpassMain), "askpass-empty.sh"),
  path.join(path.dirname(sequenceEditorMain), "sequenceEditor.sh")
];

/** The monaco-editor package's own folder: its CommonJS entry is
 *  min/vs/index.js. */
const monacoRoot = path.resolve(path.dirname(require.resolve("monaco-editor")), "..", "..");

/**
 * `monaco-editor/esm/…` as the file of that name in the package. The
 * package's `exports` map every subpath to a `.js` under esm/vs/, so its
 * stylesheets — the codicon font's, which only its `editor.main` imports —
 * cannot be named through them.
 */
const monacoFiles = {
  name: "monaco-files",
  setup(build) {
    build.onResolve({ filter: /^monaco-editor\/esm\// }, (args) => ({
      path: path.join(monacoRoot, args.path.slice("monaco-editor/".length))
    }));
  }
};

const common = (production) => ({
  bundle: true,
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: "warning"
});

/**
 * The editors' bundle (#404): Monaco and the app's factory over it, apart
 * from the page's so that only a page showing a diff loads it. Its
 * stylesheet comes out beside it, as monaco.css, and the codicon font
 * beside that, under its own name. Exported for
 * apps/vscode/tests/backend/webviewEntries.test.ts, which checks Monaco
 * reaches this bundle and not the extension's.
 *
 * Minified, without a source map, in every build: it is nearly all Monaco's
 * own code, which nobody here debugs, and unminified it is more than twice
 * the size — seconds more for a page's first diff on a slow machine, the E2E
 * on a loaded CI runner among them. Its worker likewise.
 */
function editorsBuild() {
  return {
    ...common(true),
    entryPoints: { monaco: path.join(__dirname, "src", "web", "monacoEditors.ts") },
    format: "iife",
    target: "es2022",
    outdir: path.join(__dirname, "out"),
    loader: { ".ttf": "file" },
    assetNames: "[name]",
    plugins: [monacoFiles]
  };
}

async function main() {
  const production = process.argv.includes("--production");
  await Promise.all([
    // The main process and the preload: Node-side, Electron supplied at runtime.
    esbuild.build({
      ...common(production),
      entryPoints: { main: "src/main.ts", preload: "src/preload.ts" },
      format: "cjs",
      platform: "node",
      target: "es2022",
      outdir: "out",
      external: ["electron"]
    }),
    // The git helpers: plain Node programs, run by Electron as Node.
    esbuild.build({
      ...common(production),
      entryPoints: { askpassMain, sequenceEditorMain },
      format: "cjs",
      platform: "node",
      target: "es2022",
      outdir: "out"
    }),
    // The page's bundle, built as the extension builds its own (es6, iife), so
    // both hosts run the same code.
    esbuild.build({
      ...common(production),
      entryPoints: ["src/web/page.ts"],
      format: "iife",
      target: "es6",
      outfile: "out/web.js"
    }),
    esbuild.build(editorsBuild()),
    // Monaco's editor worker, which computes the diffs: a worker of its own,
    // minified always, as the editors' bundle is.
    esbuild.build({
      ...common(true),
      entryPoints: { "editor.worker": "monaco-editor/editor/editor.worker" },
      format: "iife",
      target: "es2022",
      outdir: "out"
    })
  ]);
  fs.copyFileSync(webviewCss, path.join("out", "main.css"));
  for (const script of helperScripts) {
    const copied = path.join("out", path.basename(script));
    fs.copyFileSync(script, copied);
    // git execs GIT_ASKPASS itself, so off Windows it must be executable. The
    // sources are checked in 644; the managers also chmod at runtime, but
    // without waiting, so the build does not leave it to that.
    fs.chmodSync(copied, 0o755);
  }
}

module.exports = { editorsBuild };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
