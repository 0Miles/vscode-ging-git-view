import { describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";

import {
  clickItem,
  createVscodeMock,
  makeViewState,
  menuItemStartingWith,
  openMenuOn,
  receive,
  setupHtml
} from "./setup";

// The failure path of the shared `clickItem`, which no other suite reaches:
// every label they pass is one their menu really carries, so the guard inside it
// is never observed to fire. That is the blind spot issue #131 was filed about —
// `expect(item, label).not.toBeNull()` was satisfied by the `undefined` that
// `find` answers on a miss, so it read like a guard while catching nothing, and
// five green suites said the same thing either way. Correcting the guard without
// exercising it would have left the blind spot exactly where it was: the next
// person to put `not.toBeNull()` back gets a green run too.
//
// There is deliberately no assertion stating that the throw is not the old
// TypeError. Such a line cannot fail once the message has matched. What rules
// the TypeError out is the match itself: with the guard reverted this reads
// `expected [Function] to throw error including 'no context menu carries this
// label' but got 'Cannot read properties of undefined (…'`, which is the
// original failure quoted back, a line too late and naming nothing. An
// assertion that cannot fail is the very defect under test here, so it does not
// get to stand in the test for it.

/** A label no context menu carries, so `find` misses whatever is on screen. */
const MISSING = "no context menu carries this label";

const commit: GitCommitNode = {
  hash: "aaa111",
  parentHashes: [],
  author: "Alice",
  email: "alice@example.com",
  date: 1700000000,
  message: "Tip",
  refs: []
};

describe("activating a context-menu item the menu does not carry", () => {
  it("fails at the guard, naming the label it was looking for", () => {
    // The extension's real markup, so the `#contextMenu` being searched is the
    // one that ships rather than a hand-rolled stand-in. It is empty here, and
    // an empty menu is the same miss as a menu without this entry — `find`
    // answers `undefined` for both.
    setupHtml(makeViewState());

    expect(() => clickItem(MISSING)).toThrowError(MISSING);
    expect(() => menuItemStartingWith(MISSING)).toThrowError(MISSING);
  });

  it("names every item the open menu does carry", async () => {
    // A real menu this time, raised the way a user raises it, so the list the
    // failure quotes is the one a drifted fixture would actually be staring at.
    // That list is why the guard throws rather than asserts (#154): a bare
    // "expected undefined to be defined" says the label is missing, and leaves
    // finding out what the menu offered instead to a second run.
    vi.resetModules();
    createVscodeMock();
    setupHtml(makeViewState());
    await import("@/webview/main");
    receive({
      command: "loadBranches",
      token: 0,
      branches: [],
      head: null,
      hard: true,
      isRepo: true,
      filter: []
    });
    receive({
      command: "loadCommits",
      token: 0,
      commits: [commit],
      head: "aaa111",
      moreCommitsAvailable: false,
      hard: true
    });
    openMenuOn('#commitTable tr.commit[data-hash="aaa111"]');

    const carried = Array.from(
      document.querySelectorAll<HTMLElement>("#contextMenu .contextMenuItem")
    ).map((li) => (li.textContent ?? "").trim());
    expect(carried.length, "the commit menu opened with items").toBeGreaterThan(0);

    let message = "";
    try {
      clickItem(MISSING);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(MISSING);
    for (const label of carried) expect(message).toContain(label);

    // The prefix lookup misses through the same guard, for the same reason:
    // `contextMenuGutter` and `dialogRememberCheckbox` each carried their own
    // copy of it until #266, and none of them ever reached the miss either.
    message = "";
    try {
      menuItemStartingWith(MISSING);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(MISSING);
    for (const label of carried) expect(message).toContain(label);
  });
});
