import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";

import {
  clickItem,
  createVscodeMock,
  DEFAULT_REPO,
  makeViewState,
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
const commits: GitCommitNode[] = [
  node("w2", ["w1"], "wanted 2", [{ hash: "w2", name: "topic", type: "head" }]),
  node("w1", ["keep"], "wanted 1"),
  node("dup", ["keep"], "two branches here", [
    { hash: "dup", name: "dup-a", type: "head" },
    { hash: "dup", name: "dup-b", type: "head" }
  ]),
  node("target", ["base"], "target", [{ hash: "target", name: "main", type: "head" }]),
  node("keep", ["base"], "keep"),
  node("base", [], "base")
];

function row(hash: string) {
  const elem = document.querySelector<HTMLElement>(`tr.commit[data-hash="${hash}"]`);
  expect(elem, hash).not.toBeNull();
  return elem!;
}

function menuEntries(hash: string) {
  row(hash).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  return openMenuEntries();
}

/** The same, for the ref chip carrying `name`. */
function refMenuEntries(name: string) {
  const chip = document.querySelector<HTMLElement>(`.gitRef[data-name="${name}"]`);
  expect(chip, name).not.toBeNull();
  chip!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  return openMenuEntries();
}

function openMenuEntries() {
  return Array.from(document.querySelectorAll<HTMLElement>("#contextMenu .contextMenuItem")).map(
    (li) => (li.textContent ?? "").trim()
  );
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

  /** Open the Commit Details View on `hash`, then CTRL-click `compareWith` to
   *  compare the two — the state the rebase-onto entry depends on.
   *
   *  Clicking a row that is *already* the anchored one closes the view rather
   *  than opening it, so whichever commit the previous test left anchored would
   *  otherwise decide whether this one sees a comparison. The request the open
   *  path sends is what tells the two apart. */
  function compare(hash: string, compareWith: string) {
    const click = (h: string, ctrlKey = false) =>
      row(h).dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey }));
    const opened = () =>
      mock.sentMessages.some((m) => m.command === "commitDetails" && m.commitHash === hash);
    click(hash);
    if (!opened()) click(hash);
    expect(opened(), `details never opened on ${hash}`).toBe(true);
    click(compareWith, true);
  }

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(makeViewState());
    await import("@/webview/main");
    receive({
      command: "loadBranches",
      branches: ["main", "topic", "dup-a", "dup-b"],
      head: "topic",
      hard: true,
      isRepo: true,
      filter: []
    });
    receive({
      command: "loadCommits",
      commits,
      head: "w2",
      moreCommitsAvailable: false,
      hard: true
    });
  });

  beforeEach(() => {
    mock.clearMessages();
  });

  it("leaves both menus reading as the plain rebase while a single commit is expanded", () => {
    row("keep").dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
    row("keep").dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
    compare("keep", "w2");
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
    compare("keep", "w2");
    expect(menuEntries("keep")).toContain(REBASE_ON);
    compare("keep", "w2");
    expect(menuEntries("w2")).toContain(REBASE_ON);
    // Same rule read off a branch: `dup-a` sits on an end of the range.
    compare("keep", "dup");
    expect(refMenuEntries("dup-a")).toContain(REBASE_ON_BRANCH);
  });

  it("replays the range onto a branch, naming the branch in both command and message", () => {
    compare("keep", "w2");
    refMenuEntries("main");
    clickItem(REBASE_ONTO_BRANCH);

    // The new base is the branch the user clicked, not the hash under it: git
    // resolves the name, and the printed line is what will run (ADR-0022).
    expect(document.querySelector("#dialog .commandPreview")!.textContent).toBe(
      "git rebase --onto main keep topic"
    );

    document.getElementById("dialogAction")!.dispatchEvent(new MouseEvent("click"));
    expect(mock.sentMessages).toContainEqual({
      command: "rebaseOnto",
      repo: DEFAULT_REPO,
      newBase: "main",
      upstream: "keep",
      tip: "topic"
    });
  });

  it("sends the ancestor as upstream regardless of which commit was clicked first", () => {
    // CTRL-clicked newest-first: the anchored row is the descendant.
    compare("w2", "keep");
    menuEntries("target");
    clickItem(REBASE_ONTO);
    document.getElementById("dialogAction")!.dispatchEvent(new MouseEvent("click"));

    expect(mock.sentMessages).toContainEqual({
      command: "rebaseOnto",
      repo: DEFAULT_REPO,
      newBase: "target",
      upstream: "keep",
      tip: "topic" // the local branch on the tip commit, so the branch moves
    });
  });

  it("shows the exact command and falls back to the tip's hash when no branch is on it", () => {
    compare("keep", "w1"); // nothing points at w1
    menuEntries("target");
    clickItem(REBASE_ONTO);

    const dialog = document.getElementById("dialog")!;
    expect(dialog.querySelector(".commandPreview")!.textContent).toBe(
      "git rebase --onto target keep w1"
    );
    // The detached-HEAD consequence is spelled out rather than left to be found.
    expect(dialog.querySelector(".dialogNote")!.textContent).toContain("detached");

    document.getElementById("dialogAction")!.dispatchEvent(new MouseEvent("click"));
    expect(mock.sentMessages).toContainEqual({
      command: "rebaseOnto",
      repo: DEFAULT_REPO,
      newBase: "target",
      upstream: "keep",
      tip: "w1"
    });
  });

  it("shows the command while the branch is still being picked", () => {
    // Two local branches sit on the tip, so which one git moves is still open.
    compare("keep", "dup");
    menuEntries("target");
    clickItem(REBASE_ONTO);

    // git's own placeholder stands in for the branch the select below supplies.
    expect(document.querySelector("#dialog .commandPreview")!.textContent).toBe(
      "git rebase --onto target keep <branch>"
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
    compare("keep", "w2"); // tip is w2, and `topic` is on it
    menuEntries("target");
    clickItem(REBASE_ONTO);
    expect(document.querySelector("#dialog .commandPreview")!.textContent).toBe(
      "git rebase --onto target keep topic"
    );

    // `git reset --hard w1` on topic, reaching the webview through the file
    // watcher: the name in the printed command now covers one commit fewer.
    receive({
      command: "loadCommits",
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
});
