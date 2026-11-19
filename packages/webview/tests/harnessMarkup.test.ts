import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildWebviewMarkup } from "@ging/webview/webviewMarkup";

import { englishStrings } from "./setup";

// The webview harness's graph page (scripts/webview-harness.js), which the
// webview E2E drives, is the page both hosts send: inside <body>, before its
// first <script>, it is buildWebviewMarkup's markup, not a copy of it (#442).
// The desktop entry's page is the one built here: the VS Code entry's needs
// `pnpm run compile` first, and both are written by the same code.

const ROOT = path.resolve(__dirname, "../../..");

/** What a written page holds inside <body>, before its first <script>. */
function bodyMarkup(html: string): string {
  const body = html.indexOf(">", html.indexOf("<body")) + 1;
  return html.slice(body, html.indexOf("<script", body));
}

describe("the webview harness's graph page", () => {
  it("is buildWebviewMarkup's markup, in English", { timeout: 120_000 }, () => {
    execFileSync(process.execPath, [
      path.join(ROOT, "scripts", "webview-harness.js"),
      "--entry=desktop"
    ]);
    const html = fs.readFileSync(
      path.join(ROOT, "out", "webview-harness", "desktop", "index.html"),
      "utf8"
    );

    expect(bodyMarkup(html).trim()).toBe(buildWebviewMarkup(englishStrings()).trim());
  });
});
