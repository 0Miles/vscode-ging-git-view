import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { getWebviewLocalizedStrings } from "@ging/webview/webviewL10n";

/**
 * Every key the webview asks for must exist in every shipped l10n bundle.
 * A key missing from all three bundles slips past `pnpm l10n:check` (which only
 * compares the translations against English) and the webview then shows the
 * raw key string as its label or tooltip.
 */

const requestedKeys = new Set<string>();

const l10nDir = path.resolve(__dirname, "../../shared/l10n");
const bundleFiles = readdirSync(l10nDir).filter((file) => /^bundle\.l10n(\..+)?\.json$/.test(file));

function readBundle(fileName: string): Record<string, string> {
  return JSON.parse(readFileSync(path.join(l10nDir, fileName), "utf8")) as Record<string, string>;
}

getWebviewLocalizedStrings((key) => {
  requestedKeys.add(key);
  return key;
});

describe("webview l10n keys", () => {
  it("collects the keys the webview requests and finds the English bundle", () => {
    expect(requestedKeys.size).toBeGreaterThan(0);
    expect(bundleFiles).toContain("bundle.l10n.json");
  });

  it.each(bundleFiles)("%s defines every requested key", (fileName) => {
    const bundle = readBundle(fileName);
    const missing = [...requestedKeys].filter((key) => !Object.hasOwn(bundle, key));
    expect(missing).toEqual([]);
  });
});
