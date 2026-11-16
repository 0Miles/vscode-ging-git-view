import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { THEME_COLOR_IDS } from "@ging/vscode/extension/themeColorIds";

/**
 * Lock between the colours the real package.json contributes and the ids the
 * code hands to `ThemeColor`. VS Code rejects a colour id holding anything but
 * letters, digits and dots, and the rejection takes every other extension's
 * colours down with it (#432), so a bad or unmatched id is a red test here
 * rather than a transparent decoration in someone's editor.
 */

const packageJson = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8")
) as { contributes: { colors: { id: string }[] } };

const contributedIds = packageJson.contributes.colors.map((color) => color.id);

/** VS Code's rule: letters, digits and dots, not starting with a dot. */
const VALID_COLOR_ID = /^[A-Za-z0-9]+(\.[A-Za-z0-9]+)*$/;

describe("theme colour ids", () => {
  it("contributes at least one colour", () => {
    expect(contributedIds.length).toBeGreaterThan(0);
  });

  it.each(contributedIds)("%s is an id VS Code accepts", (id) => {
    expect(id).toMatch(VALID_COLOR_ID);
  });

  it("contributes every colour the code references, and no other", () => {
    expect(contributedIds.toSorted()).toEqual(THEME_COLOR_IDS.toSorted());
  });
});
