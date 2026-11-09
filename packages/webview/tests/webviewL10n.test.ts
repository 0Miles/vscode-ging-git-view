import { describe, expect, it } from "vitest";

import englishBundle from "@ging/shared/l10n/bundle.l10n.json";
import { getWebviewLocalizedStrings } from "@ging/webview/webviewL10n";

/**
 * The webview's strings come from whatever translator the host hands in; this
 * package never reaches a host's l10n API itself. A fake translator that wraps
 * the key it is asked for shows which key each string was looked up under.
 */
describe("getWebviewLocalizedStrings", () => {
  it("fills each string with the host's translation of its key", () => {
    const strings = getWebviewLocalizedStrings((key) => `[${key}]`);

    expect(strings.branch).toBe("[ui.branch]");
    // The graph's empty state borrows the sentence the host's own commands use.
    expect(strings.noRepos).toBe("[repoName.noRepos]");
    expect(strings.tooltipDeletions).toBe("[tooltip.deletions]");
  });

  it("takes every string from the translator, none written in", () => {
    const strings = getWebviewLocalizedStrings((key) => `[${key}]`);

    const untranslated = Object.entries(strings).filter(([, value]) => !/^\[.+\]$/.test(value));
    expect(untranslated).toEqual([]);
  });

  it("asks only for keys the English bundle defines, bar one known gap", () => {
    const asked: string[] = [];
    getWebviewLocalizedStrings((key) => {
      asked.push(key);
      return key;
    });

    expect(asked.length).toBeGreaterThan(0);
    // `ui.findOpenCommitDetails` (the find widget's open-details button tooltip)
    // has never had a bundle entry, so every locale shows the raw key (#313).
    // Pinned here so the gap cannot widen unnoticed; #313 adds the entry and
    // empties this list.
    expect(asked.filter((key) => !Object.hasOwn(englishBundle, key))).toEqual([
      "ui.findOpenCommitDetails"
    ]);
  });
});
