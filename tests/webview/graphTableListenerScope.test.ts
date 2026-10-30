import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

import {
  clickElem,
  createVscodeMock,
  graphRow,
  makeViewState,
  receive,
  rightClick,
  setupHtml
} from "./setup";

// #144 scoped the graph's commit-row bindings to `#commitTable` and #150 its
// reads. Six bindings on the graph's table were left starting at `document`
// (#166): the ref chip's `click`, `dblclick` and context menu, the
// uncommitted-changes row's menu and the column header's menu, all made in
// `renderTable`, and the resize handle's `mousedown`, made in
// `makeTableResizable`. They were fine for the reason `tr.commit` was fine until
// it was not — one view drew the class — and that reason had already failed once
// (#144).
//
// It fails for `.gitRef` without any dialog at all. A branch drag clones the
// chip it carries onto `<body>` (`branchDrag.ts`), so for as long as a drag is
// held there are two `.gitRef`s in the page, one of them outside the table. Only
// `pointer-events: none` kept a pointer off the copy; the binding reached it.
//
// So, as in `graphCommitRowReads`, `#dialog` is moved ahead of the graph before
// the webview boots and given stand-ins for every one of the six classes: an
// unscoped binding reaches them, and a scoped one cannot. Each scenario then has
// a half that says the graph's own element still answers, because "nothing
// happens anywhere" is just as true of a binding that was deleted.
//
// One webview is booted for the whole file and the scenarios run in order, the
// way a session actually unfolds; re-importing the module per scenario would
// leave the previous instance still listening on `window` (#80).

const L = getWebviewLocalizedStrings();

const viewState = makeViewState();

const commits: GitCommitNode[] = [
  {
    hash: "*",
    parentHashes: ["aaa111"],
    author: "*",
    email: "",
    date: 1700000100,
    message: "Uncommitted Changes (2)",
    refs: []
  },
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
  token: 0,
  branches: ["main", "feature"],
  head: "main",
  hard: true,
  isRepo: true,
  filter: []
};

/** `hard`, so the reload never takes `loadCommits`'s unchanged short-circuit:
 *  each one is a real redraw, which is the only thing that binds. */
const commitsResponse: GG.ResponseMessage = {
  command: "loadCommits",
  token: 0,
  commits,
  head: "aaa111",
  moreCommitsAvailable: false,
  hard: true
};

let mock: ReturnType<typeof createVscodeMock>;

/** Mirrors `main.ts`'s private `MENU_KEY_EVENT`: the keyboard's way of raising a
 *  context menu, bound alongside the pointer's. */
const MENU_KEY_EVENT = "ging.contextMenuKey";

/** Put `#dialog` ahead of the graph in document order, so that an unscoped
 *  binding meets the stand-ins before it meets the graph — see
 *  `graphCommitRowReads` for why this is not a hypothetical layout. */
function moveDialogAheadOfTheGraph() {
  document.body.insertBefore(
    document.getElementById("dialog")!,
    document.getElementById("content")!
  );
}

/** One element of each of the six classes, standing in `#dialog`, then a redraw
 *  so that `renderTable` binds with them in the page. Rewritten per scenario: an
 *  unscoped binding leaves a handler on these per redraw, and a scenario that
 *  fires one (a checkout shows the action-running dialog) replaces them. The
 *  chip is a local branch that is not HEAD, so a double-click on it is a real
 *  checkout; the header carries a `data-col`, so its menu is the toggleable kind.
 *  No ids: those the graph looks up by id are its own. */
function standInDialog() {
  document.getElementById("dialog")!.innerHTML =
    '<div class="commitList"><table>' +
    '<tr><th class="tableColHeader" data-col="date">Date' +
    '<span class="resizeCol right" data-col="2"></span></th></tr>' +
    '<tr class="unsavedChanges"><td>Stand-in changes</td></tr>' +
    '<tr class="commit" data-hash="ddd444"><td>' +
    '<span class="gitRef head" data-name="feature"><span class="gitRefName">feature</span></span>' +
    "</td></tr></table></div>";
  receive(commitsResponse);
}

/** The stand-in carrying `className` in `#dialog`. */
function inDialog(className: string) {
  const elem = document.querySelector<HTMLElement>(`#dialog .${className}`);
  expect(elem, `#dialog .${className}`).not.toBeNull();
  return elem!;
}

/** The graph's element for `selector`, asked through the table. */
function inGraph(selector: string) {
  const elem = document.querySelector<HTMLElement>(`#commitTable ${selector}`);
  expect(elem, selector).not.toBeNull();
  return elem!;
}

function hideMenu() {
  document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
}

function menuItemLabels() {
  return Array.from(document.querySelectorAll<HTMLElement>("#contextMenu .contextMenuItem")).map(
    (li) => (li.textContent ?? "").trim()
  );
}

/** What raising a menu on `elem` opens, by pointer and then by menu key. */
function menusOn(elem: HTMLElement) {
  hideMenu();
  rightClick(elem);
  const byPointer = menuItemLabels();
  hideMenu();
  elem.dispatchEvent(new Event(MENU_KEY_EVENT, { bubbles: true }));
  const byMenuKey = menuItemLabels();
  hideMenu();
  return { byPointer, byMenuKey };
}

/** A mouse event at `clientX` on one fixed line, with `buttons` held: 1 (the
 *  primary) from the press until the release, 0 from the release on. */
function mouse(type: string, target: Element, clientX: number, buttons: 0 | 1) {
  target.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 100, buttons })
  );
}

function checkouts() {
  return mock.sentMessages.filter((m) => m.command === "checkoutBranch");
}

describe("the graph table's chip, header and resize bindings, with a dialog's copies ahead of them", () => {
  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    moveDialogAheadOfTheGraph();
    await import("@/webview/main");
    receive(branchesResponse);
    receive(commitsResponse);
    standInDialog();
  });

  it("has the dialog's copies first, and leaves them as it found them", () => {
    // Without the order every scenario below could pass on a page where the
    // graph's element was the first candidate anyway.
    const dialog = document.getElementById("dialog")!;
    const table = document.getElementById("commitTable")!;
    expect(dialog.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // `makeTableResizable` gives each header it reads a pair of handles. The
    // dialog's header must still carry only the one it was written with, or the
    // redraw read it as one of the graph's columns.
    expect(dialog.querySelectorAll(".resizeCol")).toHaveLength(1);
  });

  describe("the menus", () => {
    it("open on none of the dialog's elements", () => {
      standInDialog();
      for (const className of ["gitRef", "unsavedChanges", "tableColHeader"]) {
        expect(menusOn(inDialog(className)), className).toEqual({ byPointer: [], byMenuKey: [] });
      }
    });

    it("still open on the graph's own, by pointer and by menu key alike", () => {
      const expected: [string, string][] = [
        ['.gitRef[data-name="feature"]', L.checkRedundancy],
        [".unsavedChanges", L.openScmView],
        ['.tableColHeader[data-col="date"]', L.date]
      ];
      for (const [selector, label] of expected) {
        const menus = menusOn(inGraph(selector));
        expect(menus.byPointer, selector).toContain(label);
        expect(menus.byMenuKey, selector).toEqual(menus.byPointer);
      }
    });
  });

  describe("a click on a ref chip", () => {
    it("reaches the dialog's row behind the dialog's chip", () => {
      // The graph's chip swallows its click so it does not also expand the row
      // it sits on. Bound document-wide it swallowed the dialog's too, and the
      // dialog's row never heard it.
      standInDialog();
      const heard = vi.fn();
      document.querySelector("#dialog tr.commit")!.addEventListener("click", heard);
      clickElem(inDialog("gitRef"));
      expect(heard).toHaveBeenCalledOnce();
    });

    it("still stops at the graph's own chip, leaving its row unexpanded", () => {
      mock.clearMessages();
      clickElem(inGraph('.gitRef[data-name="feature"]'));
      expect(mock.sentMessages.filter((m) => m.command === "commitDetails")).toEqual([]);
      expect(graphRow("bbb222").classList.contains("commitDetailsOpen")).toBe(false);
    });
  });

  describe("a press on a resize handle", () => {
    it("on the dialog's handle resizes nothing and saves nothing", () => {
      standInDialog();
      mock.clearMessages();
      mouse("mousedown", inDialog("resizeCol"), 100, 1);
      const header = document.getElementById("tableColHeaders")!;
      expect(header.classList.contains("resizing")).toBe(false);
      expect(document.getElementById("commitTable")!.className).toBe("autoLayout");
      mouse("mouseup", header, 140, 0);
      expect(mock.sentMessages.filter((m) => m.command === "saveRepoState")).toEqual([]);
    });

    it("on the graph's own handle still starts a resize, and saves it on release", () => {
      mock.clearMessages();
      const header = document.getElementById("tableColHeaders")!;
      mouse("mousedown", inGraph('.resizeCol[data-col="2"]'), 100, 1);
      expect(header.classList.contains("resizing")).toBe(true);
      expect(document.getElementById("commitTable")!.className).toBe("fixedLayout");
      mouse("mouseup", header, 140, 0);
      expect(header.classList.contains("resizing")).toBe(false);
      expect(mock.sentMessages.filter((m) => m.command === "saveRepoState")).toHaveLength(1);
    });
  });

  describe("a double-click on a ref chip", () => {
    it("on the drag ghost a redraw landed behind checks nothing out", () => {
      // The counter-example with no dialog in it: the ghost is a clone of the
      // graph's own chip, on `<body>`, and exists only while the button is held.
      // A redraw in that window — a file watcher's refresh — bound the chip's
      // handlers onto it as well, double-click to checkout among them.
      mouse("mousedown", inGraph('.gitRef[data-name="feature"] .gitRefName'), 100, 1);
      mouse("mousemove", document.body, 160, 1);
      const ghost = document.querySelector<HTMLElement>("body > .branchDragGhost");
      expect(ghost, "the drag's ghost").not.toBeNull();
      expect(ghost!.classList.contains("gitRef")).toBe(true);
      receive(commitsResponse);
      mock.clearMessages();
      ghost!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      expect(checkouts()).toEqual([]);
      mouse("mouseup", document.body, 160, 0);
    });

    it("on the dialog's chip checks nothing out", () => {
      // The most expensive of the six: a ref chip anywhere in a modal would
      // check its branch out on a double-click.
      standInDialog();
      mock.clearMessages();
      inDialog("gitRef").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      expect(checkouts()).toEqual([]);
    });

    it("on the graph's own chip still checks the branch out", () => {
      mock.clearMessages();
      inGraph('.gitRef[data-name="feature"]').dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true })
      );
      expect(checkouts()).toEqual([
        expect.objectContaining({ command: "checkoutBranch", branchName: "feature" })
      ]);
    });
  });
});
