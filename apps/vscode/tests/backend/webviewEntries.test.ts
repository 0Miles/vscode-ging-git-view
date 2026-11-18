import { join } from "node:path";

import { build, type BuildOptions, type BuildResult } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

// The webview has two entries (ADR-0031): `@ging/webview/main`, which this
// extension bundles into `out/web.min.js`, and `@ging/webview/desktop/main`,
// which only the desktop host ships. Nothing but the import graph keeps the
// desktop entry's code out of the extension: one stray import from the VS Code
// side and it is in every `.vsix`.
//
// Both are bundled in one build, the way `esbuild.js` builds the webview for
// the `.vsix` (minified, so tree-shaking is what a release gets). The boundary
// itself is read off the metafile — no module under `src/desktop/` may reach
// the extension's bundle, marker or not — and the marker is checked in both, so
// the string #386's E2E looks for is known to survive tree-shaking.

const MARKER = "ging-desktop-entry";

// Monaco (#404) is not under `src/desktop/`, so the read above does not see
// it: the desktop app builds it into a bundle of its own, which it hands the
// desktop entry at runtime (ADR-0031). So it is looked for by name, in the
// extension's bundle and, for the control, in the desktop app's editors
// bundle, built with the app's own options. The string is one of Monaco's
// own: the diff editor's class.
const MONACO_MARKER = "monaco-diff-editor";
const isMonaco = (path: string) => path.includes("monaco-editor/");

type Bundle = { text: string; inputs: string[] };
let bundles: { vscode: Bundle; desktop: Bundle };
let editors: Bundle;
let page: Bundle;

// The desktop app's build script (apps/desktop/esbuild.js), which builds
// nothing when required.
const desktopBuild = require(join(__dirname, "..", "..", "..", "desktop", "esbuild.js")) as {
  pageBuild: (production: boolean) => BuildOptions;
  editorsBuild: () => BuildOptions;
};

type Built = BuildResult<{ write: false; metafile: true }>;

/** The output of `built` whose name ends in `name`: its text and the modules
 *  it took in. outputFiles carry absolute paths, the metafile relative ones;
 *  both end in the name. */
function bundleOf(built: Built, name: string): Bundle {
  const isIt = (path: string) => path.endsWith(name);
  return {
    text: built.outputFiles.find((f) => isIt(f.path))!.text,
    inputs: Object.keys(Object.entries(built.metafile.outputs).find(([p]) => isIt(p))![1].inputs)
  };
}

/** options' script, built as the desktop app builds it, read in memory. */
async function buildScript(options: BuildOptions, name: string): Promise<Bundle> {
  const built: Built = await build({
    ...options,
    write: false,
    metafile: true,
    logLevel: "silent"
  });
  // Its script, not the stylesheet or font beside it.
  return bundleOf(built, name);
}

beforeAll(async () => {
  [editors, page] = await Promise.all([
    buildScript(desktopBuild.editorsBuild(), "monaco.js"),
    // As released: minified, so tree-shaking is what ships.
    buildScript(desktopBuild.pageBuild(true), "web.js")
  ]);
}, 120_000);

beforeAll(async () => {
  const result: Built = await build({
    entryPoints: {
      vscode: require.resolve("@ging/webview/main"),
      desktop: require.resolve("@ging/webview/desktop/main")
    },
    bundle: true,
    format: "iife",
    minify: true,
    target: "es6",
    outdir: "out",
    write: false,
    metafile: true,
    logLevel: "silent"
  });
  bundles = { vscode: bundleOf(result, "vscode.js"), desktop: bundleOf(result, "desktop.js") };
});

describe("the webview entries' bundles", () => {
  it("bring nothing under src/desktop/ into the extension's bundle", () => {
    expect(bundles.vscode.inputs.filter((p) => p.includes("src/desktop/"))).toEqual([]);
    // The control: the same read does find the desktop entry where it belongs.
    expect(bundles.desktop.inputs.filter((p) => p.includes("src/desktop/"))).not.toEqual([]);
  });

  it("leave the desktop entry's marker out of the extension's bundle", () => {
    expect(bundles.vscode.text).not.toContain(MARKER);
  });

  it("keep the marker in the desktop entry's bundle", () => {
    expect(bundles.desktop.text).toContain(MARKER);
  });

  it("bring no Monaco into the extension's bundle (#404)", () => {
    expect(bundles.vscode.inputs.filter(isMonaco)).toEqual([]);
    expect(bundles.vscode.text).not.toContain(MONACO_MARKER);
    // The control: the same reads find it where the desktop app puts it.
    expect(editors.inputs.filter(isMonaco)).not.toEqual([]);
    expect(editors.text).toContain(MONACO_MARKER);
  });

  it("leave Monaco out of the desktop app's page bundle, which loads it on a first diff (#404)", () => {
    // out/web.js, which every page of the app parses: Monaco is a bundle of
    // its own (ADR-0031), not in this one.
    expect(page.inputs.filter(isMonaco)).toEqual([]);
    expect(page.text).not.toContain(MONACO_MARKER);
    // It is the desktop entry, started: the marker is there.
    expect(page.text).toContain(MARKER);
  });
});
