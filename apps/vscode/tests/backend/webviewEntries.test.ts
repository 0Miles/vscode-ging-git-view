import { build } from "esbuild";
import { describe, expect, it } from "vitest";

// The webview has two entries (ADR-0031): `@ging/webview/main`, which this
// extension bundles into `out/web.min.js`, and `@ging/webview/desktop/main`,
// which only the desktop host ships. Nothing but the import graph keeps the
// desktop entry's code out of the extension: one stray import from the VS Code
// side and it is in every `.vsix`. So the two are bundled here and the desktop
// entry's marker looked for in each.
//
// The options are the ones `esbuild.js` gives the webview bundle in a
// production build — the `.vsix` is built from that one — restated rather than
// imported, because `esbuild.js` is a script that builds on load. Only the
// options that decide what goes into the bundle matter here.
//
// The desktop bundle is the control: without it, a marker that tree-shaking
// dropped from both bundles would read as the extension's being clean.

const MARKER = "ging-desktop-entry";

async function bundle(entry: string): Promise<string> {
  const result = await build({
    entryPoints: [require.resolve(entry)],
    bundle: true,
    format: "iife",
    minify: true,
    target: "es6",
    write: false,
    logLevel: "silent"
  });
  return result.outputFiles[0]!.text;
}

describe("the webview entries' bundles", () => {
  it("leave the desktop entry's marker out of the extension's bundle", async () => {
    expect(await bundle("@ging/webview/main")).not.toContain(MARKER);
  });

  it("keep the marker in the desktop entry's bundle", async () => {
    expect(await bundle("@ging/webview/desktop/main")).toContain(MARKER);
  });
});
