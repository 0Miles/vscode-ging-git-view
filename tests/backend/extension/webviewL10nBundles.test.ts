import { readFileSync } from "node:fs";

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

function readBundle(fileName: string): Record<string, string> {
  return JSON.parse(
    readFileSync(new URL(`../../../l10n/${fileName}`, import.meta.url), "utf8")
  ) as Record<string, string>;
}

getWebviewLocalizedStrings();

describe("webview l10n keys", () => {
  it("collects the keys the webview requests", () => {
    expect(requestedKeys.size).toBeGreaterThan(0);
  });

  it.each(["bundle.l10n.json", "bundle.l10n.zh-cn.json", "bundle.l10n.zh-tw.json"])(
    "%s defines every requested key",
    (fileName) => {
      const bundle = readBundle(fileName);
      const missing = [...requestedKeys].filter((key) => !Object.hasOwn(bundle, key));
      expect(missing).toEqual([]);
    }
  );
});
