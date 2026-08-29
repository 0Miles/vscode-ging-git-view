import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitDetails, GitCommitNode, GitFileChange } from "@/backend/types";
import type * as GG from "@/types";
import { generateGitFileListHtml } from "@/webview/utils/fileTree";

import {
  createVscodeMock,
  makeViewState,
  NEAR_BOTTOM,
  parkViewportAt,
  receive,
  setupHtml
} from "./setup";

// The Commit Details View's file list is its own roving-tabindex group, and a
// redraw destroys it the same way it destroys the commit rows: `renderTable`
// rebuilds the table, the panel is rebuilt with it, and focus falls to <body>.
// The commit rows already survive that (ADR-0019: automatic loading is
// browsing, and browsing must move nothing); the file rows did not, and the
// user paid for it twice — focus was gone, and because `moveCdvFileFocus` then
// found nothing to step from, the next arrow key fell through to the graph and
// dropped them out of the file list they were reading.
//
// One webview is booted for the whole file and the scenarios run in order, the
// way a session actually unfolds; re-importing the module per scenario would
// leave the previous instance still listening on `window` (#80).

const viewState = makeViewState({ loadMoreAutomatically: true });

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
    refs: []
  }
];

/** What the next page brings back: loading strictly appends, so the expanded
 *  commit and every file in it is still here — under brand new elements, which
 *  is the whole problem. */
const nextPage: GitCommitNode[] = [
  ...commits,
  {
    hash: "ccc333",
    parentHashes: [],
    author: "Carol",
    email: "carol@example.com",
    date: 1698000000,
    message: "Initial commit",
    refs: []
  }
];

/** A page the *compared* commit is not in — what a sort or filter change lands.
 *  The expanded commit survives it, so the panel is still standing when the
 *  redraw reads the focused file; the comparison it was showing is not. */
const pageWithoutBase: GitCommitNode[] = [commits[0], nextPage[2]];

const branchesResponse: GG.ResponseMessage = {
  command: "loadBranches",
  branches: ["main"],
  head: "main",
  hard: true,
  isRepo: true,
  filter: []
};

function commitsResponse(loaded: GitCommitNode[]): GG.ResponseMessage {
  return {
    command: "loadCommits",
    commits: loaded,
    head: "aaa111",
    moreCommitsAvailable: true,
    hard: true
  };
}

/** Three files, two of them under a folder, so the row the user is on is
 *  neither the first (where the tab stop falls back to) nor the last. */
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
    { oldFilePath: "src/b.ts", newFilePath: "src/b.ts", type: "M", additions: 2, deletions: 1 },
    { oldFilePath: "README.md", newFilePath: "README.md", type: "M", additions: 3, deletions: 0 }
  ]
};

/** What a comparison between the two commits shows — a different set of files
 *  from either commit's own, so which view the focused file came from is never
 *  in doubt. */
const comparisonChanges: GitFileChange[] = [
  { oldFilePath: "src/c.ts", newFilePath: "src/c.ts", type: "M", additions: 4, deletions: 2 },
  {
    oldFilePath: "CHANGELOG.md",
    newFilePath: "CHANGELOG.md",
    type: "M",
    additions: 5,
    deletions: 0
  }
];

function row(hash: string) {
  return document.querySelector<HTMLElement>(`#commitTable tr.commit[data-hash="${hash}"]`)!;
}

/** The file rows the keyboard can reach, in visual order — the same list the
 *  arrow keys walk. */
function fileRows() {
  return Array.from(document.querySelectorAll<HTMLElement>("#commitDetails .gitFile"));
}

function filePathOf(file: Element | null) {
  return decodeURIComponent((<HTMLElement>file).dataset.newfilepath!);
}

function fileTabStops() {
  return Array.from(document.querySelectorAll<HTMLElement>('#commitDetails [tabindex="0"]'));
}

function graphTabStops() {
  return Array.from(document.querySelectorAll<HTMLElement>('#commitTable [tabindex="0"]'));
}

function press(key: string) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("keyboard focus in the Commit Details View's file list", () => {
  const scrollTo = vi.fn();
  const scrollIntoView = vi.fn();
  let mock: ReturnType<typeof createVscodeMock>;

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    // jsdom implements neither, so record what the webview asks for instead.
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    Element.prototype.scrollIntoView = scrollIntoView;
    await import("@/webview/main");
    receive(branchesResponse);
    receive(commitsResponse(commits));
  });

  describe("a redraw arriving while a file holds focus", () => {
    let focusedBefore: HTMLElement;
    let focusedAfterLoad: Element | null = null;
    let requestedOnTrigger: GG.RequestMessage[] = [];
    let movedOnRestore: unknown[] = [];

    beforeAll(() => {
      row("aaa111").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      receive({ command: "commitDetails", commitDetails: tipDetails });
      expect(fileRows().map((f) => filePathOf(f))).toEqual(["src/a.ts", "src/b.ts", "README.md"]);

      // The second file, so restoring it is distinguishable from the tab stop's
      // own fallback onto the first.
      focusedBefore = fileRows()[1];
      focusedBefore.focus();
      expect(document.activeElement).toBe(focusedBefore);

      parkViewportAt(NEAR_BOTTOM);
      scrollTo.mockClear();
      scrollIntoView.mockClear();
      mock.clearMessages();

      // Automatic loading on scroll: the user asked for nothing.
      document.dispatchEvent(new Event("scroll"));
      requestedOnTrigger = mock.sentMessages.filter((m) => m.command === "loadCommits");
      receive(commitsResponse(nextPage));
      focusedAfterLoad = document.activeElement;
      movedOnRestore = [
        ...scrollTo.mock.calls,
        ...scrollIntoView.mock.calls,
        ...mock.sentMessages.filter((m) => m.command !== "loadCommits")
      ];
    });

    it("is the scroll that asks for the next page, not the test handing one over", () => {
      // `receive` would redraw whether or not anything was requested, so without
      // this the whole automatic-loading framing — the stubbed geometry, the
      // threshold, the setting — could rot away underneath a green suite.
      expect(requestedOnTrigger).toMatchObject([{ maxCommits: 400 }]);
    });

    it("redraws the file list, replacing the row that held focus", () => {
      expect(row("ccc333")).not.toBeNull();
      expect(fileRows()).toHaveLength(3);
      expect(fileRows()).not.toContain(focusedBefore);
    });

    it("leaves focus on the same file, in its new row", () => {
      expect(filePathOf(focusedAfterLoad)).toBe("src/b.ts");
      expect(focusedAfterLoad).toBe(fileRows()[1]);
      expect(fileTabStops()).toEqual([fileRows()[1]]);
    });

    it("puts focus back without moving or asking for anything", () => {
      // A redraw is not a focus move: no scroll of any kind, and no second
      // request for details or file contents the user never asked for.
      expect(movedOnRestore).toEqual([]);
    });

    it("carries on through the file list rather than dropping into the graph", () => {
      press("ArrowDown");

      expect(document.activeElement).toBe(fileRows()[2]);
      expect(filePathOf(document.activeElement)).toBe("README.md");
    });
  });

  // The one redraw that reaches the file list holding focus and then cannot
  // give it back. `loadCommits` drops the Commit Details View *before*
  // `renderTable` runs whenever the expanded commit itself leaves the loaded
  // set, so on that path focus is already gone and there is no key to look up.
  // A comparison is different: the expanded commit stays, so the panel is alive
  // when the key is read — and then the redraw finds the *compared* commit
  // missing, falls back to the expanded commit's own details, and tears the
  // panel down after all.
  describe("when the file holding focus is not there after the redraw", () => {
    let focusedAfterRedraw: Element | null = null;

    beforeAll(() => {
      row("bbb222").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
      receive({
        command: "compareCommits",
        fromHash: "bbb222",
        toHash: "aaa111",
        fileChanges: comparisonChanges
      });
      expect(fileRows().map((f) => filePathOf(f))).toEqual(["src/c.ts", "CHANGELOG.md"]);

      fileRows()[0].focus();
      // Without this the scenario could quietly degrade into the "focus was
      // never in the file list" early return and stop reaching the miss at all.
      expect(document.activeElement).toBe(fileRows()[0]);
      mock.clearMessages();

      // A refresh whose page no longer holds the compared commit.
      receive(commitsResponse(pageWithoutBase));
      focusedAfterRedraw = document.activeElement;
    });

    it("has no file list left to put focus back into", () => {
      expect(row("bbb222")).toBeNull();
      expect(document.getElementById("commitDetails")).toBeNull();
      expect(focusedAfterRedraw).toBe(document.body);
    });

    it("finishes the redraw rather than failing part-way through it", () => {
      // The restore runs before the graph's, so a miss that threw would leave
      // the table with no tab stop at all and Tab unable to reach the graph.
      expect(graphTabStops()).toEqual([row("aaa111")]);
      expect(mock.sentMessages.filter((m) => m.command === "reportError")).toEqual([]);
    });

    it("steps on from the commit the view fell back to, as it always did", () => {
      // With no focused row to step from, the arrow keys step from the expanded
      // commit — the pre-existing fallback, reached unchanged.
      press("ArrowDown");
      expect(document.activeElement).toBe(row("ccc333"));
    });
  });

  // The flat File List layout sorts by full path, so `src/b.ts` sits at a
  // different index than it does in the tree — which is the point. An identity
  // that was the row's position rather than the path would put focus on the
  // wrong file here while passing every scenario above.
  describe("a redraw while the file list is in the flat List layout", () => {
    let focusedBefore: HTMLElement;
    let focusedAfterLoad: Element | null = null;

    beforeAll(() => {
      row("aaa111").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      receive({ command: "commitDetails", commitDetails: tipDetails });

      document
        .querySelector<HTMLElement>('.cdvFileViewBtn[data-viewtype="File List"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(document.querySelectorAll("#commitDetails .gitFolder")).toHaveLength(0);
      expect(fileRows().map((f) => filePathOf(f))).toEqual(["README.md", "src/a.ts", "src/b.ts"]);

      focusedBefore = fileRows()[2];
      focusedBefore.focus();
      expect(document.activeElement).toBe(focusedBefore);

      parkViewportAt(NEAR_BOTTOM);
      mock.clearMessages();

      document.dispatchEvent(new Event("scroll"));
      receive(commitsResponse(nextPage));
      focusedAfterLoad = document.activeElement;
    });

    it("stays in the List layout across the redraw", () => {
      expect(document.querySelectorAll("#commitDetails .gitFolder")).toHaveLength(0);
      expect(fileRows()).not.toContain(focusedBefore);
    });

    it("leaves focus on the same file, at the index this layout gives it", () => {
      expect(filePathOf(focusedAfterLoad)).toBe("src/b.ts");
      expect(focusedAfterLoad).toBe(fileRows()[2]);
      expect(fileTabStops()).toEqual([fileRows()[2]]);
    });

    it("carries on through the file list rather than dropping into the graph", () => {
      // Already on the last file, so Down holds it there — the file list is its
      // own group and does not walk out into the commits behind it.
      press("ArrowDown");
      expect(document.activeElement).toBe(fileRows()[2]);
    });
  });

  // The other half of the same condition. Everything above reaches the file
  // list through the roving group itself, which moves the tab stop as part of
  // moving focus; `syncTabStop` is for focus arriving by a route the group did
  // not drive — a click on a row, or Tab from outside — and without it Tab
  // comes back to wherever the user last *arrowed* instead of where they last
  // were. Calling `focus()` directly is that route: the `focusin` listener is
  // the only thing that can move the tab stop here.
  describe("focus arriving on a file row without the arrow keys", () => {
    let tabStopsAtStart: HTMLElement[] = [];
    let tabStopsAfterFocusingFirst: HTMLElement[] = [];
    let tabStopsAfterFocusingBack: HTMLElement[] = [];

    beforeAll(() => {
      tabStopsAtStart = fileTabStops();
      fileRows()[0].focus();
      tabStopsAfterFocusingFirst = fileTabStops();
      // Back to where the scenario above left it, so the next one still starts
      // from a tab stop the user put there rather than one this test moved.
      fileRows()[2].focus();
      tabStopsAfterFocusingBack = fileTabStops();
    });

    it("hands the file list's tab stop to the row focus landed on", () => {
      // The scenario above left it on the last row, so moving to the first is a
      // move the assertion can see.
      expect(tabStopsAtStart).toEqual([fileRows()[2]]);
      expect(tabStopsAfterFocusingFirst).toEqual([fileRows()[0]]);
      // And back again — one row carries it at a time, never two. That is the
      // roving invariant, and it is also how this scenario hands the next one a
      // tab stop the user put there rather than one this test moved.
      expect(tabStopsAfterFocusingBack).toEqual([fileRows()[2]]);
    });
  });

  // A `.gitFile` row is not proof of the Commit Details View. The
  // branch-redundancy dialog shows an expanded commit's files through the very
  // same `generateGitFileListHtml`, so its rows carry the same paths and the
  // same `tabindex`; the rows below are that generator's own output, not a
  // hand-written stand-in, under the wrapper the dialog really builds around
  // them — a `commitDetailsFiles` *class*, not the panel's `#commitDetails` id,
  // which is the one thing that tells the two lists apart.
  //
  // Two groups of keyboard state are at stake and they fail separately. Focus
  // is one: a redraw arriving while focus is in the modal must leave it there
  // rather than hauling the user onto the panel behind it. The tab stop is the
  // other, and it is spent the moment focus *enters* the dialog rather than on
  // any later redraw — `syncTabStop` runs on every `focusin`, so an unscoped
  // `.gitFile` match hands the panel's single `tabindex="0"` to a row in the
  // modal and demotes the row that had it. The panel is then left with none,
  // and `restoreCdvFileTabStop` will not give it one back: while the dialog is
  // open it sees a holder that is still connected and still unhidden and
  // returns early, and once the dialog closes there is nothing to call it until
  // the panel is next rebuilt. So the redraw below is not what breaks the tab
  // stop — it is the first thing that could have repaired it.
  describe("a redraw while focus is on a file row outside the Commit Details View", () => {
    let dialogFile: HTMLElement;
    let cdvFileForSamePath: HTMLElement;
    let tabStopsBeforeDialog: HTMLElement[] = [];
    let tabStopsWhileDialogHasFocus: HTMLElement[] = [];
    let focusedAfterLoad: Element | null = null;
    let tabStopsAfterLoad: HTMLElement[] = [];

    beforeAll(() => {
      const dialog = document.getElementById("dialog")!;
      dialog.innerHTML =
        '<div class="commitDetailsPanel"><div class="commitDetailsFiles">' +
        generateGitFileListHtml(tipDetails.fileChanges, false) +
        "</div></div>";
      dialogFile = dialog.querySelector<HTMLElement>('.gitFile[data-newfilepath="src%2Fb.ts"]')!;
      cdvFileForSamePath = fileRows().find((f) => filePathOf(f) === "src/b.ts")!;
      tabStopsBeforeDialog = fileTabStops();

      dialogFile.focus();
      expect(document.activeElement).toBe(dialogFile);
      tabStopsWhileDialogHasFocus = fileTabStops();

      parkViewportAt(NEAR_BOTTOM);
      mock.clearMessages();

      document.dispatchEvent(new Event("scroll"));
      receive(commitsResponse(nextPage));
      focusedAfterLoad = document.activeElement;
      tabStopsAfterLoad = fileTabStops();
    });

    it("leaves focus in the dialog rather than moving it to the panel's own row", () => {
      expect(focusedAfterLoad).toBe(dialogFile);
      expect(focusedAfterLoad).not.toBe(cdvFileForSamePath);
      expect(document.getElementById("dialog")!.contains(focusedAfterLoad)).toBe(true);
    });

    it("leaves the panel's tab stop where the user left it, on the panel's own row", () => {
      // The scenarios above walked the panel's tab stop onto `src/b.ts` and
      // left it there, so this says the dialog *kept its hands off* it — not
      // that it happens to sit on some row or other.
      expect(tabStopsBeforeDialog).toEqual([cdvFileForSamePath]);
      expect(tabStopsWhileDialogHasFocus).toEqual([cdvFileForSamePath]);
      // And the dialog's own row never became one: its file list is inert, so
      // the row is focusable (the generator ships every row at -1) but is not
      // any group's tab stop.
      expect(dialogFile.tabIndex).toBe(-1);
    });

    it("still lets Tab back into the file list once the redraw has rebuilt it", () => {
      // The consequence the tab stop being stolen actually has. What this is
      // really about is that the count is not zero — zero is a file list Tab can
      // no longer reach at all. The row it names is `restoreCdvFileTabStop`'s
      // existing fallback, which does not carry the user's place across a
      // redraw the way `restoreCdvFileFocus` does; naming it pins today's
      // behaviour rather than endorsing it.
      expect(fileRows()).toHaveLength(3);
      expect(tabStopsAfterLoad).toEqual([fileRows()[0]]);
    });
  });
});
