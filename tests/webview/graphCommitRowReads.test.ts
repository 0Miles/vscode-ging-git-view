import { beforeAll, describe, expect, it, vi } from "vitest";

import type { BranchRedundancy, GitCommitDetails, GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

import { createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// #144 scoped the graph's *bindings* to `#commitTable`. It left the *reads*
// alone, and said so: eight lookups of a commit row still started at `document`,
// so each one took whichever `tr.commit` came first in the whole page rather
// than the one the graph drew.
//
// What made them agree with the graph anyway is a fact about `buildWebviewMarkup`
// and about nothing else: `#commitTable` is written before `#dialog`, and
// `querySelector` answers in document order. The branch-redundancy dialog emits
// `<tr class="commit" data-hash="…">` from `redundancyCommitRow`, so the two
// surfaces have been competing for every one of those reads all along and the
// graph has been winning on markup order (#150).
//
// So this suite removes that coincidence rather than reasoning about it: `#dialog`
// is moved ahead of the graph in the document before the webview boots, and it is
// given commit rows carrying the graph's own hashes and ids. Every read then has
// two candidates and the wrong one first, which is the only arrangement in which
// "it reads the graph's tree" is an assertion rather than a restatement of the
// markup. A read that is still document-wide answers with a dialog row here, and
// each scenario below names what that costs.
//
// The last scenario drops the stand-in and drives the real dialog end to end —
// ref menu, Check Redundancy, the row the user expands — because the heaviest
// read is also the one whose damage is worth seeing built by the code that really
// builds it: `renderTable` picks the row an inline Commit Details View is
// inserted after, so a dialog row puts the panel *inside the modal*.
//
// One webview is booted for the whole file and the scenarios run in order, the
// way a session actually unfolds; re-importing the module per scenario would
// leave the previous instance still listening on `window` (#80).

const L = getWebviewLocalizedStrings();

const viewState = makeViewState();

const commits: GitCommitNode[] = [
  {
    hash: "aaa111",
    parentHashes: ["bbb222"],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Fix the tip",
    refs: [{ hash: "aaa111", name: "main", type: "head" }]
  },
  {
    hash: "sss555",
    parentHashes: ["bbb222"],
    author: "Alice",
    email: "alice@example.com",
    date: 1699500000,
    message: "WIP on main",
    refs: [{ hash: "sss555", name: "stash@{0}", type: "stash" }]
  },
  {
    hash: "bbb222",
    parentHashes: ["ccc333"],
    author: "Bob",
    email: "bob@example.com",
    date: 1699000000,
    message: "Base commit",
    refs: [{ hash: "bbb222", name: "feature", type: "head" }]
  },
  {
    hash: "ccc333",
    parentHashes: [],
    author: "Carol",
    email: "carol@example.com",
    date: 1698000000,
    message: "Fix the base too",
    refs: []
  }
];

const branchesResponse: GG.ResponseMessage = {
  command: "loadBranches",
  branches: ["main", "feature"],
  head: "main",
  hard: true,
  isRepo: true,
  filter: []
};

/** `hard`, so the reload never takes `loadCommits`'s unchanged short-circuit:
 *  each one is a real redraw, which is the only thing that re-runs the
 *  re-attach. */
const commitsResponse: GG.ResponseMessage = {
  command: "loadCommits",
  commits,
  head: "aaa111",
  moreCommitsAvailable: false,
  hard: true
};

function details(hash: string, parents: string[], body: string): GitCommitDetails {
  const commit = commits.find((c) => c.hash === hash)!;
  return {
    hash,
    parents,
    author: commit.author,
    email: commit.email,
    committer: commit.author,
    committerEmail: commit.email,
    authorDate: commit.date,
    commitDate: commit.date,
    body,
    fileChanges: [
      { oldFilePath: "src/a.ts", newFilePath: "src/a.ts", type: "M", additions: 1, deletions: 0 }
    ]
  };
}

/** What the real dialog is shown in the final scenario. `bbb222` is deliberately
 *  a commit the graph *has*: a redundancy check on `feature` lists the commits
 *  that branch still carries, and those are routinely on screen. The hash the two
 *  surfaces share is the whole mechanism, so a fixture where they could never
 *  collide would assert nothing. */
const redundancyResult: BranchRedundancy = {
  kind: "unmerged",
  defaultBranch: "main",
  defaultBranchDate: 1700000000,
  commits: [
    {
      hash: "bbb222",
      subject: "Base commit",
      author: "Bob",
      email: "bob@example.com",
      date: 1699000000,
      covered: false
    }
  ],
  truncated: false
};

let mock: ReturnType<typeof createVscodeMock>;

function click(elem: Element) {
  elem.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function rightClick(elem: Element) {
  elem.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
}

/** A commit row of the graph's, addressed through the table so the selector says
 *  which surface it wants. Both surfaces render `tr.commit[data-hash]` — that is
 *  the whole subject of this suite. */
function graphRow(hash: string) {
  const elem = document.querySelector<HTMLElement>(`#commitTable tr.commit[data-hash="${hash}"]`);
  expect(elem, hash).not.toBeNull();
  return elem!;
}

function dialogRow(hash: string) {
  const elem = document.querySelector<HTMLElement>(
    `#dialog .commitList tr.commit[data-hash="${hash}"]`
  );
  expect(elem, hash).not.toBeNull();
  return elem!;
}

/** Activate a context-menu item by its label. `toBeDefined`, not
 *  `not.toBeNull`: `find` yields `undefined` when nothing matches (#131). */
function clickItem(label: string) {
  const item = Array.from(
    document.querySelectorAll<HTMLElement>("#contextMenu .contextMenuItem")
  ).find((li) => (li.textContent ?? "").trim() === label);
  expect(item, label).toBeDefined();
  click(item!);
}

function openMenuOn(selector: string) {
  const elem = document.querySelector<HTMLElement>(selector);
  expect(elem, selector).not.toBeNull();
  rightClick(elem!);
}

/** Put `#dialog` ahead of the graph in document order, which is the one thing
 *  standing between these reads and the dialog's rows today.
 *
 *  Not a hypothetical rearrangement: `buildWebviewMarkup` is free to order its
 *  own children, nothing in it records that `#commitTable` must come first, and
 *  a future dialog drawn into `#content` would land ahead of the table without
 *  moving anything at all. Done before the module is imported so the webview
 *  boots into the layout it is being asked about — `insertBefore` moves the same
 *  element, so the module-level `getElementById("dialog")` still resolves. */
function moveDialogAheadOfTheGraph() {
  const dialog = document.getElementById("dialog")!;
  const content = document.getElementById("content")!;
  document.body.insertBefore(dialog, content);
}

/** Commit rows that are not the graph's, standing in `#dialog` where the real
 *  dialog's would be.
 *
 *  Same shape as `redundancyCommitRow`'s output and the same hashes as the
 *  graph's rows, plus two things the real dialog does not emit today: `data-id`,
 *  and a `.gitRef` chip on the first row. Both are deliberate rather than
 *  incidental. `commitDetailsNavigateGraph` looks a row up *by id* and
 *  `clearFindHighlights` strips a class off `.gitRef`s, and the ticket's claim is
 *  that these reads are one markup change away from reaching the wrong element —
 *  a claim a fixture that quietly withheld the attribute could not test. Note
 *  that this is only true of the *reads*: the `gitRef` **bindings** are a
 *  separate, still-unscoped family the ticket leaves for later, and nothing here
 *  binds anything to these chips.
 *
 *  Left standing until the final scenario, which drops it for the dialog the
 *  product really draws. */
function standInDialogRows() {
  document.getElementById("dialog")!.innerHTML =
    '<div class="commitList"><table>' +
    commits
      .map(
        (c, i) =>
          `<tr class="commit" data-hash="${c.hash}" data-id="${i}"><td>${c.message}` +
          (i === 0 ? '<span class="gitRef head" data-name="main">main</span>' : "") +
          "</td></tr>"
      )
      .join("") +
    "</table></div>";
}

/** The graph's chip for branch `name`, and the dialog's stand-in for it. Both
 *  carry `data-name="main"`, so neither selector can be satisfied by the other's
 *  element. */
function graphRefChip(name: string) {
  const elem = document.querySelector<HTMLElement>(`#commitTable .gitRef[data-name="${name}"]`);
  expect(elem, name).not.toBeNull();
  return elem!;
}

function dialogRefChip() {
  const elem = document.querySelector<HTMLElement>('#dialog .gitRef[data-name="main"]');
  expect(elem, "the dialog's stand-in ref chip").not.toBeNull();
  return elem!;
}

/** A soft refresh landing on the open panel — the file watcher's, or any of the
 *  other redraws that leave it open. Each one re-runs `renderTable`, and with the
 *  panel open the re-attach it ends with. */
function redraw() {
  receive(commitsResponse);
}

/** Which surface a row belongs to, asked of the row rather than of the selector
 *  that found it. Every assertion below is about the tree a read answered from,
 *  and both trees hold a row for every hash — so the hash alone never says which
 *  one was reached. */
function surfaceOf(elem: Element | null) {
  if (elem === null) return "none";
  if (elem.closest("#commitTable") !== null) return "graph";
  if (elem.closest("#dialog") !== null) return "dialog";
  return "elsewhere";
}

/** Every row centred since the last clear, as `surface/hash`.
 *
 *  The receiver is recorded rather than the argument: `scrollIntoView` is stubbed
 *  on the prototype (jsdom has none), so the element it was called on is the only
 *  evidence of which row a read resolved. */
const scrolledTo: string[] = [];
const scrollIntoView = vi.fn(function (this: Element) {
  scrolledTo.push(`${surfaceOf(this)}/${(this as HTMLElement).dataset.hash}`);
});

/** Which rows are flashing, as `surface/hash`. `blinkRow` leaves the class on for
 *  700ms, which no scenario here outlives. */
function blinking() {
  return Array.from(document.querySelectorAll<HTMLElement>("tr.blinking")).map(
    (r) => `${surfaceOf(r)}/${r.dataset.hash}`
  );
}

/** Every row the Commit Details View is anchored to, as `surface/hash`. A
 *  comparison anchors two — the expanded row and the compared one — and they are
 *  resolved by two separate reads, so this is what tells them apart. */
function openRows() {
  return Array.from(document.querySelectorAll<HTMLElement>("tr.commitDetailsOpen")).map(
    (r) => `${surfaceOf(r)}/${r.dataset.hash}`
  );
}

function ctrlClick(elem: Element) {
  elem.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
}

function pressCtrl(key: string) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true }));
}

/** Type a search. The widget searches on `keyup`, one keystroke at a time; the
 *  key itself only has to be neither Enter (step) nor Escape (close). */
function search(query: string) {
  const input = document.getElementById("findInput") as HTMLInputElement;
  input.value = query;
  input.dispatchEvent(new KeyboardEvent("keyup", { key: "x", bubbles: true }));
}

/** Every row wearing find highlighting anywhere in the page, in document order,
 *  as `surface/hash`. Asked of the whole document rather than of the table,
 *  because "the graph's rows are marked" and "the dialog's are not" are the two
 *  halves of one claim and a table-scoped query could only ever see the first. */
function findMatches() {
  return Array.from(document.querySelectorAll<HTMLElement>("tr.findMatch")).map(
    (r) => `${surfaceOf(r)}/${r.dataset.hash}`
  );
}

function currentFindMatch() {
  const row = document.querySelector<HTMLElement>("tr.findMatchCurrent");
  return row === null ? "none" : `${surfaceOf(row)}/${row.dataset.hash}`;
}

/** Where the Commit Details View ended up. An inline panel is `insertAfter`'d
 *  onto whatever row the re-attach resolved, so its container names the tree that
 *  read answered from. */
function panelSurface() {
  const panel = document.getElementById("commitDetails");
  expect(panel, "a panel is open").not.toBeNull();
  return surfaceOf(panel);
}

describe("the graph's commit-row reads, with a dialog's rows ahead of them", () => {
  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    moveDialogAheadOfTheGraph();
    Element.prototype.scrollIntoView = scrollIntoView;
    await import("@/webview/main");
    receive(branchesResponse);
    receive(commitsResponse);
    standInDialogRows();

    // The graph's Commit Details View, expanded on the tip commit: the re-attach
    // below only runs when one is open.
    click(graphRow("aaa111"));
    receive({
      command: "commitDetails",
      commitDetails: details("aaa111", ["bbb222"], "Fix the tip")
    });
  });

  it("has the dialog's rows first, carrying the graph's own hashes", () => {
    // Without this every scenario below could pass on a page where the graph's
    // row was the only candidate — which is the arrangement the ticket says is a
    // coincidence, and the one this suite exists to stop relying on.
    const dialog = document.getElementById("dialog")!;
    const table = document.getElementById("commitTable")!;
    expect(dialog.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      Array.from(document.querySelectorAll<HTMLElement>("#dialog tr.commit")).map(
        (r) => r.dataset.hash
      )
    ).toEqual(["aaa111", "sss555", "bbb222", "ccc333"]);
    expect(
      Array.from(document.querySelectorAll<HTMLElement>("#commitTable tr.commit")).map(
        (r) => r.dataset.hash
      )
    ).toEqual(["aaa111", "sss555", "bbb222", "ccc333"]);
    // The first `tr.commit` in the page is now the dialog's, for every hash.
    expect(
      document.querySelector<HTMLElement>('tr.commit[data-hash="aaa111"]')!.closest("#dialog")
    ).not.toBeNull();
  });

  describe("a redraw re-attaching the expanded commit", () => {
    beforeAll(() => {
      redraw();
    });

    it("inserts the panel after the graph's row, not the dialog's", () => {
      expect(panelSurface()).toBe("graph");
      expect(document.getElementById("commitDetails")!.previousElementSibling).toBe(
        graphRow("aaa111")
      );
    });
  });

  // Locate HEAD and Next Stash are the two commands whose whole job is "show me
  // that row". Answered from the wrong tree they scroll and flash a row inside
  // the dialog, so the graph does not move at all and the command reads as dead.
  describe("locating HEAD", () => {
    beforeAll(() => {
      scrolledTo.length = 0;
      click(document.getElementById("blinkHeadBtn")!);
    });

    it("centres and flashes the graph's HEAD row", () => {
      expect(scrolledTo).toEqual(["graph/aaa111"]);
      expect(blinking()).toEqual(["graph/aaa111"]);
    });
  });

  describe("cycling to the next stash", () => {
    beforeAll(() => {
      scrolledTo.length = 0;
      pressCtrl("s");
    });

    it("centres and flashes the graph's stash row", () => {
      expect(scrolledTo).toEqual(["graph/sss555"]);
      // HEAD's flash from the scenario above has not timed out yet, which is
      // what makes this list rather than a single entry: what matters is that
      // neither flash landed on a dialog row.
      expect(blinking().filter((r) => r.endsWith("/sss555"))).toEqual(["graph/sss555"]);
      expect(blinking().every((r) => r.startsWith("graph/"))).toBe(true);
    });
  });

  // The two reads that hand what they find to `loadCommitDetails`, which takes
  // the row as the panel's new source — so a dialog row does not merely mislead,
  // it moves the Commit Details View into the modal on the spot, the same wound
  // the re-attach inflicts one redraw later.
  describe("stepping the Commit Details View to the parent commit", () => {
    beforeAll(() => {
      // Ctrl+Down: the pair ADR-0014 set aside as orthogonal to it, walking the
      // graph's parent/child links rather than moving row focus. It resolves its
      // target by `data-id` — an index into the graph's loaded commits, which is
      // meaningless on any row the graph did not draw.
      pressCtrl("ArrowDown");
      receive({
        command: "commitDetails",
        commitDetails: details("bbb222", ["ccc333"], "Base commit")
      });
    });

    it("opens the parent's panel on the graph's row", () => {
      expect(panelSurface()).toBe("graph");
      expect(document.getElementById("commitDetails")!.previousElementSibling).toBe(
        graphRow("bbb222")
      );
    });
  });

  describe("following a parent-hash chip in the panel", () => {
    beforeAll(() => {
      scrolledTo.length = 0;
      click(
        document.querySelector<HTMLElement>('#commitDetails .commitBodyHash[data-hash="ccc333"]')!
      );
      receive({
        command: "commitDetails",
        commitDetails: details("ccc333", [], "Fix the base too")
      });
    });

    it("centres the graph's row for the parent and opens its panel there", () => {
      expect(scrolledTo).toEqual(["graph/ccc333"]);
      expect(panelSurface()).toBe("graph");
      expect(document.getElementById("commitDetails")!.previousElementSibling).toBe(
        graphRow("ccc333")
      );
    });
  });

  // Find resolves its matches against `this.commits` and then goes to the DOM
  // only to paint them. Painting the dialog's copy leaves the graph's row
  // unmarked while the counter says a match is current — the search reads as
  // broken, and the "bring the current match into view" scroll lands in a modal.
  describe("highlighting a search", () => {
    beforeAll(() => {
      scrolledTo.length = 0;
      click(document.getElementById("findBtn")!);
      search("Fix");
    });

    it("marks the graph's matching rows and centres the graph's current one", () => {
      expect(findMatches()).toEqual(["graph/aaa111", "graph/ccc333"]);
      expect(currentFindMatch()).toBe("graph/aaa111");
      expect(scrolledTo).toEqual(["graph/aaa111"]);
    });
  });

  describe("re-highlighting after the search changes", () => {
    beforeAll(() => {
      // Marks that Find did not put there. Every pass clears before it paints,
      // and the clear was document-wide too — so it reached across into the
      // modal to strip classes off rows it had never marked. The dialog's rows
      // are not the graph's to act on, reading included.
      //
      // The ref mark is seeded on both surfaces because `findBranchMatch` is the
      // one class here whose *paint* this suite cannot reach: it needs a branch
      // search index, which no scenario delivers. Seeding both says what the
      // scoping of that half actually changed — the graph's is cleared, the
      // dialog's is not — without pretending the paint was exercised.
      document
        .querySelector<HTMLElement>('#dialog tr.commit[data-hash="aaa111"]')!
        .classList.add("findMatch");
      dialogRefChip().classList.add("findBranchMatch");
      graphRefChip("main").classList.add("findBranchMatch");
      scrolledTo.length = 0;
      // A query with exactly one match, and not one of the previous search's, so
      // the graph's marks have to have both moved and been cleared.
      search("WIP");
    });

    it("moves the graph's highlighting and leaves the dialog's row alone", () => {
      expect(findMatches()).toEqual(["dialog/aaa111", "graph/sss555"]);
      expect(currentFindMatch()).toBe("graph/sss555");
      expect(scrolledTo).toEqual(["graph/sss555"]);
    });

    it("clears the graph's branch marks without reaching into the dialog", () => {
      expect(graphRefChip("main").classList.contains("findBranchMatch")).toBe(false);
      expect(dialogRefChip().classList.contains("findBranchMatch")).toBe(true);
    });
  });

  // The re-attach resolves *two* rows, by two separate reads, and the second one
  // is easy to miss: the panel is only ever inserted after the primary, so where
  // the panel lands says nothing at all about where the compared row came from.
  // What it costs is the same though — `compareWithSrcElem` pointing inside the
  // modal — and it shows in which row the comparison anchors itself to.
  describe("a redraw re-attaching a two-commit comparison", () => {
    beforeAll(() => {
      click(graphRow("aaa111"));
      receive({
        command: "commitDetails",
        commitDetails: details("aaa111", ["bbb222"], "Fix the tip")
      });
      // CTRL-click a second row: the graph's, so only the *redraw* below can
      // move the comparison onto a row that is not.
      ctrlClick(graphRow("ccc333"));
      const asked = mock.sentMessages.filter((m) => m.command === "compareCommits");
      const last = asked[asked.length - 1] as Extract<
        GG.RequestMessage,
        { command: "compareCommits" }
      >;
      // Echoed back rather than restated, because the ordering of the pair is
      // the webview's own (it sorts by loaded-commit index) and a guess that
      // disagreed would be dropped as a stale response.
      receive({
        command: "compareCommits",
        fromHash: last.fromHash,
        toHash: last.toHash,
        fileChanges: [
          {
            oldFilePath: "src/a.ts",
            newFilePath: "src/a.ts",
            type: "M",
            additions: 2,
            deletions: 1
          }
        ]
      });
      // The table's rows are replaced wholesale, so both anchors have to be
      // found again — which is the moment the compared one could come back from
      // the wrong tree.
      redraw();
    });

    it("anchors both ends of the comparison in the graph", () => {
      expect(openRows()).toEqual(["graph/aaa111", "graph/ccc333"]);
    });
  });

  describe("the real branch-redundancy dialog, standing over a redraw", () => {
    beforeAll(() => {
      // The graph expanded on the very commit the dialog is about to list, which
      // is what puts the two surfaces in competition for one hash.
      click(graphRow("bbb222"));
      receive({
        command: "commitDetails",
        commitDetails: details("bbb222", ["ccc333"], "Base commit")
      });

      // Driven the way a user reaches it, so the dialog's rows come from
      // `redundancyCommitRow` rather than from this file.
      openMenuOn('#commitTable .gitRef.head[data-name="feature"]');
      clickItem(L.checkRedundancy);
      const requested = mock.sentMessages.filter((m) => m.command === "branchRedundancy");
      expect(requested).toHaveLength(1);
      receive({
        command: "branchRedundancy",
        branch: "feature",
        result: redundancyResult,
        token: (requested[0] as Extract<GG.RequestMessage, { command: "branchRedundancy" }>).token
      });
    });

    it("has a real dialog row for the expanded commit, ahead of the graph's", () => {
      expect(dialogRow("bbb222")).not.toBeNull();
      expect(
        document.querySelector<HTMLElement>('tr.commit[data-hash="bbb222"]')!.closest("#dialog")
      ).not.toBeNull();
    });

    it("keeps the panel in the graph when a refresh lands behind it", () => {
      redraw();
      expect(panelSurface()).toBe("graph");
      expect(document.getElementById("commitDetails")!.previousElementSibling).toBe(
        graphRow("bbb222")
      );
    });
  });
});
