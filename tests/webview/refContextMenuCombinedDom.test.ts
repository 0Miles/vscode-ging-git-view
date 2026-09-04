import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";

import { createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// The combined-label path of the ref context menu: with
// combineLocalAndRemoteBranchLabels on (the shipped default), a remote branch
// is folded into its matching local head chip as a nested .gitRef.remote
// badge, and the listener's closest(".gitRef") must resolve a click on the
// badge to the remote ref — not to the head chip wrapped around it.
// refContextMenuDom.test.ts covers the separate-chip layout.

const L = getWebviewLocalizedStrings();
const E = "…"; // the rendered form of the ELLIPSIS entity
const DIVIDER = "---";

const viewState = makeViewState({ combineLocalAndRemoteBranchLabels: true });

const commits: GitCommitNode[] = [
  {
    hash: "aaa111",
    parentHashes: [],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Tip",
    refs: [
      { hash: "aaa111", name: "main", type: "head" },
      { hash: "aaa111", name: "origin/main", type: "remote" }
    ]
  }
];

/** The rendered menu, top to bottom: item labels, with dividers as "---". */
function menuEntries() {
  return Array.from(document.getElementById("contextMenu")!.children).map((li) =>
    li.classList.contains("contextMenuDivider") ? DIVIDER : (li.textContent ?? "").trim()
  );
}

describe("ref context menu on a combined local+remote label", () => {
  let mock: ReturnType<typeof createVscodeMock>;

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    await import("@/webview/main");
    receive({
      command: "loadBranches",
      token: 0,
      branches: ["main"],
      head: "main",
      hard: true,
      isRepo: true,
      filter: []
    });
    receive({ command: "loadRemotes", remotes: ["origin"], pushDefault: null });
    receive({
      command: "loadCommits",
      token: 0,
      commits,
      head: "aaa111",
      moreCommitsAvailable: false,
      hard: true
    });
  });

  it("folds the remote into the head chip as a nested badge", () => {
    const badge = document.querySelector<HTMLElement>(
      '.gitRef.remote.gitRefCombined[data-name="origin/main"]'
    );
    expect(badge).not.toBeNull();
    // Nested inside the local chip — the very layout that makes closest()
    // resolution worth pinning.
    const enclosing = badge!.parentElement!.closest<HTMLElement>(".gitRef");
    expect(enclosing).not.toBeNull();
    expect(enclosing!.classList.contains("head")).toBe(true);
    expect(enclosing!.dataset.name).toBe("main");
  });

  it("serves the remote-branch menu from a right-click on the badge", () => {
    const badge = document.querySelector<HTMLElement>(
      '.gitRef.remote.gitRefCombined[data-name="origin/main"]'
    )!;
    badge.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(menuEntries()).toEqual([
      L.checkoutBranch + E,
      L.merge + E,
      L.pullIntoCurrentBranch + E,
      L.fetchIntoLocalBranch + E,
      L.deleteRemoteBranch + E,
      L.checkRedundancy,
      L.createPullRequest + E,
      DIVIDER,
      L.copyBranchName
    ]);

    // The copy item acts on the badge's remote ref, not the enclosing "main".
    mock.clearMessages();
    const copyItem = Array.from(
      document.querySelectorAll<HTMLElement>("#contextMenu .contextMenuItem")
    ).find((li) => (li.textContent ?? "").trim() === L.copyBranchName)!;
    copyItem.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mock.sentMessages).toContainEqual({
      command: "copyToClipboard",
      type: "Branch Name",
      data: "origin/main"
    });
  });

  it("still serves the checked-out local menu from the chip's own label", () => {
    const label = document.querySelector<HTMLElement>(
      '.gitRef.head[data-name="main"] .gitRefName'
    )!;
    label.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(menuEntries()).toEqual([
      L.renameBranch + E,
      L.pushBranch + E,
      L.createArchive + E,
      L.checkRedundancy,
      L.createPullRequest + E,
      DIVIDER,
      L.copyBranchName
    ]);
  });
});
