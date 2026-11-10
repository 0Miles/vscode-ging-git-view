import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitDetails, GitCommitNode } from "@ging/shared/backend/types";
import type * as GG from "@ging/shared/types";

import {
  clickElem,
  clickItem,
  commitDetails,
  contextMenuEntries,
  createVscodeMock,
  DEFAULT_REPO,
  englishStrings,
  makeViewState,
  openDetailsOn,
  receive,
  rightClick,
  setupHtml
} from "./setup";

// A stash pushed with --include-untracked keeps those files in a commit of its
// own, not in the stash's tree (#332). The host marks their rows with
// `origin: "untracked"` and works out where to read them from; the CDV only
// hands the origin back with every request that reads the file. It never names
// the revision itself.

const L = englishStrings();

const STASH = "sss555";

const commits: GitCommitNode[] = [
  {
    hash: STASH,
    parentHashes: ["aaa111"],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "WIP on main",
    refs: [{ hash: STASH, name: "stash@{0}", type: "stash" }]
  },
  {
    hash: "aaa111",
    parentHashes: [],
    author: "Alice",
    email: "alice@example.com",
    date: 1699000000,
    message: "init",
    refs: [{ hash: "aaa111", name: "main", type: "head" }]
  }
];

const stashDetails: GitCommitDetails = {
  ...commitDetails(STASH),
  parents: ["aaa111"],
  fileChanges: [
    {
      oldFilePath: "tracked.txt",
      newFilePath: "tracked.txt",
      type: "M",
      additions: 1,
      deletions: 1
    },
    {
      oldFilePath: "sub/untracked.txt",
      newFilePath: "sub/untracked.txt",
      type: "A",
      additions: 1,
      deletions: 0,
      origin: "untracked"
    }
  ]
};

function fileRow(path: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(
    `#commitDetails .gitFile[data-newfilepath="${encodeURIComponent(path)}"]`
  );
  expect(row, path).not.toBeNull();
  return row!;
}

describe("a stash's untracked file in the Commit Details View", () => {
  let mock: ReturnType<typeof createVscodeMock>;

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(makeViewState({ autoCenterCommitDetailsView: false }));
    await import("@ging/webview/main");
    receive({
      command: "loadBranches",
      token: 0,
      branches: ["main"],
      head: "main",
      hard: true,
      isRepo: true,
      filter: []
    });
    receive({
      command: "loadCommits",
      token: 0,
      commits,
      head: "aaa111",
      moreCommitsAvailable: false,
      hard: true
    });
    openDetailsOn(STASH);
    receive({ command: "commitDetails", commitDetails: stashDetails });
  });

  function sentWhile(act: () => void): GG.RequestMessage[] {
    mock.clearMessages();
    act();
    return [...mock.sentMessages];
  }

  it("can be diffed, and is not marked binary", () => {
    const row = fileRow("sub/untracked.txt");
    expect(row.classList.contains("gitDiffPossible")).toBe(true);
    expect(row.title).toBe("");
  });

  it("opens its diff with the origin the host gave it", () => {
    expect(sentWhile(() => clickElem(fileRow("sub/untracked.txt")))).toEqual([
      {
        command: "viewDiff",
        repo: DEFAULT_REPO,
        commitHash: STASH,
        fromHash: undefined,
        oldFilePath: "sub/untracked.txt",
        newFilePath: "sub/untracked.txt",
        type: "A",
        origin: "untracked"
      }
    ]);
  });

  it("hands the origin back from its hover buttons", () => {
    const row = fileRow("sub/untracked.txt");
    expect(sentWhile(() => clickElem(row.querySelector(".gitFileViewRev")!))).toEqual([
      {
        command: "viewFileAtRevision",
        repo: DEFAULT_REPO,
        commitHash: STASH,
        filePath: "sub/untracked.txt",
        origin: "untracked"
      }
    ]);
    expect(sentWhile(() => clickElem(row.querySelector(".gitFileDiffWorking")!))).toEqual([
      {
        command: "viewDiffWithWorking",
        repo: DEFAULT_REPO,
        commitHash: STASH,
        filePath: "sub/untracked.txt",
        origin: "untracked"
      }
    ]);
  });

  it("offers View Diff in its context menu, and every reader there hands the origin back", () => {
    rightClick(fileRow("sub/untracked.txt"));
    expect(contextMenuEntries()).toContain(L.viewDiff);
    const sent = sentWhile(() => {
      clickItem(L.viewDiff);
      rightClick(fileRow("sub/untracked.txt"));
      clickItem(L.viewFileAtRevision);
      rightClick(fileRow("sub/untracked.txt"));
      clickItem(L.viewDiffWithWorking);
    });
    expect(sent.map((m) => [m.command, (m as { origin?: string }).origin])).toEqual([
      ["viewDiff", "untracked"],
      ["viewFileAtRevision", "untracked"],
      ["viewDiffWithWorking", "untracked"]
    ]);
  });

  it("leaves the stash's tracked file reading from the stash itself", () => {
    expect(sentWhile(() => clickElem(fileRow("tracked.txt")))).toEqual([
      {
        command: "viewDiff",
        repo: DEFAULT_REPO,
        commitHash: STASH,
        fromHash: undefined,
        oldFilePath: "tracked.txt",
        newFilePath: "tracked.txt",
        type: "M"
      }
    ]);
    expect(
      sentWhile(() => clickElem(fileRow("tracked.txt").querySelector(".gitFileViewRev")!))
    ).toEqual([
      {
        command: "viewFileAtRevision",
        repo: DEFAULT_REPO,
        commitHash: STASH,
        filePath: "tracked.txt"
      }
    ]);
  });
});
