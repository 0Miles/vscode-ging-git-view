const fs = require("node:fs");
const path = require("node:path");

const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",
  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        console.error(`    ${location.file}:${location.line}:${location.column}:`);
      });
      console.log("[watch] build finished");
    });
  }
};

const aliasPlugin = {
  name: "alias",
  setup(build) {
    build.onResolve({ filter: /^@\// }, async (args) => {
      const resolved = path.resolve(__dirname, "src", args.path.slice(2));
      return build.resolve(resolved, { kind: args.kind, resolveDir: path.dirname(resolved) });
    });
  }
};

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
    plugins: [aliasPlugin, esbuildProblemMatcherPlugin]
  });

  const webview = await esbuild.context({
    entryPoints: ["src/webview/main.ts"],
    bundle: true,
    format: "iife",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    target: "es6",
    outfile: "out/web.min.js",
    logLevel: "silent",
    plugins: [aliasPlugin, esbuildProblemMatcherPlugin]
  });

  // Standalone helper git runs via GIT_ASKPASS (#114); a separate node bundle.
  const askpass = await esbuild.context({
    entryPoints: ["src/extension/askpass/askpassMain.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    target: "es6",
    outfile: "out/askpassMain.js",
    logLevel: "silent",
    plugins: [aliasPlugin, esbuildProblemMatcherPlugin]
  });

  // The askpass shell scripts are loaded by git at runtime from out/.
  const copyAskpassScripts = () => {
    fs.mkdirSync("out", { recursive: true });
    for (const f of ["askpass.sh", "askpass-empty.sh"]) {
      fs.copyFileSync(path.join("src/extension/askpass", f), path.join("out", f));
    }
  };

  if (watch) {
    copyAskpassScripts();
    await Promise.all([extension.watch(), webview.watch(), askpass.watch()]);
  } else {
    await extension.rebuild();
    await extension.dispose();
    await webview.rebuild();
    await webview.dispose();
    await askpass.rebuild();
    await askpass.dispose();
    copyAskpassScripts();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
