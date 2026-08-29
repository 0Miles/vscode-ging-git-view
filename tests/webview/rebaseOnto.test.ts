import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";

import { createVscodeMock, DEFAULT_REPO, makeViewState, receive, setupHtml } from "./setup";

// `rebase --onto` from the graph, end to end: the entry only exists while two
// commits are CTRL-compared, and the range it sends is resolved from ancestry
// rather than from the order the two were clicked.

const L = getWebviewLocalizedStrings();
const E = "…"; // the rendered form of the ELLIPSIS entity
const REBASE_ONTO = L.rebaseOntoCommit + E;

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
  return Array.from(document.querySelectorAll<HTMLElement>("#contextMenu .contextMenuItem")).map(
    (li) => (li.textContent ?? "").trim()
  );
}

function clickItem(label: string) {
  const item = Array.from(
    document.querySelectorAll<HTMLElement>("#contextMenu .contextMenuItem")
  ).find((li) => (li.textContent ?? "").trim() === label);
  expect(item, label).not.toBeNull();
  item!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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

  it("is absent while a single commit is expanded", () => {
    row("keep").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(menuEntries("target")).not.toContain(REBASE_ONTO);
  });

  it("is absent on the two commits that form the range", () => {
    compare("keep", "w2");
    expect(menuEntries("keep")).not.toContain(REBASE_ONTO);
    compare("keep", "w2");
    expect(menuEntries("w2")).not.toContain(REBASE_ONTO);
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
