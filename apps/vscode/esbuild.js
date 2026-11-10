const fs = require("node:fs");
const path = require("node:path");

const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** The workspace root, which the editor's problem matcher reads paths against. */
const REPO_ROOT = path.resolve(__dirname, "../..");

const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",
  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        // esbuild reports `location.file` against the working directory (this app);
        // the editor opens the workspace root, so name the file from there.
        const file = path.relative(REPO_ROOT, path.resolve(location.file));
        console.error(`✘ [ERROR] ${text}`);
        console.error(`    ${file}:${location.line}:${location.column}:`);
      });
      console.log("[watch] build finished");
    });
  }
};

// Entry points that live in workspace packages, found through each package's
// `exports` the same way the bundles' own imports are.
const webviewMain = require.resolve("@ging/webview/main");
const askpassMain = require.resolve("@ging/core/extension/askpass/askpassMain");
const sequenceEditorMain =
  require.resolve("@ging/core/extension/sequenceEditor/sequenceEditorMain");
const webviewCss = require.resolve("@ging/webview/media/main.css");
const l10nDir = path.dirname(require.resolve("@ging/shared/l10n/bundle.l10n.json"));

async function main() {
  const extension = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    target: "es6",
    outfile: "out/extension.js",
    external: ["vscode"],
    logLevel: "silent",
    plugins: [esbuildProblemMatcherPlugin]
  });

  const webview = await esbuild.context({
    entryPoints: [webviewMain],
    bundle: true,
    format: "iife",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    target: "es6",
    outfile: "out/web.min.js",
    logLevel: "silent",
    plugins: [esbuildProblemMatcherPlugin]
  });

  // Standalone helper git runs via GIT_ASKPASS (#114); a separate node bundle.
  const askpass = await esbuild.context({
    entryPoints: [askpassMain],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    target: "es6",
    outfile: "out/askpassMain.js",
    logLevel: "silent",
    plugins: [esbuildProblemMatcherPlugin]
  });

  // Standalone helper git runs as GIT_SEQUENCE_EDITOR; another node bundle.
  const sequenceEditor = await esbuild.context({
    entryPoints: [sequenceEditorMain],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    target: "es6",
    outfile: "out/sequenceEditorMain.js",
    logLevel: "silent",
    plugins: [esbuildProblemMatcherPlugin]
  });

  // The shell scripts git loads at runtime from out/.
  const copyAskpassScripts = () => {
    fs.mkdirSync("out", { recursive: true });
    for (const f of ["askpass.sh", "askpass-empty.sh"]) {
      fs.copyFileSync(path.join(path.dirname(askpassMain), f), path.join("out", f));
    }
    fs.copyFileSync(
      path.join(path.dirname(sequenceEditorMain), "sequenceEditor.sh"),
      path.join("out", "sequenceEditor.sh")
    );
  };

  // The webview's stylesheet lives with the webview package; the extension
  // serves it from its own media/.
  const copyWebviewCss = () => {
    fs.mkdirSync("media", { recursive: true });
    fs.copyFileSync(webviewCss, path.join("media", "main.css"));
  };

  // The l10n bundles live in the shared package; VS Code loads them at runtime
  // from the extension's own l10n/ (the manifest's `"l10n": "./l10n"`), so the
  // folder is rebuilt from them whole, and a bundle removed there goes here too.
  const copyL10n = () => {
    fs.rmSync("l10n", { recursive: true, force: true });
    fs.mkdirSync("l10n", { recursive: true });
    for (const f of fs.readdirSync(l10nDir)) {
      fs.copyFileSync(path.join(l10nDir, f), path.join("l10n", f));
    }
  };

  if (watch) {
    copyAskpassScripts();
    copyWebviewCss();
    copyL10n();
    fs.watch(webviewCss, copyWebviewCss);
    fs.watch(l10nDir, copyL10n);
    await Promise.all([
      extension.watch(),
      webview.watch(),
      askpass.watch(),
      sequenceEditor.watch()
    ]);
  } else {
    await extension.rebuild();
    await extension.dispose();
    await webview.rebuild();
    await webview.dispose();
    await askpass.rebuild();
    await askpass.dispose();
    await sequenceEditor.rebuild();
    await sequenceEditor.dispose();
    copyAskpassScripts();
    copyWebviewCss();
    copyL10n();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
