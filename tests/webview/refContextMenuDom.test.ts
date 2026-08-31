import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";

import { clickItem, createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// The ref context menu, end to end: right-clicking a rendered ref chip must
// yield exactly the items the ref's kind calls for, in order, dividers
// included. This locks the DOM-to-menu seam (chip classification, action
// wiring); the per-combination content decisions themselves are enumerated in
// refContextMenu.test.ts without a DOM.

const L = getWebviewLocalizedStrings();
const E = "…"; // the rendered form of the ELLIPSIS entity
const DIVIDER = "---";

const viewState = makeViewState({
  // Separate local and remote chips so each kind can be right-clicked on its
  // own element; the combined badge carries the same .gitRef.remote classes.
  combineLocalAndRemoteBranchLabels: false,
  issueLinkingRegex: "#(\\d+)",
  issueLinkingUrl: "https://example.com/issues/$1"
});

const commits: GitCommitNode[] = [
  {
    hash: "aaa111",
    parentHashes: ["bbb222"],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Tip",
    refs: [
      { hash: "aaa111", name: "main", type: "head" },
      { hash: "aaa111", name: "origin/main", type: "remote" },
      { hash: "aaa111", name: "origin/HEAD", type: "remote" },
      { hash: "aaa111", name: "v1.0", type: "tag" }
    ]
  },
  {
    hash: "bbb222",
    parentHashes: [],
    author: "Bob",
    email: "bob@example.com",
    date: 1699000000,
    message: "Base",
    refs: [
      { hash: "bbb222", name: "feature", type: "head" },
      { hash: "bbb222", name: "fix-#12", type: "head" },
      { hash: "bbb222", name: "stash@{0}", type: "stash" }
    ]
  }
];

function openMenuOn(selector: string) {
  const chip = document.querySelector<HTMLElement>(selector);
  expect(chip, selector).not.toBeNull();
  chip!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
}

/** The rendered menu, top to bottom: item labels, with dividers as "---". */
function menuEntries() {
  return Array.from(document.getElementById("contextMenu")!.children).map((li) =>
    li.classList.contains("contextMenuDivider") ? DIVIDER : (li.textContent ?? "").trim()
  );
}

describe("ref context menus raised from the graph", () => {
  let mock: ReturnType<typeof createVscodeMock>;

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    await import("@/webview/main");
    receive({
      command: "loadBranches",
      branches: ["main", "feature", "fix-#12"],
      head: "main",
      hard: true,
      isRepo: true,
      filter: [],
      cleanupCandidates: ["feature"]
    });
    receive({ command: "loadRemotes", remotes: ["origin"], pushDefault: null });
    receive({
      command: "loadCommits",
      commits,
      head: "aaa111",
      moreCommitsAvailable: false,
      hard: true
    });
  });

  describe("with a remote configured", () => {
    it("offers the stash actions on a stash chip", () => {
      openMenuOn('.gitRef.stash[data-name="stash@{0}"]');
      expect(menuEntries()).toEqual([
        L.stashApply + E,
        L.stashPop + E,
        L.stashDrop + E,
        L.stashRename + E,
        DIVIDER,
        L.copyStashName
      ]);
    });

    it("offers the tag actions, push included, on a tag chip", () => {
      openMenuOn('.gitRef.tag[data-name="v1.0"]');
      expect(menuEntries()).toEqual([
        L.viewTagDetails + E,
        L.createArchive + E,
        L.deleteTag + E,
        L.pushTag + E,
        DIVIDER,
        L.copyTagName
      ]);
    });

    it("omits checkout and the mutating actions on the checked-out branch", () => {
      openMenuOn('.gitRef.head[data-name="main"]');
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

    it("offers the full set on another local branch, cleanup row included", () => {
      openMenuOn('.gitRef.head[data-name="feature"]');
      expect(menuEntries()).toEqual([
        L.checkoutBranch, // no ellipsis: a local checkout asks nothing
        L.renameBranch + E,
        L.pushBranch + E,
        L.createArchive + E,
        L.deleteBranch + E,
        L.merge + E,
        L.rebaseOnBranch + E,
        L.fastForwardBranch,
        L.checkRedundancy,
        L.cleanupMenuItem,
        L.createPullRequest + E,
        DIVIDER,
        L.copyBranchName
      ]);
    });

    it("adds View Issue when the branch name matches the issue-linking pattern", () => {
      openMenuOn('.gitRef.head[data-name="fix-#12"]');
      expect(menuEntries()).toEqual([
        L.checkoutBranch,
        L.renameBranch + E,
        L.pushBranch + E,
        L.createArchive + E,
        L.deleteBranch + E,
        L.merge + E,
        L.rebaseOnBranch + E,
        L.fastForwardBranch,
        L.checkRedundancy,
        L.createPullRequest + E,
        L.viewIssue,
        DIVIDER,
        L.copyBranchName
      ]);
    });

    it("offers the remote-branch actions on a remote chip", () => {
      openMenuOn('.gitRef.remote[data-name="origin/main"]');
      expect(menuEntries()).toEqual([
        L.checkoutBranch + E, // with ellipsis: a remote checkout opens a dialog
        L.merge + E,
        L.pullIntoCurrentBranch + E,
        L.fetchIntoLocalBranch + E,
        L.deleteRemoteBranch + E,
        L.checkRedundancy,
        L.createPullRequest + E,
        DIVIDER,
        L.copyBranchName
      ]);
    });

    it('keeps the symbolic "<remote>/HEAD" chip down to the non-branch actions', () => {
      openMenuOn('.gitRef.remote[data-name="origin/HEAD"]');
      expect(menuEntries()).toEqual([
        L.checkoutBranch + E,
        L.merge + E,
        L.createPullRequest + E,
        DIVIDER,
        L.copyBranchName
      ]);
    });

    it("wires the copy item to the ref's own copy type", () => {
      const cases = [
        {
          selector: '.gitRef.stash[data-name="stash@{0}"]',
          label: L.copyStashName,
          type: "Stash Name",
          data: "stash@{0}"
        },
        {
          selector: '.gitRef.tag[data-name="v1.0"]',
          label: L.copyTagName,
          type: "Tag Name",
          data: "v1.0"
        },
        {
          selector: '.gitRef.remote[data-name="origin/main"]',
          label: L.copyBranchName,
          type: "Branch Name",
          data: "origin/main"
        }
      ];
      for (const { selector, label, type, data } of cases) {
        mock.clearMessages();
        openMenuOn(selector);
        clickItem(label);
        expect(mock.sentMessages).toContainEqual({ command: "copyToClipboard", type, data });
      }
    });

    it("opens the linked issue from View Issue", () => {
      mock.clearMessages();
      openMenuOn('.gitRef.head[data-name="fix-#12"]');
      clickItem(L.viewIssue);
      expect(mock.sentMessages).toContainEqual({
        command: "openExternalUrl",
        url: "https://example.com/issues/12"
      });
    });
  });

  describe("with no remotes", () => {
    beforeAll(() => {
      receive({ command: "loadRemotes", remotes: [], pushDefault: null });
    });

    it("drops Push Tag from the tag menu", () => {
      openMenuOn('.gitRef.tag[data-name="v1.0"]');
      expect(menuEntries()).toEqual([
        L.viewTagDetails + E,
        L.createArchive + E,
        L.deleteTag + E,
        DIVIDER,
        L.copyTagName
      ]);
    });

    it("drops Push and Create Pull Request from branch menus", () => {
      openMenuOn('.gitRef.head[data-name="feature"]');
      expect(menuEntries()).toEqual([
        L.checkoutBranch,
        L.renameBranch + E,
        L.createArchive + E,
        L.deleteBranch + E,
        L.merge + E,
        L.rebaseOnBranch + E,
        L.fastForwardBranch,
        L.checkRedundancy,
        L.cleanupMenuItem,
        DIVIDER,
        L.copyBranchName
      ]);
    });
  });
});
