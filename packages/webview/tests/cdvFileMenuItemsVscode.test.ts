import { describe, expect, it } from "vitest";

import { bootWithCdvFile, cdvFileRow } from "./cdvFileMenuBoot";
import { contextMenuEntries, englishStrings, rightClick } from "./setup";

// The VS Code entry adds nothing to a Commit Details View file's context menu
// (`GraphInPage.addCdvFileMenuItems`, #408): it ends with the graph's own last
// item, with no divider after it. The desktop entry's: cdvFileMenuItems.test.ts.

const L = englishStrings();

describe("a CDV file's context menu in the VS Code entry", () => {
  it("holds only the graph's own items", async () => {
    await bootWithCdvFile("vscode");

    rightClick(cdvFileRow());

    expect(contextMenuEntries().at(-1)).toBe(L.copyFilePath);
    expect(contextMenuEntries()).not.toContain("");
  });
});
