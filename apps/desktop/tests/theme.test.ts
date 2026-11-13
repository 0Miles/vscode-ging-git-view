import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { themeFor } from "@ging/desktop/theme";

/** Every `--vscode-*` variable the webview reads, from its sources and its
 *  stylesheet: what VS Code would have injected into the page. */
function variablesTheWebviewReads(): Set<string> {
  const css = require.resolve("@ging/webview/media/main.css");
  const src = path.dirname(require.resolve("@ging/webview/main"));
  const files = [
    css,
    ...fs
      .readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts"))
      .map((f) => path.join(src, f))
  ];
  const names = new Set<string>();
  for (const file of files) {
    for (const [match] of fs.readFileSync(file, "utf8").matchAll(/--vscode-[\w.-]+/g)) {
      // A comment's `--vscode-cornerRadius-*` names a family, not a variable.
      if (match.endsWith("-")) continue;
      names.add(match.replace(/\.$/, ""));
    }
  }
  return names;
}

/**
 * Read by the webview but left out of both themes, as VS Code's own Dark Modern
 * and Light Modern leave them out: only the high-contrast themes set them, and
 * the webview's CSS reads each with a fallback or as "absent". The design
 * tokens are not colours and have a fallback on every use in `main.css`.
 */
const LEFT_UNSET = new Set([
  "--vscode-contrastBorder",
  "--vscode-editor-findMatchBorder",
  "--vscode-editor-findMatchHighlightBorder",
  "--vscode-menu-selectionBorder",
  "--vscode-selection-background",
  "--vscode-cornerRadius-large",
  "--vscode-cornerRadius-medium",
  "--vscode-shadow-lg",
  "--vscode-strokeThickness"
]);

describe("themeFor", () => {
  it.each(["dark", "light"] as const)(
    "gives the %s theme every variable the webview reads, but those VS Code leaves unset",
    (kind) => {
      const given = Object.keys(themeFor(kind, "linux").variables);
      const missing = [...variablesTheWebviewReads()].filter(
        (name) => !given.includes(name) && !LEFT_UNSET.has(name)
      );
      expect(missing).toEqual([]);
    }
  );

  it("marks the body the way VS Code does for each kind", () => {
    expect(themeFor("dark", "linux").bodyClass).toBe("vscode-dark");
    expect(themeFor("light", "linux").bodyClass).toBe("vscode-light");
  });
});
