import { beforeAll, describe, expect, it, vi } from "vitest";

import type { BranchRedundancy, GitCommitDetails, GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

import { clickItem, createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// The branch-redundancy dialog's commit list and each expanded commit's file
// list, driven from the keyboard (#145). #141 made the dialog modal to the
// keyboard — Tab cycles inside it — but nothing in the list could be reached:
// the commit rows carried no tabindex and the file rows only `-1`. Each list is
// now its own roving group on the WAI-ARIA APG's pattern: one tab stop, the
// arrow keys within it, and a tree's Left/Right folding and climbing folders.
//
// The Commit Details View behind the dialog keeps its own single tab stop
// throughout (#113): nothing done in the dialog may hand it to a dialog row.
//
// One webview is booted for the whole file and the scenarios run in order, the
// way a session unfolds (#80).

const L = getWebviewLocalizedStrings();

const commits: GitCommitNode[] = [
  {
    hash: "aaa111",
    parentHashes: ["bbb222"],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Tip commit",
    refs: [{ hash: "aaa111", name: "main", type: "head" }]
  },
  {
    hash: "bbb222",
    parentHashes: [],
    author: "Bob",
    email: "bob@example.com",
    date: 1699000000,
    message: "Base commit",
    refs: [{ hash: "bbb222", name: "feature", type: "head" }]
  }
];

const commitsResponse: GG.ResponseMessage = {
  command: "loadCommits",
  token: 0,
  commits,
  head: "aaa111",
  moreCommitsAvailable: false,
  hard: true
};

const tipDetails: GitCommitDetails = {
  hash: "aaa111",
  parents: ["bbb222"],
  author: "Alice",
  email: "alice@example.com",
  committer: "Alice",
  committerEmail: "alice@example.com",
  authorDate: 1700000000,
  commitDate: 1700000000,
  body: "Tip commit",
  fileChanges: [
    { oldFilePath: "src/a.ts", newFilePath: "src/a.ts", type: "M", additions: 1, deletions: 0 },
    { oldFilePath: "README.md", newFilePath: "README.md", type: "M", additions: 3, deletions: 0 }
  ]
};

/** Rendered as a tree, top to bottom: `src/`, `src/lib/`, `b.ts`, `c.ts`,
 *  `a.ts`, `README.md` — folders before files at every level, and `src` keeps
 *  two children so compaction leaves both folders standing. */
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
    {
      oldFilePath: "src/lib/c.ts",
      newFilePath: "src/lib/c.ts",
      type: "A",
      additions: 3,
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
    },
    {
      hash: "eee555",
      subject: "Second commit",
      author: "Dana",
      email: "dana@example.com",
      date: 1698400000,
      covered: false
    },
    {
      hash: "fff666",
      subject: "Already applied",
      author: "Dana",
      email: "dana@example.com",
      date: 1698300000,
      covered: true
    }
  ],
  truncated: false
};

let mock: ReturnType<typeof createVscodeMock>;

const dialog = () => document.getElementById("dialog")!;
const dialogShown = () => dialog().classList.contains("active");

function click(elem: Element) {
  elem.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

/** Press a key the way the browser delivers it: at whatever holds focus. */
function press(key: string, init: KeyboardEventInit = {}) {
  const target = document.activeElement ?? document.body;
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function dialogCommitRow(hash: string) {
  const elem = document.querySelector<HTMLElement>(
    `#dialog .commitList tr.commit[data-hash="${hash}"]`
  );
  expect(elem, hash).not.toBeNull();
  return elem!;
}

const dialogCommitRows = () =>
  Array.from(document.querySelectorAll<HTMLElement>("#dialog .commitList tr.commit"));

/** The members of a group holding its tab stop — exactly one when all is well. */
const tabStopsOf = (rows: HTMLElement[]) => rows.filter((r) => r.tabIndex === 0);

/** What a dialog file-list row is called on screen: a folder by its path, a
 *  file by its path — enough to say which row focus is on. */
function rowName(elem: Element | null): string {
  if (!(elem instanceof HTMLElement)) return String(elem);
  if (elem.matches(".gitFolder")) return decodeURIComponent(elem.dataset.folderpath!) + "/";
  if (elem.matches(".gitFile")) return decodeURIComponent(elem.dataset.newfilepath!);
  if (elem.matches("tr.commit")) return elem.dataset.hash!;
  return elem.id !== "" ? "#" + elem.id : elem.tagName;
}

/** The dialog's file rows, folders and files, that are showing. */
const dialogFileRows = () =>
  Array.from(
    document.querySelectorAll<HTMLElement>(
      "#dialog .commitDetailsFiles .gitFolder, #dialog .commitDetailsFiles .gitFile"
    )
  ).filter((r) => r.closest(".hidden") === null);

/** A dialog file-list row by the name {@link rowName} gives it. */
function fileRow(name: string) {
  const elem = Array.from(
    document.querySelectorAll<HTMLElement>(
      "#dialog .commitDetailsFiles .gitFolder, #dialog .commitDetailsFiles .gitFile"
    )
  ).find((r) => rowName(r) === name);
  expect(elem, name).toBeDefined();
  return elem!;
}

const folderOpen = (name: string) => !fileRow(name).parentElement!.classList.contains("closed");

/** The Commit Details View's tab stops, by path — exactly one, before and after. */
const cdvTabStops = () =>
  Array.from(document.querySelectorAll<HTMLElement>("#commitDetails .gitFile"))
    .filter((r) => r.tabIndex === 0)
    .map(rowName);
let cdvTabStopsBefore: string[] = [];

describe("the branch-redundancy dialog's lists, from the keyboard", () => {
  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(makeViewState());
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
    receive(commitsResponse);

    // The graph's Commit Details View, open behind the dialog, so there is a
    // tab stop of its own for the dialog to leave alone.
    click(document.querySelector('#commitTable tr.commit[data-hash="aaa111"]')!);
    receive({ command: "commitDetails", commitDetails: tipDetails });
    cdvTabStopsBefore = cdvTabStops();
    expect(cdvTabStopsBefore).toEqual(["src/a.ts"]);

    document
      .querySelector('#commitTable .gitRef.head[data-name="feature"]')!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    clickItem(L.checkRedundancy);
    const requested = mock.sentOf("branchRedundancy");
    expect(requested).toHaveLength(1);
    receive({
      command: "branchRedundancy",
      branch: "feature",
      result: redundancyResult,
      token: requested[0].token
    });
    expect(dialogShown()).toBe(true);
  });

  describe("the commit rows", () => {
    it("share one tab stop, on the first row", () => {
      const rows = dialogCommitRows();
      expect(rows.map((r) => r.dataset.hash)).toEqual(["ddd444", "eee555", "fff666"]);
      for (const r of rows) expect(r.hasAttribute("tabindex"), r.dataset.hash).toBe(true);
      expect(tabStopsOf(rows).map(rowName)).toEqual(["ddd444"]);
    });

    it("walk with Down and Up, stopping at either end, and take the tab stop along", () => {
      dialogCommitRow("ddd444").focus();
      const seen: string[] = [];
      for (const key of ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowUp"]) {
        const event = press(key);
        expect(event.defaultPrevented, key).toBe(true);
        seen.push(rowName(document.activeElement));
      }
      expect(seen).toEqual(["eee555", "fff666", "fff666", "eee555"]);
      expect(tabStopsOf(dialogCommitRows()).map(rowName)).toEqual(["eee555"]);
    });

    it("hand the tab stop to a row the pointer focuses", () => {
      dialogCommitRow("fff666").focus();
      expect(tabStopsOf(dialogCommitRows()).map(rowName)).toEqual(["fff666"]);
    });

    it("expand on Enter, asking for the commit's details — and the dialog stays", () => {
      dialogCommitRow("eee555").focus();
      mock.clearMessages();
      const event = press("Enter");
      expect(event.defaultPrevented).toBe(true);
      expect(dialogCommitRow("eee555").classList.contains("commitDetailsOpen")).toBe(true);
      expect(mock.sentOf("redundancyCommitDetails").map((m) => m.commitHash)).toEqual(["eee555"]);
      expect(dialogShown()).toBe(true);
    });

    it("collapse again on Space, without the page scrolling under it", () => {
      const event = press(" ");
      expect(event.defaultPrevented).toBe(true);
      expect(dialogCommitRow("eee555").classList.contains("commitDetailsOpen")).toBe(false);
      expect(dialogShown()).toBe(true);
    });
  });

  describe("an expanded commit's file tree", () => {
    beforeAll(() => {
      dialogCommitRow("ddd444").focus();
      press("Enter");
      receive({
        command: "redundancyCommitDetails",
        commitHash: "ddd444",
        commitDetails: dialogDetails
      });
    });

    it("is one group of folders and files, with one tab stop, on its first row", () => {
      const rows = dialogFileRows();
      expect(rows.map(rowName)).toEqual([
        "src/",
        "src/lib/",
        "src/lib/b.ts",
        "src/lib/c.ts",
        "src/a.ts",
        "README.md"
      ]);
      for (const r of rows) expect(r.hasAttribute("tabindex"), rowName(r)).toBe(true);
      expect(tabStopsOf(rows).map(rowName)).toEqual(["src/"]);
      expect(cdvTabStops()).toEqual(cdvTabStopsBefore);
    });

    it("walks with Down and Up through folders and files alike, stopping at either end", () => {
      fileRow("src/").focus();
      const seen: string[] = [];
      for (const key of [
        "ArrowDown",
        "ArrowDown",
        "ArrowDown",
        "ArrowDown",
        "ArrowDown",
        "ArrowDown",
        "ArrowUp"
      ]) {
        const event = press(key);
        expect(event.defaultPrevented, key).toBe(true);
        seen.push(rowName(document.activeElement));
      }
      expect(seen).toEqual([
        "src/lib/",
        "src/lib/b.ts",
        "src/lib/c.ts",
        "src/a.ts",
        "README.md",
        "README.md",
        "src/a.ts"
      ]);
      expect(tabStopsOf(dialogFileRows()).map(rowName)).toEqual(["src/a.ts"]);
    });

    it("climbs to the parent folder on Left from a file", () => {
      fileRow("src/lib/c.ts").focus();
      press("ArrowLeft");
      expect(rowName(document.activeElement)).toBe("src/lib/");
    });

    it("collapses an open folder on Left, and Down then steps past what it hid", () => {
      press("ArrowLeft");
      expect(rowName(document.activeElement)).toBe("src/lib/");
      expect(folderOpen("src/lib/")).toBe(false);
      press("ArrowDown");
      expect(rowName(document.activeElement)).toBe("src/a.ts");
      press("ArrowUp");
    });

    it("climbs from a collapsed folder on Left, and stays put at the top", () => {
      press("ArrowLeft");
      expect(rowName(document.activeElement)).toBe("src/");
      expect(folderOpen("src/")).toBe(true);
      fileRow("README.md").focus();
      press("ArrowLeft");
      expect(rowName(document.activeElement)).toBe("README.md");
    });

    it("expands a closed folder on Right, then steps into it on the next", () => {
      fileRow("src/lib/").focus();
      press("ArrowRight");
      expect(rowName(document.activeElement)).toBe("src/lib/");
      expect(folderOpen("src/lib/")).toBe(true);
      press("ArrowRight");
      expect(rowName(document.activeElement)).toBe("src/lib/b.ts");
      press("ArrowRight");
      expect(rowName(document.activeElement), "a file has nothing to open").toBe("src/lib/b.ts");
    });

    it("toggles a folder on Enter, and the dialog stays", () => {
      fileRow("src/lib/").focus();
      const event = press("Enter");
      expect(event.defaultPrevented).toBe(true);
      expect(folderOpen("src/lib/")).toBe(false);
      press("Enter");
      expect(folderOpen("src/lib/")).toBe(true);
      expect(dialogShown()).toBe(true);
    });

    it("does nothing on Enter on a file — no diff, no answer to the dialog (#128)", () => {
      fileRow("src/lib/b.ts").focus();
      mock.clearMessages();
      const event = press("Enter");
      expect(event.defaultPrevented).toBe(true);
      expect(mock.sentMessages).toEqual([]);
      expect(dialogShown()).toBe(true);
      expect(document.activeElement).toBe(fileRow("src/lib/b.ts"));
    });

    it("folds a folder the pointer clicks, handing it a tab stop the fold would bury", () => {
      fileRow("src/lib/c.ts").focus();
      mock.clearMessages();
      click(fileRow("src/lib/"));
      expect(folderOpen("src/lib/")).toBe(false);
      expect(tabStopsOf(dialogFileRows()).map(rowName)).toEqual(["src/lib/"]);
      expect(mock.sentMessages).toEqual([]);
      click(fileRow("src/lib/"));
      expect(folderOpen("src/lib/")).toBe(true);
    });

    it("leaves the Commit Details View's tab stop where it was throughout (#113)", () => {
      expect(cdvTabStops()).toEqual(cdvTabStopsBefore);
    });
  });
});
