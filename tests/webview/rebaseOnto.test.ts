import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";

import {
  clickItem,
  compareRows,
  createVscodeMock,
  DEFAULT_REPO,
  graphRow,
  makeViewState,
  menuItemLabels,
  receive,
  setupHtml
} from "./setup";

// `rebase --onto` from the graph, end to end. There is no separate menu entry
// for it (#173): while two commits are CTRL-compared, the rebase entry the
// commit and ref menus already carry changes label and replays the compared
// range instead of the current branch. The range it sends is resolved from
// ancestry rather than from the order the two were clicked.

const L = getWebviewLocalizedStrings();
const E = "…"; // the rendered form of the ELLIPSIS entity
const REBASE_ON = L.rebaseOnCommit + E;
const REBASE_ONTO = L.rebaseRangeOnCommit + E;
const REBASE_ON_BRANCH = L.rebaseOnBranch + E;
const REBASE_ONTO_BRANCH = L.rebaseRangeOnBranch + E;
const OTHER_REPO = "/workspace/other";

function node(
  hash: string,
  parentHashes: string[],
  message: string,
  refs: GitCommitNode["refs"] = []
): GitCommitNode {
  return {
    hash,
    parentHashes,
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message,
    refs
  };
}

// topic: base ← keep ← w1 ← w2, main: base ← target, and `dup` hanging off keep
// with two branches on it. Graph order is newest first — the array order below.
// `fix&bug` shares `target` with `main`: a legal branch name whose HTML and raw
// spellings differ, which is what tells single escaping from double.
const commits: GitCommitNode[] = [
  node("w2", ["w1"], "wanted 2", [{ hash: "w2", name: "topic", type: "head" }]),
  node("w1", ["keep"], "wanted 1"),
  node("dup", ["keep"], "two branches here", [
    { hash: "dup", name: "dup-a", type: "head" },
    { hash: "dup", name: "dup-b", type: "head" }
  ]),
  node("target", ["base"], "target", [
    { hash: "target", name: "main", type: "head" },
    { hash: "target", name: "fix&bug", type: "head" }
  ]),
  node("keep", ["base"], "keep"),
  node("base", [], "base")
];

function menuEntries(hash: string) {
  graphRow(hash).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  return menuItemLabels();
}

/** The same, for the ref chip carrying `name`. The chip writes the name
 *  HTML-escaped and the parser decodes it straight back, so `data-name` holds
 *  the branch's own spelling — matched by reading the property rather than
 *  through an attribute selector, which cannot carry every legal branch name. */
function refMenuEntries(name: string) {
  const chip = Array.from(document.querySelectorAll<HTMLElement>(".gitRef")).find(
    (elem) => elem.dataset.name === name
  );
  expect(chip, name).toBeDefined();
  chip!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  return menuItemLabels();
}

/** How many of the open menu's entries are a rebase — one, always: the range
 *  rebase replaces the plain one rather than joining it (#173). */
function rebaseEntryCount(entries: string[]) {
  return entries.filter((title) =>
    [REBASE_ON, REBASE_ONTO, REBASE_ON_BRANCH, REBASE_ONTO_BRANCH].includes(title)
  ).length;
}

describe("rebase --onto from the commit context menu", () => {
  let mock: ReturnType<typeof createVscodeMock>;

  function loadView() {
    receive({
      command: "loadBranches",
      token: 0,
      branches: ["main", "topic", "dup-a", "dup-b", "fix&bug"],
      head: "topic",
      hard: true,
      isRepo: true,
      filter: []
    });
    receive({
      command: "loadCommits",
      token: 0,
      commits,
      head: "w2",
      moreCommitsAvailable: false,
      hard: true
    });
  }

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    // A second repo, so the host can move the view under an open dialog.
    setupHtml(
      makeViewState({
        repos: { [DEFAULT_REPO]: { columnWidths: null }, [OTHER_REPO]: { columnWidths: null } }
      })
    );
    await import("@/webview/main");
    loadView();
  });

  beforeEach(() => {
    mock.clearMessages();
  });

  it("leaves both menus reading as the plain rebase while a single commit is expanded", () => {
    graphRow("keep").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const commitMenu = menuEntries("target");
    expect(commitMenu).toContain(REBASE_ON);
    expect(commitMenu).not.toContain(REBASE_ONTO);
    expect(rebaseEntryCount(commitMenu)).toBe(1);

    const refMenu = refMenuEntries("main");
    expect(refMenu).toContain(REBASE_ON_BRANCH);
    expect(refMenu).not.toContain(REBASE_ONTO_BRANCH);
    expect(rebaseEntryCount(refMenu)).toBe(1);
  });

  it("runs the plain rebase from a menu that reads as the plain rebase", () => {
    graphRow("keep").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    menuEntries("target");
    clickItem(REBASE_ON);
    document.getElementById("dialogAction")!.dispatchEvent(new MouseEvent("click"));

    expect(mock.sentMessages).toContainEqual({
      command: "rebaseOn",
      repo: DEFAULT_REPO,
      obj: "target"
    });
  });

  it("replaces the plain entry rather than adding a second one", () => {
    compareRows("keep", "w2");
    const commitMenu = menuEntries("target");
    expect(commitMenu).toContain(REBASE_ONTO);
    expect(commitMenu).not.toContain(REBASE_ON);
    expect(rebaseEntryCount(commitMenu)).toBe(1);

    const refMenu = refMenuEntries("main");
    expect(refMenu).toContain(REBASE_ONTO_BRANCH);
    expect(refMenu).not.toContain(REBASE_ON_BRANCH);
    expect(rebaseEntryCount(refMenu)).toBe(1);
  });

  it("stays the plain rebase on the two commits that form the range", () => {
    // `--onto` aimed at an end of its own range is a no-op or a self-copy
    // (ADR-0022), so these two keep the entry they always had rather than
    // losing it.
    compareRows("keep", "w2");
    expect(menuEntries("keep")).toContain(REBASE_ON);
    compareRows("keep", "w2");
    expect(menuEntries("w2")).toContain(REBASE_ON);
    // Same rule read off a branch: `dup-a` sits on an end of the range.
    compareRows("keep", "dup");
    expect(refMenuEntries("dup-a")).toContain(REBASE_ON_BRANCH);
  });

  // The printed command is the whole of what is agreed to (ADR-0022), so it has
  // to be the string git will actually receive. A branch name is raw text all
  // the way to `rebasePickCommandHtml`, which escapes the line it built once;
  // handing that line a name already escaped for HTML printed `fix&amp;bug` for
  // a branch called `fix&bug` — a command that would not run.
  it("prints a branch name that needs escaping exactly once, plain rebase", () => {
    graphRow("keep").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    refMenuEntries("fix&bug");
    clickItem(REBASE_ON_BRANCH);

    expect(document.querySelector("#dialog .commandPreview")!.textContent).toBe(
      "git rebase fix&bug"
    );
    // The confirmation names it once too, and as text rather than as markup.
    expect(document.getElementById("dialog")!.textContent).toContain("fix&bug");
    expect(document.getElementById("dialog")!.innerHTML).not.toContain("&amp;amp;");
  });

  it("prints a branch name that needs escaping exactly once, range rebase", () => {
    compareRows("keep", "w2");
    refMenuEntries("fix&bug");
    clickItem(REBASE_ONTO_BRANCH);

    expect(document.querySelector("#dialog .commandPreview")!.textContent).toBe(
      "git rebase --onto fix&bug base topic"
    );
    expect(document.getElementById("dialog")!.innerHTML).not.toContain("&amp;amp;");
  });

  it("replays the range onto a branch, naming the branch in both command and message", () => {
    compareRows("keep", "w2");
    refMenuEntries("main");
    clickItem(REBASE_ONTO_BRANCH);

    // The new base is the branch the user clicked, not the hash under it: git
    // resolves the name, and the printed line is what will run (ADR-0022).
    expect(document.querySelector("#dialog .commandPreview")!.textContent).toBe(
      "git rebase --onto main base topic"
    );

    document.getElementById("dialogAction")!.dispatchEvent(new MouseEvent("click"));
    expect(mock.sentMessages).toContainEqual({
      command: "rebaseOnto",
      repo: DEFAULT_REPO,
      newBase: "main",
      upstream: "base",
      tip: "topic"
    });
  });

  it("sends the ancestor as upstream regardless of which commit was clicked first", () => {
    // CTRL-clicked newest-first: the anchored row is the descendant.
    compareRows("w2", "keep");
    menuEntries("target");
    clickItem(REBASE_ONTO);
    document.getElementById("dialogAction")!.dispatchEvent(new MouseEvent("click"));

    expect(mock.sentMessages).toContainEqual({
      command: "rebaseOnto",
      repo: DEFAULT_REPO,
      newBase: "target",
      upstream: "base",
      tip: "topic" // the local branch on the tip commit, so the branch moves
    });
  });

  it("shows the exact command and falls back to the tip's hash when no branch is on it", () => {
    compareRows("keep", "w1"); // nothing points at w1
    menuEntries("target");
    clickItem(REBASE_ONTO);

    const dialog = document.getElementById("dialog")!;
    expect(dialog.querySelector(".commandPreview")!.textContent).toBe(
      "git rebase --onto target base w1"
    );
    // The detached-HEAD consequence is spelled out rather than left to be found.
    expect(dialog.querySelector(".dialogNote")!.textContent).toContain("detached");

    document.getElementById("dialogAction")!.dispatchEvent(new MouseEvent("click"));
    expect(mock.sentMessages).toContainEqual({
      command: "rebaseOnto",
      repo: DEFAULT_REPO,
      newBase: "target",
      upstream: "base",
      tip: "w1"
    });
  });

  it("shows the command while the branch is still being picked", () => {
    // Two local branches sit on the tip, so which one git moves is still open.
    compareRows("keep", "dup");
    menuEntries("target");
    clickItem(REBASE_ONTO);

    // git's own placeholder stands in for the branch the select below supplies.
    expect(document.querySelector("#dialog .commandPreview")!.textContent).toBe(
      "git rebase --onto target base <branch>"
    );
    const options = Array.from(
      document.querySelectorAll<HTMLOptionElement>("#dialog select option")
    ).map((o) => o.value);
    expect(options).toEqual(["dup-a", "dup-b", ""]); // "" = leave HEAD detached
  });

  // Last, because it moves a branch out from under the fixture the tests above
  // share.
  //
  // The dialog prints the literal `git rebase --onto …` it is about to run, and
  // the branch name in that line is a snapshot of the tip's refs taken when the
  // dialog opened. git resolves the name when the command runs, not when it was
  // printed, so a branch that moved while the user was reading would replay a
  // different range than the one they agreed to. ADR-0019: when the change is
  // deferred into a callback the guard is deferred with it and the reading is
  // re-taken there — and here the only honest answer is to refuse, since the
  // printed command is the whole of what was consented to.
  it("refuses when the branch it printed no longer points at the tip", () => {
    compareRows("keep", "w2"); // tip is w2, and `topic` is on it
    menuEntries("target");
    clickItem(REBASE_ONTO);
    expect(document.querySelector("#dialog .commandPreview")!.textContent).toBe(
      "git rebase --onto target base topic"
    );

    // `git reset --hard w1` on topic, reaching the webview through the file
    // watcher: the name in the printed command now covers one commit fewer.
    receive({
      command: "loadCommits",
      token: 0,
      commits: commits.map((c) =>
        c.hash === "w2"
          ? node("w2", ["w1"], "wanted 2")
          : c.hash === "w1"
            ? node("w1", ["keep"], "wanted 1", [{ hash: "w1", name: "topic", type: "head" }])
            : c
      ),
      head: "w1",
      moreCommitsAvailable: false,
      hard: true
    });
    expect(document.getElementById("dialogAction"), "the dialog was dismissed").not.toBeNull();

    mock.clearMessages();
    document.getElementById("dialogAction")!.dispatchEvent(new MouseEvent("click"));

    expect(mock.sentMessages.filter((m) => m.command === "rebaseOnto")).toEqual([]);
    expect(document.getElementById("dialog")!.textContent).toContain(
      L.dialogRebaseOntoTipMoved.replace("{0}", "topic")
    );
  });

  // The same premise when several branches share the tip and the select picks
  // one: the name the user picks goes into the command verbatim, and git
  // resolves it when the command runs. A pick read off the tip's refs when the
  // dialog opened is a snapshot like the printed one above.
  describe("when the branch is picked from several on the tip", () => {
    /** Two branches on `dup`, the tip of the compared range, with `dup-a` moved
     *  off it or left where it was. */
    function loadDup(dupAMoved: boolean) {
      receive({
        command: "loadCommits",
        token: 0,
        commits: commits.map((c) =>
          c.hash === "dup" && dupAMoved
            ? node("dup", ["keep"], "two branches here", [
                { hash: "dup", name: "dup-b", type: "head" }
              ])
            : c.hash === "keep" && dupAMoved
              ? node("keep", ["base"], "keep", [{ hash: "keep", name: "dup-a", type: "head" }])
              : c
        ),
        head: "w2",
        moreCommitsAvailable: false,
        hard: true
      });
    }

    function pick(branch: string) {
      const select = document.querySelector<HTMLSelectElement>("#dialog select");
      expect(select, "the branch select").not.toBeNull();
      select!.value = branch;
    }

    beforeEach(() => {
      loadDup(false);
      compareRows("keep", "dup");
      menuEntries("target");
      clickItem(REBASE_ONTO);
    });

    it("sends the branch picked when it still points at the tip", () => {
      pick("dup-b");
      mock.clearMessages();
      document.getElementById("dialogAction")!.dispatchEvent(new MouseEvent("click"));

      expect(mock.sentMessages.filter((m) => m.command === "rebaseOnto")).toEqual([
        {
          command: "rebaseOnto",
          repo: DEFAULT_REPO,
          newBase: "target",
          upstream: "base",
          tip: "dup-b"
        }
      ]);
    });

    it("refuses when the branch picked no longer points at the tip", () => {
      loadDup(true);
      expect(document.getElementById("dialogAction"), "the dialog was dismissed").not.toBeNull();

      pick("dup-a");
      mock.clearMessages();
      document.getElementById("dialogAction")!.dispatchEvent(new MouseEvent("click"));

      expect(mock.sentMessages.filter((m) => m.command === "rebaseOnto")).toEqual([]);
      expect(document.getElementById("dialog")!.textContent).toContain(
        L.dialogRebaseOntoTipMoved.replace("{0}", "dup-a")
      );
    });
  });

  // Last, because each scenario leaves the view on the other repo.
  //
  // `branchPointsAt` reads the loaded commits, and once the host has moved the
  // view those are another repository's. Here the other repo has the same
  // shape, so the branch "still" points at the tip — by coincidence, having
  // verified nothing about the repo the command would be sent to.
  describe("once the repo moved under the dialog", () => {
    let other = OTHER_REPO;

    /** The host moving the view to the other repo, whose branches and commits
     *  happen to match this one's. */
    function hostMovesToLookalikeRepo() {
      receive({ command: "setRepo", repo: other });
      other = other === OTHER_REPO ? DEFAULT_REPO : OTHER_REPO;
      loadView();
      expect(document.getElementById("dialogAction"), "the dialog was dismissed").not.toBeNull();
    }

    function submitAndExpectRefusal(branch: string) {
      mock.clearMessages();
      document.getElementById("dialogAction")!.dispatchEvent(new MouseEvent("click"));

      expect(mock.sentMessages.filter((m) => m.command === "rebaseOnto")).toEqual([]);
      expect(document.getElementById("dialog")!.textContent).toContain(
        L.dialogRebaseOntoTipMoved.replace("{0}", branch)
      );
    }

    it("refuses the branch the command printed", () => {
      compareRows("keep", "w2"); // tip is w2, and `topic` is on it
      menuEntries("target");
      clickItem(REBASE_ONTO);
      expect(document.querySelector("#dialog .commandPreview")!.textContent).toBe(
        "git rebase --onto target base topic"
      );

      hostMovesToLookalikeRepo();
      submitAndExpectRefusal("topic");
    });

    it("refuses the branch picked from several on the tip", () => {
      compareRows("keep", "dup");
      menuEntries("target");
      clickItem(REBASE_ONTO);
      expect(document.querySelector("#dialog select"), "the branch select").not.toBeNull();

      hostMovesToLookalikeRepo();
      document.querySelector<HTMLSelectElement>("#dialog select")!.value = "dup-a";
      submitAndExpectRefusal("dup-a");
    });
  });
});
