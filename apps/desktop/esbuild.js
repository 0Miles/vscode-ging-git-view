const fs = require("node:fs");
const path = require("node:path");

const esbuild = require("esbuild");

const production = process.argv.includes("--production");

// The desktop entry of the webview (ADR-0031) and its stylesheet, found
// through the package's `exports` as apps/vscode/esbuild.js finds its own.
const webviewMain = require.resolve("@ging/webview/desktop/main");
const webviewCss = require.resolve("@ging/webview/media/main.css");

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: "warning"
};

async function main() {
  await Promise.all([
    // The main process and the preload: Node-side, Electron supplied at runtime.
    esbuild.build({
      ...common,
      entryPoints: { main: "src/main.ts", preload: "src/preload.ts" },
      format: "cjs",
      platform: "node",
      target: "es2022",
      outdir: "out",
      external: ["electron"]
    }),
    // The page's bundle, built as the extension builds its own (es6, iife), so
    // both hosts run the same code.
    esbuild.build({
      ...common,
      entryPoints: [webviewMain],
      format: "iife",
      target: "es6",
      outfile: "out/web.js"
    })
  ]);
  fs.copyFileSync(webviewCss, path.join("out", "main.css"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
