import { describe, expect, it } from "vitest";

import { bootWithCdvFile, cdvFileRow } from "./cdvFileMenuBoot";
import { contextMenuEntries, englishStrings, rightClick } from "./setup";

// The VS Code entry adds nothing to a Commit Details View file's context menu
// (`GraphInPage.addCdvFileMenuItems`, #408): it ends with the graph's own last
// item, with no divider after it, as a fixed list. The desktop entry's:
// cdvFileMenuItems.test.ts.

const L = englishStrings();

describe("a CDV file's context menu in the VS Code entry", () => {
  it("holds only the graph's own items", async () => {
    await bootWithCdvFile("vscode");

    rightClick(cdvFileRow());

    // The whole menu, item by item, as the VS Code entry has always drawn it
    // for a renamed file of a commit: nothing added, no divider.
    expect(contextMenuEntries()).toEqual([
      L.viewDiff,
      L.viewFileAtRevision,
      L.viewDiffWithWorking,
      L.openFile,
      L.resetFileToRevision + "…",
      L.copyFilePath
    ]);
  });
});
