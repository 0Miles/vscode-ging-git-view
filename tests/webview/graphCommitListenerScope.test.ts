import { beforeAll, describe, expect, it, vi } from "vitest";

import type { BranchRedundancy, GitCommitDetails, GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

import { createVscodeMock, DEFAULT_REPO, makeViewState, receive, setupHtml } from "./setup";

// The graph binds its commit rows' click and context menu in `renderTable`, and
// it used to bind them through `addListenerToClass` / `addContextMenuListener`,
// which are `document.getElementsByClassName` and so have no scope at all. The
// branch-redundancy dialog renders `tr.commit` rows of its own, so every redraw
// behind a standing dialog wired the graph's handlers onto rows for commits the
// graph never loaded (issue #144).
//
// This is the twin of #128 one class family over, and the worse of the two.
// #128's handlers opened a diff at the wrong revision — misleading, but
// read-only. These ones raise the graph's *full* commit menu: Checkout, Reset,
// Rebase, Cherry Pick, Revert, Add Tag, Create Branch, every one of them
// repo-mutating, on a commit picked out of a modal. Left-click was quieter and
// not harmless either — it ran `loadCommitDetails` for that hash, which asks the
// host for details *and* closes the panel standing behind the dialog on its way.
//
// The fix is a scope, not a guard: the graph's handlers bind within
// `#commitTable`, the boundary `graphRows` already draws for the focus path. The
// third member of the family travels with them — `commitSummaryHtml` emits
// `.commitBodyLink` whether or not it is `interactive`, so the dialog carries
// those too; theirs is the *panel's* boundary (`#commitDetails`) rather than the
// table's, because a docked panel is not inside the table at all.
//
// So the invariant is "the dialog's own rows do nothing", and the scenarios are
// the measured defects it retires — plus the graph's own rows and the panel's
// own links, which say the boundary landed between the surfaces rather than
// around nothing, and the dialog's own expand/collapse, which says the dialog
// kept the one handler that really is its own.
//
// One webview is booted for the whole file and the scenarios run in order, the
// way a session actually unfolds; re-importing the module per scenario would
// leave the previous instance still listening on `window` (#80).

const L = getWebviewLocalizedStrings();

const E = "…"; // the rendered form of the ELLIPSIS entity

const viewState = makeViewState();

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

const branchesResponse: GG.ResponseMessage = {
  command: "loadBranches",
  branches: ["main", "feature"],
  head: "main",
  hard: true,
  isRepo: true,
  filter: []
};

/** `hard`, so the reload never takes `loadCommits`'s unchanged short-circuit:
 *  each one is a real redraw, which is the only thing that rebinds. */
const commitsResponse: GG.ResponseMessage = {
  command: "loadCommits",
  commits,
  head: "aaa111",
  moreCommitsAvailable: false,
  hard: true
};

/** The commit the graph has expanded. Its author address is what the panel's own
 *  `.commitBodyLink` carries, and so what tells the panel's link apart from the
 *  dialog's in the one assertion that has to name a value. */
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
    { oldFilePath: "src/a.ts", newFilePath: "src/a.ts", type: "M", additions: 1, deletions: 0 }
  ]
};

/** A commit only the dialog is showing, and not one the graph has loaded at all
 *  — `ddd444` is absent from `commits`, so a `commitDetails` request naming it
 *  can only have come from a dialog row. Its address is `dana@example.com` for
 *  the same reason on the `.commitBodyLink` half. */
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
    {
      oldFilePath: "dialog/only.ts",
      newFilePath: "dialog/only.ts",
      type: "M",
      additions: 7,
      deletions: 0
    }
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

let mock: ReturnType<typeof createVscodeMock>;

function click(elem: Element) {
  elem.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function rightClick(elem: Element) {
  elem.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
}

/** The keyboard's way of raising a context menu, mirroring `main.ts`'s private
 *  `MENU_KEY_EVENT`. Dispatched directly rather than via Shift+F10, because the
 *  document keydown handler that would normally synthesise it returns early
 *  while a dialog stands — so today no key reaches a dialog row at all (#141,
 *  #145). What is asserted here is the *binding*, which is what
 *  `addGraphContextMenuListener` wires and what would outlive either of those
 *  tickets landing. */
const MENU_KEY_EVENT = "ging.contextMenuKey";

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

/** A `.commitBodyLink` under `root`, addressed by the address it points at:
 *  `commitSummaryHtml` emits one per commit for the author and one for the
 *  committer, and both surfaces render them. */
function bodyLink(root: string, email: string) {
  const elem = document.querySelector<HTMLElement>(
    `${root} .commitBodyLink[href="mailto:${encodeURIComponent(email)}"]`
  );
  expect(elem, `${root} ${email}`).not.toBeNull();
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

/** Every child of the open menu, dividers included, so that "nothing opened" is
 *  asserted against the whole element rather than against the items alone. */
function contextMenuEntries() {
  return Array.from(document.getElementById("contextMenu")!.children).map((li) =>
    (li.textContent ?? "").trim()
  );
}

/** Just the actionable labels, which is what a menu's *contents* are asked
 *  about — the dividers between them are not items and carry no text. */
function menuItemLabels() {
  return Array.from(document.querySelectorAll<HTMLElement>("#contextMenu .contextMenuItem")).map(
    (li) => (li.textContent ?? "").trim()
  );
}

/** The seven the ticket names: everything on the graph's commit menu that
 *  changes the repository. Written out here rather than derived from the menu,
 *  because the point of the list is what a user could do from a modal by
 *  accident, not how `main.ts` happens to assemble it. */
const REPO_MUTATING_ITEMS = [
  L.checkout + E,
  L.reset + E,
  L.rebaseOnCommit + E,
  L.cherryPick + E,
  L.revert + E,
  L.addTag + E,
  L.createBranch + E
];

function hideMenu() {
  document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
}

/** A soft refresh landing behind the standing dialog — the file watcher's, or
 *  any of the other redraws that leave the panel open. Each one re-runs
 *  `renderTable` and, with the panel open, `renderCommitDetailsPanel` too, which
 *  between them are the only things that bind. */
function redrawPanel() {
  receive(commitsResponse);
  expect(document.getElementById("commitDetails"), "the panel survived the redraw").not.toBeNull();
}

describe("the graph's commit actions, with a dialog showing commit rows of its own", () => {
  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    await import("@/webview/main");
    receive(branchesResponse);
    receive(commitsResponse);

    // The graph's Commit Details View, expanded on the tip commit. It has to be
    // open for `renderCommitDetailsPanel` — and so the `.commitBodyLink`
    // binding — to run at all on a redraw.
    click(graphRow("aaa111"));
    receive({ command: "commitDetails", commitDetails: tipDetails });

    // The branch-redundancy dialog, driven the way a user reaches it, down to
    // the row they expand — the dialog's summary, and so its own
    // `.commitBodyLink`s, are built by the answer to that expansion.
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
    click(dialogRow("ddd444"));
    receive({
      command: "redundancyCommitDetails",
      commitHash: "ddd444",
      commitDetails: dialogDetails
    });
  });

  it("has both surfaces standing, each with its own commits", () => {
    // Without this the scenarios below could pass on a dialog that never
    // rendered a commit row or a body link at all.
    expect(
      Array.from(document.querySelectorAll<HTMLElement>("#commitTable tr.commit")).map(
        (r) => r.dataset.hash
      )
    ).toEqual(["aaa111", "bbb222"]);
    expect(
      Array.from(document.querySelectorAll<HTMLElement>("#dialog .commitList tr.commit")).map(
        (r) => r.dataset.hash
      )
    ).toEqual(["ddd444"]);
    // `ddd444` is not a commit the graph has: that is what makes a request for
    // its details attributable to the dialog and to nothing else.
    expect(document.querySelector('#commitTable tr.commit[data-hash="ddd444"]')).toBeNull();
    expect(bodyLink("#dialog", "dana@example.com")).not.toBeNull();
    expect(bodyLink("#commitDetails", "alice@example.com")).not.toBeNull();
  });

  describe("a commit row of the dialog's, asked for a menu after a redraw", () => {
    let byPointer: string[] = [];
    let byMenuKey: string[] = [];
    let sent: GG.RequestMessage[] = [];

    beforeAll(() => {
      redrawPanel();
      mock.clearMessages();
      rightClick(dialogRow("ddd444"));
      byPointer = contextMenuEntries();
      dialogRow("ddd444").dispatchEvent(new Event(MENU_KEY_EVENT, { bubbles: true }));
      byMenuKey = contextMenuEntries();
      sent = [...mock.sentMessages];
    });

    it("opens no menu, by pointer or by menu key", () => {
      // What used to open here is the graph's own commit menu, complete and
      // entirely plausible, on a commit the graph never loaded. The menu key is
      // bound alongside the pointer, so a scope applied to one and not the other
      // would leave half the door open.
      expect(byPointer).toEqual([]);
      expect(byMenuKey).toEqual([]);
      expect(document.getElementById("contextMenu")!.classList.contains("active")).toBe(false);
      expect(sent).toEqual([]);
    });

    it("offers none of the seven repo-mutating actions, which is the point", () => {
      // Stated separately from "no menu" because this is the harm the ticket is
      // actually about: a menu with nothing on it is a tidiness problem, and a
      // menu with Reset on it aimed at an arbitrary commit is not.
      for (const label of REPO_MUTATING_ITEMS) expect(byPointer).not.toContain(label);
    });
  });

  describe("a body link of the dialog's, right-clicked after a redraw", () => {
    let entries: string[] = [];

    beforeAll(() => {
      hideMenu();
      rightClick(bodyLink("#dialog", "dana@example.com"));
      entries = contextMenuEntries();
    });

    it("opens no menu", () => {
      // `commitSummaryHtml` emits `.commitBodyLink` whether or not it is
      // `interactive`, so the dialog carries them despite asking for the
      // non-interactive rendering; the panel's Copy Link handler was bound
      // document-wide and reached them.
      expect(entries).toEqual([]);
      expect(document.getElementById("contextMenu")!.classList.contains("active")).toBe(false);
    });
  });

  // The other half of a scope, and the half a scope drawn too tightly would
  // fail: everything above holds just as well for a graph whose rows were never
  // bound at all. These say the boundary lands between the surfaces.
  describe("the graph's own commit row, with the dialog still standing", () => {
    let labels: string[] = [];

    beforeAll(() => {
      hideMenu();
      rightClick(graphRow("bbb222"));
      labels = menuItemLabels();
    });

    it("still raises the full commit menu", () => {
      expect(labels).toContain(L.copyCommitHash);
      expect(labels.length).toBeGreaterThan(REPO_MUTATING_ITEMS.length);
    });

    it("still offers every one of the repo-mutating actions", () => {
      for (const label of REPO_MUTATING_ITEMS) expect(labels).toContain(label);
    });
  });

  describe("the panel's own body link, with the dialog still standing", () => {
    let entries: string[] = [];

    beforeAll(() => {
      hideMenu();
      rightClick(bodyLink("#commitDetails", "alice@example.com"));
      entries = menuItemLabels();
    });

    it("still raises Copy Link", () => {
      expect(entries).toEqual([L.copyLink]);
    });
  });

  describe("a commit row of the dialog's, left-clicked after a redraw", () => {
    let sent: GG.RequestMessage[] = [];
    let panelSurvived = false;
    let dialogRowCollapsed = false;

    beforeAll(() => {
      hideMenu();
      mock.clearMessages();
      click(dialogRow("ddd444"));
      sent = [...mock.sentMessages];
      panelSurvived = document.getElementById("commitDetails") !== null;
      dialogRowCollapsed = !dialogRow("ddd444").classList.contains("commitDetailsOpen");
      // Put it back, so the scenarios after this one see the expanded row the
      // suite has described all along rather than one this test folded.
      click(dialogRow("ddd444"));
    });

    it("asks the host for nothing", () => {
      // It used to send `commitDetails` for `ddd444` — a commit the graph has
      // never loaded — into the panel standing behind the dialog.
      expect(sent).toEqual([]);
    });

    it("leaves the panel behind the dialog open", () => {
      // `loadCommitDetails` calls `hideCommitDetails` before it sends anything,
      // so the click did not merely show the wrong commit: it closed the right
      // one on the way, and the user was looking at the dialog when it happened.
      expect(panelSurvived).toBe(true);
    });

    it("still collapses the dialog's own row, which is the dialog's to handle", () => {
      // The dialog binds this itself, within `#dialog`, and always did. Scoping
      // the graph's handlers must not take the dialog's with them.
      expect(dialogRowCollapsed).toBe(true);
    });
  });

  describe("the same dialog row, after three more redraws", () => {
    let sent: GG.RequestMessage[] = [];
    let entries: string[] = [];

    beforeAll(() => {
      redrawPanel();
      redrawPanel();
      redrawPanel();
      mock.clearMessages();
      click(dialogRow("ddd444"));
      sent = [...mock.sentMessages];
      click(dialogRow("ddd444"));
      rightClick(dialogRow("ddd444"));
      entries = contextMenuEntries();
    });

    it("still does nothing, rather than one thing per redraw", () => {
      // The dialog's rows are never replaced, so each redraw used to leave
      // another copy of the handler on them: one click sent two `commitDetails`,
      // then three, then four. Nothing is not a small number here — it is the
      // only count that does not depend on how long the dialog has been open.
      expect(sent).toEqual([]);
      expect(entries).toEqual([]);
    });
  });

  describe("the graph's own row, left-clicked last of all", () => {
    let sent: GG.RequestMessage[] = [];

    beforeAll(() => {
      hideMenu();
      mock.clearMessages();
      click(graphRow("bbb222"));
      sent = [...mock.sentMessages];
    });

    it("still asks the host for that commit's details", () => {
      expect(sent).toEqual([
        {
          command: "commitDetails",
          repo: DEFAULT_REPO,
          commitHash: "bbb222",
          isStash: false
        }
      ]);
    });
  });
});
