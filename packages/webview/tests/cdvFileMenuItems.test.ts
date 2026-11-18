import { describe, expect, it } from "vitest";

import type { FileHistoryStrings } from "@ging/webview/desktop/fileHistory/protocol";

import { bootWithCdvFile, cdvFileRow, HASH } from "./cdvFileMenuBoot";
import {
  clickItem,
  contextMenuEntries,
  DEFAULT_REPO,
  hideMenu,
  receive,
  rightClick
} from "./setup";

// What the rest of a page adds to a Commit Details View file's context menu
// (`GraphInPage.addCdvFileMenuItems`): the desktop entry's View File History
// (#408), after the graph's own items. The VS Code entry adds nothing:
// cdvFileMenuItemsVscode.test.ts.

const STRINGS: FileHistoryStrings = {
  menuItem: "View File History",
  title: "History of {0}",
  upTo: "up to {0}",
  close: "Close File History",
  loadMore: "Load More",
  empty: "No commit changed this file.",
  renamedFrom: "Renamed from {0}",
  copiedFrom: "Copied from {0}",
  asPath: "As {0}",
  added: "Added",
  deleted: "Deleted",
  merge: "Merge",
  submodule: "Submodule {0} → {1}"
};

describe("a CDV file's context menu in the desktop entry", () => {
  it("ends with View File History once the host has said the words, opening the file's history up to the commit", async () => {
    const mock = await bootWithCdvFile("desktop");
    rightClick(cdvFileRow());
    const own = contextMenuEntries();
    hideMenu();
    expect(own).not.toContain(STRINGS.menuItem);

    receive({ command: "fileHistoryStrings", strings: STRINGS } as never);
    rightClick(cdvFileRow());

    // A divider, then the item.
    expect(contextMenuEntries()).toEqual([...own, "", STRINGS.menuItem]);
    mock.clearMessages();
    clickItem(STRINGS.menuItem);
    expect(mock.sentMessages).toEqual([
      { command: "fileHistoryLoad", path: "new.txt", start: HASH, offset: 0 }
    ]);
    expect(document.getElementById("fileHistory")!.hidden).toBe(false);
    // The repository is the Tab's: the host reads its own, not the page's word.
    expect(JSON.stringify(mock.sentMessages)).not.toContain(DEFAULT_REPO);
  });
});
