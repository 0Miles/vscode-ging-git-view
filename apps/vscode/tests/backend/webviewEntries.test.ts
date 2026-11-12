import { build, type BuildResult } from "esbuild";
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

type Bundle = { text: string; inputs: string[] };
let bundles: { vscode: Bundle; desktop: Bundle };

beforeAll(async () => {
  const result: BuildResult<{ write: false; metafile: true }> = await build({
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
  const bundleOf = (name: "vscode" | "desktop"): Bundle => {
    const file = result.outputFiles.find((f) => f.path.endsWith(`${name}.js`))!;
    const output = Object.entries(result.metafile.outputs).find(([p]) =>
      p.endsWith(`${name}.js`)
    )![1];
    return { text: file.text, inputs: Object.keys(output.inputs) };
  };
  bundles = { vscode: bundleOf("vscode"), desktop: bundleOf("desktop") };
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
});
