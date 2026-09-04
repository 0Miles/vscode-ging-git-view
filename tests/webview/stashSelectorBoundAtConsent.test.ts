import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

import { createVscodeMock, DEFAULT_REPO, makeViewState, receive, setupHtml } from "./setup";

// `stash@{n}` is a *position*, not a name: it means "the nth entry on the stash
// stack right now". Every `git stash push` — from the terminal, from VS Code's
// own Source Control view, from a `git pull --autostash` — pushes onto the top
// and renumbers everything below it. So the number the user agreed to drop
// stops pointing at the stash the dialog named the moment a new one lands.
//
// This was survivable only for as long as a background reload closed the dialog
// on its way past. Now that a reload leaves questions standing (that is the
// point of leaving them standing), the window between "asked" and "answered" is
// as long as the user takes to read — and the reload that renumbers the stack
// is the same reload that redraws the row underneath the menu.
//
// So the selector is bound at consent the way the repo already is, and what it
// pointed at then is re-checked on the far side. `renameStash` was already
// looking a stash's commit up this way; this is that same lookup, used as the
// premise it always was. Dropping the wrong stash leaves no ref behind: it is
// recoverable only by going hunting for a dangling commit.

const L = getWebviewLocalizedStrings();
const E = "…"; // the rendered form of the ELLIPSIS entity

const viewState = makeViewState();

const tip: GitCommitNode = {
  hash: "aaa111",
  parentHashes: [],
  author: "Alice",
  email: "alice@example.com",
  date: 1700000000,
  message: "Tip commit",
  refs: [{ hash: "aaa111", name: "main", type: "head" }]
};

function stash(hash: string, selector: string, message: string): GitCommitNode {
  return {
    hash,
    parentHashes: ["aaa111"],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000050,
    message,
    refs: [{ hash, name: selector, type: "stash" }]
  };
}

/** The stack as the user finds it: one stash, `stash@{0}`. */
const before: GitCommitNode[] = [stash("sA", "stash@{0}", "half-done refactor"), tip];

/** The stack after someone else stashed: the new one takes `stash@{0}`, and the
 *  one the dialog is asking about slides down to `stash@{1}`. */
const after: GitCommitNode[] = [
  stash("sNEW", "stash@{0}", "someone else's work"),
  stash("sA", "stash@{1}", "half-done refactor"),
  tip
];

const branchesResponse: GG.ResponseMessage = {
  command: "loadBranches",
  token: 0,
  branches: ["main"],
  head: "main",
  hard: true,
  isRepo: true,
  filter: []
};

function commitsResponse(commits: GitCommitNode[]): GG.ResponseMessage {
  return {
    command: "loadCommits",
    token: 0,
    commits,
    head: "aaa111",
    moreCommitsAvailable: false,
    hard: true
  };
}

let mock: ReturnType<typeof createVscodeMock>;

const sentOf = (command: string) => mock.sentMessages.filter((m) => m.command === command);

function openMenuOn(selector: string) {
  const elem = document.querySelector<HTMLElement>(selector);
  expect(elem, selector).not.toBeNull();
  elem!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
}

/** `toBeDefined`, not `not.toBeNull`: `find` yields `undefined`, which a null
 *  check waves straight through (issue #131). */
function clickItem(label: string) {
  const item = Array.from(
    document.querySelectorAll<HTMLElement>("#contextMenu .contextMenuItem")
  ).find((li) => (li.textContent ?? "").trim() === label);
  expect(item, label).toBeDefined();
  item!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function clickYes() {
  const action = document.getElementById("dialogAction");
  expect(action, "the confirmation's Yes button").not.toBeNull();
  action!.dispatchEvent(new MouseEvent("click"));
}

describe("dropping the stash the dialog named", () => {
  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    await import("@/webview/main");
    receive(branchesResponse);
    receive(commitsResponse(before));
  });

  it("drops it when the stack has not moved", () => {
    openMenuOn('.gitRef.stash[data-name="stash@{0}"]');
    clickItem(L.stashDrop + E);
    expect(document.getElementById("dialogAction"), "the confirmation").not.toBeNull();

    mock.clearMessages();
    clickYes();

    expect(sentOf("dropStash")).toEqual([
      { command: "dropStash", repo: DEFAULT_REPO, selector: "stash@{0}" }
    ]);
  });

  describe("when a stash pushed elsewhere renumbers the stack first", () => {
    beforeAll(() => {
      openMenuOn('.gitRef.stash[data-name="stash@{0}"]');
      clickItem(L.stashDrop + E);
      // The dialog names the stash by its number, which is the whole problem:
      // that is the consent, and it is about to stop being true.
      expect(document.getElementById("dialog")!.textContent).toContain("stash@{0}");

      // A whole background reload, the same shape the file watcher delivers.
      receive({ command: "refresh" });
      receive(branchesResponse);
      receive(commitsResponse(after));
    });

    it("leaves the question standing — the reload is not the user answering it", () => {
      // Without this the scenario below would be asserting nothing: a dialog
      // the reload had already closed has no Yes left to press.
      expect(document.getElementById("dialogAction"), "the confirmation").not.toBeNull();
    });

    it("really did renumber the stack underneath it", () => {
      expect(document.querySelector('tr.commit[data-hash="sNEW"] .gitRef.stash')?.textContent).toBe(
        "stash@{0}"
      );
      expect(document.querySelector('tr.commit[data-hash="sA"] .gitRef.stash')?.textContent).toBe(
        "stash@{1}"
      );
    });

    it("does not drop the stash that inherited the number", () => {
      mock.clearMessages();
      clickYes();

      // `stash@{0}` now means `sNEW`, which the user has never seen. Sending it
      // destroys someone else's work and leaves no ref pointing at it.
      expect(sentOf("dropStash")).toEqual([]);
    });

    it("says so, rather than leaving a dead button behind", () => {
      expect(document.getElementById("dialog")!.textContent).toContain(
        L.dialogStashMoved.replace("{0}", "stash@{0}")
      );
    });
  });
});
