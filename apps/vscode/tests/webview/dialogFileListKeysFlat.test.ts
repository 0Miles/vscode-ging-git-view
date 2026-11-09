import { beforeAll, describe, expect, it, vi } from "vitest";

import type { BranchRedundancy, GitCommitDetails, GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";

import { clickItem, createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// `dialogFileListKeys.test.ts` with the repo set to the flat File List (#145).
// A list has no folders, so it is Up/Down only: Left and Right have nothing to
// fold or climb to, and leave focus where it is. Its own file because the
// layout is read at boot, and one webview per file is the rule (#80).

const L = getWebviewLocalizedStrings();

const commits: GitCommitNode[] = [
  {
    hash: "aaa111",
    parentHashes: [],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Tip commit",
    refs: [
      { hash: "aaa111", name: "main", type: "head" },
      { hash: "aaa111", name: "feature", type: "head" }
    ]
  }
];

const dialogDetails: GitCommitDetails = {
  hash: "ddd444",
  parents: [],
  author: "Dana",
  email: "dana@example.com",
  committer: "Dana",
  committerEmail: "dana@example.com",
  authorDate: 1698500000,
  commitDate: 1698500000,
  body: "Dialog commit",
  fileChanges: [
    { oldFilePath: "src/a.ts", newFilePath: "src/a.ts", type: "M", additions: 1, deletions: 0 },
    {
      oldFilePath: "src/lib/b.ts",
      newFilePath: "src/lib/b.ts",
      type: "M",
      additions: 2,
      deletions: 0
    },
    { oldFilePath: "README.md", newFilePath: "README.md", type: "M", additions: 4, deletions: 1 }
  ]
};

const redundancyResult: BranchRedundancy = {
  kind: "unmerged",
  defaultBranch: "main",
  defaultBranchDate: 1700000000,
  commits: [
    {
      hash: "ddd444",
      subject: "Dialog commit",
      author: "Dana",
      email: "dana@example.com",
      date: 1698500000,
      covered: false
    }
  ],
  truncated: false
};

function press(key: string) {
  const target = document.activeElement ?? document.body;
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

const fileRows = () =>
  Array.from(document.querySelectorAll<HTMLElement>("#dialog .commitDetailsFiles .gitFile"));
const pathOf = (elem: Element | null) =>
  elem instanceof HTMLElement && elem.dataset.newfilepath !== undefined
    ? decodeURIComponent(elem.dataset.newfilepath)
    : String(elem);

describe("the branch-redundancy dialog's file list in the File List layout", () => {
  beforeAll(async () => {
    vi.resetModules();
    const mock = createVscodeMock();
    setupHtml(makeViewState({ fileViewType: "File List" }));
    await import("@/webview/main");
    receive({
      command: "loadBranches",
      token: 0,
      branches: ["main", "feature"],
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
    document
      .querySelector('#commitTable .gitRef.head[data-name="feature"]')!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    clickItem(L.checkRedundancy);
    receive({
      command: "branchRedundancy",
      branch: "feature",
      result: redundancyResult,
      token: mock.sentOf("branchRedundancy")[0].token
    });
    document
      .querySelector<HTMLElement>('#dialog .commitList tr.commit[data-hash="ddd444"]')!
      .focus();
    press("Enter");
    receive({
      command: "redundancyCommitDetails",
      commitHash: "ddd444",
      commitDetails: dialogDetails
    });
  });

  it("is files only, with one tab stop, on the first", () => {
    expect(document.querySelector("#dialog .commitDetailsFiles .gitFolder")).toBeNull();
    expect(fileRows().map(pathOf)).toEqual(["README.md", "src/a.ts", "src/lib/b.ts"]);
    expect(
      fileRows()
        .filter((r) => r.tabIndex === 0)
        .map(pathOf)
    ).toEqual(["README.md"]);
  });

  it("walks with Down and Up", () => {
    fileRows()[0].focus();
    press("ArrowDown");
    press("ArrowDown");
    expect(pathOf(document.activeElement)).toBe("src/lib/b.ts");
    press("ArrowUp");
    expect(pathOf(document.activeElement)).toBe("src/a.ts");
  });

  it("leaves Left and Right alone: there is no folder to fold or climb to", () => {
    for (const key of ["ArrowLeft", "ArrowRight"]) {
      const event = press(key);
      expect(event.defaultPrevented, key).toBe(false);
      expect(pathOf(document.activeElement), key).toBe("src/a.ts");
    }
  });
});
