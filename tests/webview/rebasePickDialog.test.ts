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

// The rebase dialog's checklist: the commits the rebase would replay, each
// tickable. The list is the whole of what the user is told will move, so what
// this suite pins is the map from ticks to git command — above all the
// untouched case, which has to be the command the dialog sent before the list
// existed (#172).

const L = getWebviewLocalizedStrings();
const E = "…"; // the rendered form of the ELLIPSIS entity
const REBASE_ON = L.rebaseOnCommit + E;
const REBASE_ONTO = L.rebaseRangeOnCommit + E;

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

// Three lines, in graph order (newest first):
//   topic (HEAD): base ← keep ← w1 ← w2
//   feature:      base ← f1, base ← s1 (`side`), merged at fmerge, then f2
//   main:         base ← target
//   stray:        hangs off a commit outside the loaded window
const commits: GitCommitNode[] = [
  node("stray", ["ancient"], "past the loaded window", [
    { hash: "stray", name: "stray", type: "head" }
  ]),
  node("w2", ["w1"], "wanted 2", [{ hash: "w2", name: "topic", type: "head" }]),
  node("w1", ["keep"], "wanted 1"),
  node("keep", ["base"], "keep"),
  node("f2", ["fmerge"], "feature two", [{ hash: "f2", name: "feature", type: "head" }]),
  node("fmerge", ["f1", "s1"], "Merge branch 'side' into feature"),
  node("s1", ["base"], "side one", [{ hash: "s1", name: "side", type: "head" }]),
  node("f1", ["base"], "feature one"),
  node("target", ["base"], "target", [{ hash: "target", name: "main", type: "head" }]),
  node("base", ["init"], "base"),
  node("init", [], "init")
];

function row(hash: string) {
  const elem = document.querySelector<HTMLElement>(`tr.commit[data-hash="${hash}"]`);
  expect(elem, hash).not.toBeNull();
  return elem!;
}

function openMenu(hash: string) {
  row(hash).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
}

/** The hashes the checklist is showing, top row first. */
function listedHashes() {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>("#dialog .rebasePickRow input")
  ).map((box) => box.dataset.hash);
}

/** Untick one row the way a click on it would. */
function untick(hash: string) {
  const box = document.querySelector<HTMLInputElement>(
    `#dialog .rebasePickRow input[data-hash="${hash}"]`
  );
  expect(box, hash).not.toBeNull();
  box!.checked = false;
  box!.dispatchEvent(new Event("change"));
}

function confirm() {
  document.getElementById("dialogAction")!.dispatchEvent(new MouseEvent("click"));
}

/** The command line the dialog is printing. */
function printedCommand() {
  return document.querySelector("#dialog .commandPreview")!.textContent;
}

function dialogText() {
  return document.getElementById("dialog")!.textContent ?? "";
}

describe("the rebase dialog's replay checklist", () => {
  let mock: ReturnType<typeof createVscodeMock>;

  /** Open the Commit Details View on `hash`, then CTRL-click `compareWith` —
   *  the state the range rebase's menu entry depends on.
   *
   *  Clicking a row that is *already* the anchored one closes the view rather
   *  than opening it, so whichever commit a previous test left anchored would
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

  /** Leave any comparison a previous test set up behind, so the rebase entries
   *  read and behave as the plain rebase again (#173). Expanding one commit's
   *  details is what clears the compared row; the retry is `compare`'s, for
   *  the same reason — a click on the already-anchored row closes the view. */
  function noComparison() {
    const click = () => row("base").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const opened = () =>
      mock.sentMessages.some((m) => m.command === "commitDetails" && m.commitHash === "base");
    click();
    if (!opened()) click();
    expect(opened(), "details never opened on base").toBe(true);
  }

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(makeViewState());
    await import("@/webview/main");
    receive({
      command: "loadBranches",
      token: 0,
      branches: ["main", "topic", "feature", "side", "stray"],
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
  });

  beforeEach(() => {
    mock.clearMessages();
  });

  describe("rebasing the current branch onto a commit", () => {
    it("lists the range in the graph's own order", () => {
      openMenu("target");
      clickItem(REBASE_ON);

      // `target..w2`: the lower bound is excluded, and the rows read newest
      // first like the graph behind the dialog.
      expect(listedHashes()).toEqual(["w2", "w1", "keep"]);
    });

    it("sends the command it always sent when no commit was unticked", () => {
      openMenu("target");
      clickItem(REBASE_ON);
      confirm();

      // Field for field what this action sent before the list existed: an
      // untouched dialog may not change what runs.
      expect(mock.sentMessages).toContainEqual({
        command: "rebaseOn",
        repo: DEFAULT_REPO,
        obj: "target"
      });
    });

    it("moves the lower bound forward when only the oldest commits are dropped", () => {
      openMenu("target");
      clickItem(REBASE_ON);
      untick("keep");
      confirm();

      // Still a plain rebase — the range just starts later. `tip` is the branch
      // name so that git moves the branch rather than detaching HEAD.
      expect(mock.sentMessages).toContainEqual({
        command: "rebaseOnto",
        repo: DEFAULT_REPO,
        newBase: "target",
        upstream: "keep",
        tip: "topic"
      });
      expect(mock.sentMessages.some((m) => m.command === "rebaseOn")).toBe(false);
    });

    it("writes a todo when the gap is in the middle", () => {
      openMenu("target");
      clickItem(REBASE_ON);
      untick("w1");
      confirm();

      expect(mock.sentMessages).toContainEqual({
        command: "rebaseInteractive",
        repo: DEFAULT_REPO,
        newBase: "target",
        upstream: "target",
        tip: "topic",
        // Oldest first, and the dropped commit is spelled out rather than
        // omitted, so git's own missing-commits check has nothing to say.
        todo: "pick keep keep\ndrop w1 wanted 1\npick w2 wanted 2\n"
      });
    });

    it("runs no git command when every commit is unticked", () => {
      openMenu("target");
      clickItem(REBASE_ON);
      untick("keep");
      untick("w1");
      untick("w2");
      confirm();

      expect(
        mock.sentMessages.filter((m) => m.command.startsWith("rebase")),
        "a rebase was sent for an empty list"
      ).toEqual([]);
      expect(dialogText()).toContain(L.dialogRebasePickNothingChecked);
    });
  });

  describe("rebasing a selected range onto a commit", () => {
    it("replays both commits the user compared, not just the newer one", () => {
      // The gesture picks two commits and the label calls them a compared
      // range, so both ends move. git excludes `<upstream>`, which is why the
      // bound sent is the older selection's parent and never the selection.
      compare("keep", "w2");
      openMenu("target");
      clickItem(REBASE_ONTO);

      expect(listedHashes()).toContain("keep");
      expect(listedHashes()).toContain("w2");
      expect(printedCommand()).toBe("git rebase --onto target base topic");

      confirm(); // leave no dialog open for the next test
    });

    it("sends the command it always sent when no commit was unticked", () => {
      compare("keep", "w2");
      openMenu("target");
      clickItem(REBASE_ONTO);

      // Both commits the user compared are replayed, so the bound git is given
      // is `keep`'s parent rather than `keep` — naming `keep` would drop it.
      expect(listedHashes()).toEqual(["w2", "w1", "keep"]);
      confirm();
      expect(mock.sentMessages).toContainEqual({
        command: "rebaseOnto",
        repo: DEFAULT_REPO,
        newBase: "target",
        upstream: "base",
        tip: "topic"
      });
    });

    it("moves the lower bound forward when only the oldest commits are dropped", () => {
      compare("keep", "w2");
      openMenu("target");
      clickItem(REBASE_ONTO);
      untick("keep");
      confirm();

      expect(mock.sentMessages).toContainEqual({
        command: "rebaseOnto",
        repo: DEFAULT_REPO,
        newBase: "target",
        upstream: "keep",
        tip: "topic"
      });
    });

    it("keeps the printed command honest about the form it will run", () => {
      compare("base", "w2");
      openMenu("target");
      clickItem(REBASE_ONTO);

      expect(printedCommand()).toBe("git rebase --onto target init topic");

      // Dropping the newest commit cannot be spelled as a range at all, so the
      // command changes — and the dialog prints the one that will run
      // (ADR-0022), not the one it opened with.
      untick("w2");
      expect(printedCommand()).toBe("git rebase --interactive --onto target init topic");

      confirm();
      expect(mock.sentMessages).toContainEqual({
        command: "rebaseInteractive",
        repo: DEFAULT_REPO,
        newBase: "target",
        upstream: "init",
        tip: "topic",
        todo: "pick base base\npick keep keep\npick w1 wanted 1\ndrop w2 wanted 2\n"
      });
    });
  });

  describe("rebasing the current branch onto a branch", () => {
    it("lists the same range the commit entry would", () => {
      noComparison();
      const chip = document.querySelector<HTMLElement>('.gitRef[data-name="main"]');
      expect(chip, "the main ref chip").not.toBeNull();
      chip!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      clickItem(L.rebaseOnBranch + E);

      // The branch is resolved to the commit it sits on, so both entry points
      // reach one list rather than two spellings of the range.
      expect(listedHashes()).toEqual(["w2", "w1", "keep"]);

      confirm();
      expect(mock.sentMessages).toContainEqual({
        command: "rebaseOn",
        repo: DEFAULT_REPO,
        obj: "main"
      });
    });
  });

  describe("a range that runs past the loaded commits", () => {
    it("cannot be edited, and runs the command it would have run anyway", () => {
      compare("base", "stray");
      openMenu("target");
      clickItem(REBASE_ONTO);

      // `stray`'s parent was never loaded, so how much further the range goes is
      // unknown. An editable list here would drop commits the user was never
      // shown, which is the one direction that is dangerous.
      const boxes = Array.from(
        document.querySelectorAll<HTMLInputElement>("#dialog .rebasePickRow input")
      );
      expect(boxes.length).toBeGreaterThan(0);
      expect(boxes.every((box) => box.disabled)).toBe(true);

      confirm();
      expect(mock.sentMessages).toContainEqual({
        command: "rebaseOnto",
        repo: DEFAULT_REPO,
        newBase: "target",
        upstream: "init",
        tip: "stray"
      });
    });
  });

  describe("a range that crosses a merge", () => {
    it("leaves the merge off the list", () => {
      compare("base", "f2");
      openMenu("target");
      clickItem(REBASE_ONTO);

      // `fmerge` is absent: a rebase without `--rebase-merges` never replays a
      // merge commit, so listing it would promise a move git will not make.
      // The list is the whole of what the dialog claims — the flattening and
      // the branches it strands are no longer stated in words.
      expect(listedHashes()).toEqual(["f2", "s1", "f1", "base"]);
    });

    it("still sends the untouched command", () => {
      compare("base", "f2");
      openMenu("target");
      clickItem(REBASE_ONTO);
      confirm();

      expect(mock.sentMessages).toContainEqual({
        command: "rebaseOnto",
        repo: DEFAULT_REPO,
        newBase: "target",
        upstream: "init",
        tip: "feature"
      });
    });

    it("never narrows a list the flattened merge left in two strands", () => {
      compare("base", "f2");
      openMenu("target");
      clickItem(REBASE_ONTO);

      // Unticking the oldest two looks like a narrowing — the kept commits run
      // to the newest with no gap — but `f1` and `s1` are on different sides of
      // the merge that was flattened away. Naming `s1` as the new lower bound
      // would exclude only `s1` and its ancestors, and `f1` is not among them,
      // so git would replay a commit that had just been unticked. Only the
      // interactive form spells every drop out.
      untick("f1");
      untick("s1");
      expect(printedCommand()).toBe("git rebase --interactive --onto target init feature");

      confirm();
      expect(mock.sentMessages).toContainEqual({
        command: "rebaseInteractive",
        repo: DEFAULT_REPO,
        newBase: "target",
        upstream: "init",
        tip: "feature",
        todo: "pick base base\ndrop f1 feature one\ndrop s1 side one\npick f2 feature two\n"
      });
      expect(mock.sentMessages.some((m) => m.command === "rebaseOnto")).toBe(false);
    });
  });

  describe("what the dialog says about itself", () => {
    it("introduces the list with nothing but the command", () => {
      noComparison();
      openMenu("target");
      clickItem(REBASE_ON);

      // The rows say which commits move and the command says what will run, so
      // there is no sentence between them — one that counted the ticks would
      // only restate the list, and would have to be kept from contradicting it.
      expect(document.querySelector("#dialog .rebasePickIntro")).toBeNull();
      expect(document.querySelector("#dialog #rebasePickCommand")).not.toBeNull();
      expect(document.querySelectorAll("#dialog .rebasePickRow").length).toBe(3);

      untick("w1");
      expect(document.querySelector("#dialog .rebasePickIntro")).toBeNull();
    });

    it("lists nothing when the range cannot be read, and still runs", () => {
      // The side view can act on a branch the graph is not showing, and then
      // there is no range to read at all. Reporting "nothing to replay" would
      // be a different claim, and a false one.
      receive({
        command: "runRefAction",
        repo: DEFAULT_REPO,
        ref: "off-screen",
        action: "rebase",
        seq: 172
      });

      expect(document.querySelectorAll("#dialog .rebasePickRow")).toHaveLength(0);

      // And it still runs the command it always ran.
      confirm();
      expect(mock.sentMessages).toContainEqual({
        command: "rebaseOn",
        repo: DEFAULT_REPO,
        obj: "off-screen"
      });
    });
  });

  // Last, because it moves HEAD out from under the fixture the tests above
  // share.
  //
  // The list is a reading of `target..HEAD` taken when the dialog opened, and
  // once a tick has changed the command that reading is written into it. HEAD
  // moving while the question was on screen therefore makes the printed range a
  // different one from the range that would run — the case ADR-0019 rules out —
  // so the guard is re-taken at consent and refuses out loud.
  it("refuses a narrowed rebase when HEAD moved while the dialog was open", () => {
    noComparison();
    openMenu("target");
    clickItem(REBASE_ON);
    untick("keep");

    // `git reset --hard w1` on topic, reaching the webview through the file
    // watcher: the range the list was built from is no longer the range.
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
    confirm();

    expect(mock.sentMessages.filter((m) => m.command.startsWith("rebase"))).toEqual([]);
    expect(dialogText()).toContain(L.dialogHeadMoved.replace("{0}", "topic"));
  });
});
