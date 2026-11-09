import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";

/**
 * Every key the webview asks for must exist in every shipped l10n bundle.
 * A key missing from all three bundles slips past `pnpm l10n:check` (which only
 * compares the translations against English) and the webview then shows the
 * raw key string as its label or tooltip.
 */

const requestedKeys = vi.hoisted(() => new Set<string>());

vi.mock("@/l10n", () => ({
  t: (key: string) => {
    requestedKeys.add(key);
    return key;
  }
}));

const l10nDir = new URL("../../../l10n/", import.meta.url);
const bundleFiles = readdirSync(l10nDir).filter((file) => /^bundle\.l10n(\..+)?\.json$/.test(file));

function readBundle(fileName: string): Record<string, string> {
  return JSON.parse(readFileSync(new URL(fileName, l10nDir), "utf8")) as Record<string, string>;
}

getWebviewLocalizedStrings();

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
