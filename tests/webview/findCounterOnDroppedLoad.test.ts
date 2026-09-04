import { beforeAll, describe, expect, it, vi } from "vitest";

import type { BranchSearchEntry, GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

import { createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// The `3 of 7` counter and the highlighted row are two readings of one fact —
// which match Find is on — so they may never disagree. A step onto a match past
// the loaded commit window needs a page to reach it, and `requestLoadCommits`
// drops any request that arrives while one is already in flight (ADR-0019
// declined queueing it). The counter used to be moved before that was known, so
// a dropped request left it reading one match ahead of the highlight for good.
//
// The fix is the one ADR-0019 names: report whether the request went out, and
// put the guard at the front of the same synchronous stretch as the state
// change. A step onto a branch match has no such stretch at the click — it is
// waiting on a revalidated branch index — so the whole step waits with it, and
// the only thing left to undo is what the arrival itself moved. What the fix
// must NOT be is a guard at the top of the step: matches already on screen need
// no request at all, and they are almost all of them, so that would stall Find
// navigation for the whole of every background load. The scenarios below pin
// both halves.
//
// One webview is booted for the whole file and the scenarios run in order
// against it, the way a session actually unfolds; re-importing the module per
// scenario would leave the previous instance still listening on `window` (#80).
// The loaded commit window therefore carries across scenarios: it opens at the
// fixture's initialLoadCommits (300) and each accepted load adds loadMoreCount
// (100).

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
    hash: "bbb222",
    parentHashes: ["ccc333"],
    author: "Bob",
    email: "bob@example.com",
    date: 1699000000,
    message: "Base commit",
    refs: []
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

/** What a Load More page brings back: the same commits with one more behind
 *  them, and nothing in it that the "fix" search matches — the page is
 *  background noise, not the page Find is waiting for. One scenario near the
 *  end searches for something else, and this commit is the one loaded match it
 *  finds. */
const nextPage: GitCommitNode[] = [
  ...commits,
  {
    hash: "ddd444",
    parentHashes: [],
    author: "Dave",
    email: "dave@example.com",
    date: 1697000000,
    message: "Further work",
    refs: []
  }
];

/** The page that finally reaches `fix/deep`'s tip. Its message matches nothing
 *  — it is a match only because a branch named for the search points at it,
 *  which is the only way a match can exist with no row to highlight. */
const deepPage: GitCommitNode[] = [
  ...nextPage,
  {
    hash: "zzz999",
    parentHashes: [],
    author: "Erin",
    email: "erin@example.com",
    date: 1696000000,
    message: "Deep commit",
    refs: []
  }
];

/** What a background refresh lands once the commit Find was on has been amended
 *  out of the history. */
const amendedPage: GitCommitNode[] = deepPage.filter((commit) => commit.hash !== "aaa111");

/** The page a confirmed Find load brings back. */
const ancientPage: GitCommitNode[] = [
  ...amendedPage,
  {
    hash: "ancient9",
    parentHashes: [],
    author: "Gina",
    email: "gina@example.com",
    date: 1695000000,
    message: "Ancient commit",
    refs: []
  }
];

/** And the same for the one loaded match the "further" search has. */
const amendedFurtherPage: GitCommitNode[] = ancientPage.filter(
  (commit) => commit.hash !== "ddd444"
);

const branchesResponse: GG.ResponseMessage = {
  command: "loadBranches",
  token: 0,
  branches: ["main"],
  head: "main",
  hard: true,
  isRepo: true,
  filter: []
};

function commitsResponse(loaded: GitCommitNode[], head = "aaa111"): GG.ResponseMessage {
  return {
    command: "loadCommits",
    token: 0,
    commits: loaded,
    head,
    moreCommitsAvailable: true,
    hard: true
  };
}

/** A branch tip just past the loaded commit window: Find can count it and name
 *  it, but there is no row to highlight until a page reaches it. */
const deepBranch: BranchSearchEntry = {
  ref: "fix/deep",
  name: "fix/deep",
  hash: "zzz999",
  // `logDepth`, not a graph row: this is a position in `git log`, the ruler
  // planFindLoad sizes the window against. See BranchSearchEntry.
  logDepth: 4
};

/** A second such tip, further out, and one no scenario ever loads — it is here
 *  to be the match a step can wrap backwards onto. */
const furtherBranch: BranchSearchEntry = {
  ref: "fix/further",
  name: "fix/further",
  hash: "www888",
  logDepth: 8
};

/** A branch on a commit that matches nothing on its own, so that dropping it
 *  from the index shortens the match list from above and shifts everything
 *  below it up a place. */
const baseBranch: BranchSearchEntry = {
  ref: "fix/base",
  name: "fix/base",
  hash: "bbb222",
  logDepth: 0
};

/** Two more tips past the window, named for the other search this file runs. */
const furtherOne: BranchSearchEntry = {
  ref: "further/one",
  name: "further/one",
  hash: "uuu111",
  logDepth: 900
};
const furtherTwo: BranchSearchEntry = {
  ref: "further/two",
  name: "further/two",
  hash: "uuu222",
  logDepth: 950
};

/** Type a search. The widget searches on `keyup`, one keystroke at a time; the
 *  key itself only has to be neither Enter (step) nor Escape (close). */
function search(query: string) {
  const input = document.getElementById("findInput") as HTMLInputElement;
  input.value = query;
  input.dispatchEvent(new KeyboardEvent("keyup", { key: "x", bubbles: true }));
}

/** What the counter reads, built from the same localized template the widget
 *  fills in — so the assertion names a position, not a substring a neighbouring
 *  number would also satisfy. */
function counterFor(current: number, total: number) {
  return L.findCount.replace("{0}", String(current)).replace("{1}", String(total));
}

function counter() {
  return document.getElementById("findCount")!.textContent;
}

function currentMatchHash() {
  return document.querySelector<HTMLElement>("#commitTable tr.commit.findMatchCurrent")?.dataset
    .hash;
}

describe("Find's counter when the page a step needs never goes out", () => {
  const scrollTo = vi.fn();
  /** Which rows were centred, by commit hash. The receiver is recorded rather
   *  than the argument: `scrollIntoView` is stubbed on the prototype (jsdom has
   *  none), and every redraw replaces the row objects, so the hash is the only
   *  handle that survives to the assertion. */
  const scrolledTo: (string | undefined)[] = [];
  const scrollIntoView = vi.fn(function (this: Element) {
    scrolledTo.push((this as HTMLElement).dataset.hash);
  });
  let mock: ReturnType<typeof createVscodeMock>;
  /** The tip far enough past the window to need confirming. Sized off the
   *  window as it stands when that scenario is reached, and kept in the index
   *  by the scenarios after it. */
  let ancientBranch: BranchSearchEntry;

  function clearMovement() {
    scrollTo.mockClear();
    scrollIntoView.mockClear();
    scrolledTo.length = 0;
  }

  function click(id: string) {
    const elem = document.getElementById(id);
    expect(elem, id).not.toBeNull();
    elem!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }

  function sentOf(command: GG.RequestMessage["command"]) {
    return mock.sentMessages.filter((m) => m.command === command);
  }

  function savedMaxCommits() {
    return mock.getState()!.maxCommits;
  }

  /** The token the webview is currently waiting on. Every load re-requests the
   *  branch index, and `loadBranchSearchIndex` drops anything staler. */
  function latestBranchSearchToken() {
    const requests = sentOf("branchSearch");
    expect(requests.length, "a branch index request to answer").toBeGreaterThan(0);
    return (requests[requests.length - 1] as { token: number }).token;
  }

  /** What the host answers `branchSearch` with, until a scenario says
   *  otherwise. It is a standing fact about the repo, not a one-off reply. */
  let branchIndex: BranchSearchEntry[] = [];

  function deliverBranchIndex(entries: BranchSearchEntry[] = branchIndex) {
    branchIndex = entries;
    receive({
      command: "branchSearch",
      branches: branchIndex,
      token: latestBranchSearchToken(),
      status: null
    });
  }

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

  describe("searching", () => {
    beforeAll(() => {
      click("findBtn");
      deliverBranchIndex([deepBranch]);
      clearMovement();
      search("fix");
    });

    it("counts the branch tip it cannot draw alongside the rows it can", () => {
      // Two commit messages and one branch whose tip is past the window.
      expect(counter()).toBe(counterFor(1, 3));
      expect(currentMatchHash()).toBe("aaa111");
    });
  });

  describe("stepping between matches already on screen while a page is in flight", () => {
    beforeAll(() => {
      // Widen the loaded commit window and leave that page in flight.
      click("loadMoreCommitsBtn");
      mock.clearMessages();
      clearMovement();
      click("findNext");
    });

    it("moves, because reaching this match needs no page at all", () => {
      // The scenario the obvious fix breaks. Guarding the step on "is a load in
      // flight" would stall this — and matches already on screen are almost
      // every match, so Find would go dead for the whole of every background
      // load.
      expect(counter()).toBe(counterFor(2, 3));
      expect(currentMatchHash()).toBe("ccc333");
      expect(scrolledTo).toEqual(["ccc333"]);
    });

    it("asks the host for nothing", () => {
      expect(sentOf("branchSearch")).toHaveLength(0);
      expect(sentOf("loadCommits")).toHaveLength(0);
    });
  });

  describe("stepping onto a match past the window while that page is in flight", () => {
    beforeAll(() => {
      mock.clearMessages();
      clearMovement();
      // A branch match revalidates the index before committing to a load — the
      // branch may have moved — so the load is decided when that answer
      // arrives, not on the click.
      click("findNext");
      deliverBranchIndex();
    });

    it("sends nothing, the earlier page still being in flight", () => {
      expect(sentOf("loadCommits")).toHaveLength(0);
    });

    it("leaves the counter and the highlight where they were, together", () => {
      // The bug: the counter read 3 of 3 while the highlight — and the viewport
      // — stayed on the second match, and nothing was ever coming to reconcile
      // them.
      expect(counter()).toBe(counterFor(2, 3));
      expect(currentMatchHash()).toBe("ccc333");
      expect(scrolledTo).toEqual([]);
    });
  });

  describe("and once that page lands, the same step again", () => {
    beforeAll(() => {
      receive(commitsResponse(nextPage));
      deliverBranchIndex();
      mock.clearMessages();
      clearMovement();
      click("findNext");
      deliverBranchIndex();
    });

    it("goes out for the page this time", () => {
      expect(sentOf("loadCommits")).toMatchObject([{ hard: true }]);
    });

    it("moves the counter ahead of the highlight, which is what an async load looks like", () => {
      // Nothing to roll back here: the request is on its way, and the page that
      // answers it brings the highlight. A counter that waits for the page
      // would leave the user's keypress with no visible effect at all.
      expect(counter()).toBe(counterFor(3, 3));
      expect(currentMatchHash()).toBeUndefined();
    });

    describe("and when the page arrives", () => {
      beforeAll(() => {
        clearMovement();
        receive(commitsResponse(deepPage));
        deliverBranchIndex();
      });

      it("brings the highlight and the viewport to the match the counter named", () => {
        expect(counter()).toBe(counterFor(3, 3));
        expect(currentMatchHash()).toBe("zzz999");
        expect(scrolledTo).toEqual(["zzz999"]);
      });
    });
  });

  describe("stepping onto a branch match that is already on screen, page in flight", () => {
    beforeAll(() => {
      // Widen the window again and leave the page in flight.
      click("loadMoreCommitsBtn");
      click("findNext"); // wraps to the first match
      click("findNext"); // and on to the second
      mock.clearMessages();
      clearMovement();
      click("findNext"); // onto the branch match, now drawn
      deliverBranchIndex();
    });

    it("moves, a match already drawn needing no page even while one is in flight", () => {
      // `planFindLoad` returns null for a loaded match: no request was needed,
      // which is not the same as a request that could not be sent. Reading the
      // two as one failure would roll the counter back off a match that is
      // right there on screen.
      expect(counter()).toBe(counterFor(3, 3));
      expect(currentMatchHash()).toBe("zzz999");
      expect(sentOf("loadCommits")).toHaveLength(0);
      // Twice, and the double move predates this change: the rebuild centres
      // the pending hash, then the pass that follows the branch refs centres it
      // again. Written out rather than hidden behind a last-element check,
      // because a suite that tolerates the count cannot notice it growing.
      expect(scrolledTo).toEqual(["zzz999", "zzz999"]);
    });
  });

  describe("a step backwards that never goes out", () => {
    beforeAll(() => {
      // Settle the page left in flight above, and widen the index with a second
      // tip past the window for a backwards step to wrap onto.
      receive(commitsResponse(deepPage));
      deliverBranchIndex([deepBranch, furtherBranch]);
      // Back to the first match, leaving the last step's direction forwards.
      search("fix");
      click("loadMoreCommitsBtn");
      mock.clearMessages();
      clearMovement();
      click("findPrev");
      deliverBranchIndex();
    });

    it("puts the counter and the highlight back on the match it started from", () => {
      expect(counter()).toBe(counterFor(1, 4));
      expect(currentMatchHash()).toBe("aaa111");
      expect(sentOf("loadCommits")).toHaveLength(0);
    });

    describe("and a refresh that amends that match away", () => {
      beforeAll(() => {
        clearMovement();
        receive(commitsResponse(amendedPage, "bbb222"));
        deliverBranchIndex();
      });

      it("carries on forwards, the backwards step having been taken back too", () => {
        // Which way Find resumes when its match disappears is the one thing the
        // recorded direction decides. A step that never happened must not leave
        // its direction behind: with the backwards one still standing, Find
        // resumes at the last match instead of the next one, and lands on a
        // branch tip with no row at all.
        expect(document.querySelector('tr.commit[data-hash="aaa111"]')).toBeNull();
        expect(counter()).toBe(counterFor(1, 3));
        expect(currentMatchHash()).toBe("ccc333");
      });
    });
  });

  describe("a step onto a match far enough out to need confirming", () => {
    /** How far past the window the confirmable branch sits. Anything over 200
     *  makes planFindLoad ask first; measuring it from the window rather than
     *  fixing a position keeps this standing wherever the earlier scenarios
     *  left the window. */
    const ADDITIONAL_COMMITS = 401;
    let confirmText = "";

    beforeAll(() => {
      ancientBranch = {
        ref: "fix/ancient",
        name: "fix/ancient",
        hash: "ancient9",
        logDepth: savedMaxCommits() + ADDITIONAL_COMMITS - 1
      };
      deliverBranchIndex([deepBranch, furtherBranch, ancientBranch]);
      mock.clearMessages();
      clearMovement();
      // Backwards from the first match wraps onto the deepest one.
      click("findPrev");
      deliverBranchIndex();
      confirmText = document.getElementById("dialog")!.textContent ?? "";
    });

    it("asks first, the match being that far past the window", () => {
      expect(document.getElementById("dialogAction"), "confirmation dialog").not.toBeNull();
      expect(confirmText).toContain(String(ADDITIONAL_COMMITS));
    });

    it("leaves the counter where it was while the question stands", () => {
      // Nothing has been sent and nothing may ever be: the answer decides. A
      // counter that moved when the dialog went up would be describing a
      // navigation that has not happened, and Cancel would strand it there.
      expect(counter()).toBe(counterFor(1, 4));
      expect(currentMatchHash()).toBe("ccc333");
      expect(sentOf("loadCommits")).toHaveLength(0);
    });

    describe("and cancelled", () => {
      beforeAll(() => {
        mock.clearMessages();
        clearMovement();
        click("dialogDismiss");
      });

      it("takes the question away and leaves Find alone", () => {
        // The dismiss button carries no callback today, so these hold by the
        // dialog doing nothing at all. They are here for the day it does: a
        // Cancel that reached back into Find would be the same defect over
        // again, and the counter is where it would show.
        expect(document.getElementById("dialogAction")).toBeNull();
        expect(counter()).toBe(counterFor(1, 4));
        expect(currentMatchHash()).toBe("ccc333");
        expect(scrolledTo).toEqual([]);
        expect(sentOf("loadCommits")).toHaveLength(0);
      });

      it("leaves Find usable, the position it kept being a real one", () => {
        // The counter above could read right and still be describing a Find
        // that has lost its place. Stepping proves it has not: from the match
        // it went back to, the next one is the one after that.
        click("findNext");
        deliverBranchIndex();
        expect(counter()).toBe(counterFor(2, 4));
        expect(currentMatchHash()).toBe("zzz999");
        // and back again, so the scenario after this one starts where this one
        // found things.
        click("findPrev");
        expect(counter()).toBe(counterFor(1, 4));
        expect(currentMatchHash()).toBe("ccc333");
      });
    });

    describe("and, asked again, confirmed", () => {
      /** The counter after the last completed navigation before the confirmed
       *  one, which this block makes a forwards step on purpose. */
      let onArrival = "";

      beforeAll(() => {
        // Everything below rests on the direction being the opposite of the one
        // the confirmed step carries, and the cancelled attempt above left it
        // backwards — so it is put forwards again here rather than inherited.
        // Re-running the search then seats Find back on the first match without
        // touching the direction, which is the only way to reach the deepest
        // match at all: it is the last one, so only a backwards wrap gets there.
        click("findNext");
        deliverBranchIndex();
        onArrival = counter() ?? "";
        search("fix");

        click("findPrev");
        deliverBranchIndex();
        mock.clearMessages();
        clearMovement();
        click("dialogAction");
      });

      it("came in from a completed forwards step", () => {
        expect(onArrival).toBe(counterFor(2, 4));
      });

      it("goes out for the page it asked about", () => {
        expect(sentOf("loadCommits")).toMatchObject([
          { maxCommits: savedMaxCommits(), hard: true }
        ]);
        expect(savedMaxCommits()).toBe(ancientBranch.logDepth + 1);
      });

      it("still moves nothing until the page it asked for arrives", () => {
        expect(counter()).toBe(counterFor(1, 4));
        expect(currentMatchHash()).toBe("ccc333");
        expect(scrolledTo).toEqual([]);
      });

      describe("and when that page arrives", () => {
        beforeAll(() => {
          clearMovement();
          receive(commitsResponse(ancientPage, "bbb222"));
          deliverBranchIndex();
        });

        it("takes the counter, the highlight and the viewport there together", () => {
          expect(counter()).toBe(counterFor(3, 4));
          expect(currentMatchHash()).toBe("ancient9");
          expect(scrolledTo).toEqual(["ancient9"]);
        });

        describe("and then the branch that named that match is deleted", () => {
          beforeAll(() => {
            clearMovement();
            // No page, no keypress: an index re-fetched after some later load
            // coming back without that branch, which leaves the commit loaded
            // but matching nothing.
            deliverBranchIndex([deepBranch, furtherBranch]);
          });

          it("resumes backwards, the confirmed step having recorded its direction", () => {
            // The confirmed step is the only navigation between the forwards
            // one asserted at the top of this block and here, and it went
            // backwards. Resuming backwards is therefore only possible if the
            // request going out recorded that — the caller that raised the
            // dialog answered "hold" and returned an unbounded wait earlier.
            // With the forwards direction still standing, Find resumes at the
            // first match below the one that vanished, which has no row at all.
            expect(counter()).toBe(counterFor(2, 3));
            expect(currentMatchHash()).toBe("zzz999");
          });
        });
      });
    });
  });

  describe("a step that never goes out, over an index that lost a match above", () => {
    beforeAll(() => {
      // A branch on a commit the search would otherwise miss, so the match list
      // gains an entry above the one Find is standing on.
      deliverBranchIndex([baseBranch, deepBranch, furtherBranch, ancientBranch]);
      // A completed forwards step back onto the deepest drawn match, so that
      // going back by row number and going back by commit disagree.
      click("findNext");
      deliverBranchIndex();
      click("loadMoreCommitsBtn");
      mock.clearMessages();
      clearMovement();
      click("findNext"); // onto the tip past the window
      // and the answer comes back with that extra branch gone, so every match
      // below it slides up a place while the step is out.
      deliverBranchIndex([deepBranch, furtherBranch, ancientBranch]);
    });

    it("goes back to the match it started from, not to the place that match had", () => {
      // The rollback names a commit, not a row number: an answer arriving with
      // the list rebuilt underneath it makes the number point at whatever moved
      // into that slot — here, the very match the step failed to reach.
      expect(counter()).toBe(counterFor(3, 4));
      expect(currentMatchHash()).toBe("ancient9");
      expect(sentOf("loadCommits")).toHaveLength(0);
    });
  });

  describe("two presses while the same answer is still out", () => {
    beforeAll(() => {
      receive(commitsResponse(ancientPage, "bbb222")); // settle the page above
      deliverBranchIndex();
      search("fix"); // back to the first match
      mock.clearMessages();
      clearMovement();
      click("findNext"); // onto the second match, an answer now out for it
      click("findNext"); // and again, before it comes
      deliverBranchIndex();
    });

    it("counts the second press from where the first was heading", () => {
      // A step waiting on an answer has recorded nothing, which is what makes
      // the counter honest — but it is still where the user asked to be, so
      // pressing again has to go on from there. Counting from the unmoved
      // position instead would silently swallow the second press, and holding
      // the key down would move Find one match per round trip.
      expect(counter()).toBe(counterFor(3, 4));
      expect(currentMatchHash()).toBe("ancient9");
    });

    it("asked once per press and acted on the last answer only", () => {
      // Both presses go out for a fresh index; the webview discards answers to
      // superseded ones, so only the newest token could have moved anything.
      expect(sentOf("branchSearch")).toHaveLength(2);
      expect(sentOf("loadCommits")).toHaveLength(0);
    });
  });

  describe("a forwards step that never goes out, with Find running backwards", () => {
    beforeAll(() => {
      receive(commitsResponse(ancientPage, "bbb222")); // settle the page above
      deliverBranchIndex();
      // Walk down to the one match no branch names and back up, so that the
      // last completed step is a backwards one taken on the path that records
      // the direction on the spot rather than through an answer later — and so
      // that it is genuinely recording something, the step before it having
      // been forwards.
      click("findPrev");
      deliverBranchIndex();
      click("findPrev"); // onto the match with no branch
      click("findNext"); // back up, forwards
      deliverBranchIndex();
      click("findPrev"); // and down again, the step under test
      // Two more tips past the window, and a search that finds them plus one
      // loaded commit. Changing the search re-seats Find at the first match
      // without touching the direction the step left.
      deliverBranchIndex([deepBranch, furtherBranch, ancientBranch, furtherOne, furtherTwo]);
      search("further");
      click("loadMoreCommitsBtn");
      mock.clearMessages();
      clearMovement();
      click("findNext");
      deliverBranchIndex();
    });

    it("puts the counter and the highlight back", () => {
      expect(counter()).toBe(counterFor(1, 4));
      expect(currentMatchHash()).toBe("ddd444");
      expect(sentOf("loadCommits")).toHaveLength(0);
    });

    describe("and a refresh that amends that match away", () => {
      beforeAll(() => {
        receive(commitsResponse(amendedFurtherPage, "bbb222"));
        deliverBranchIndex();
      });

      it("resumes backwards, the forwards step having left nothing behind", () => {
        // The mirror of the backwards case, and the half a fixed direction
        // would get wrong. Every match left is below the one that vanished, so
        // running backwards finds nothing above it and settles on the last;
        // running forwards would settle on the first. Same rebuild, opposite
        // ends — which is what makes the recorded direction visible at all.
        expect(counter()).toBe(counterFor(3, 3));
      });
    });
  });

  describe("a branch that moved between the click and the answer", () => {
    beforeAll(() => {
      search("fix");
      click("findNext"); // onto the second match
      deliverBranchIndex();
      click("findNext"); // and the third
      deliverBranchIndex();
      mock.clearMessages();
      clearMovement();
      click("findNext"); // onto the tip past the window
      // Revalidating is the whole reason a branch step waits for an answer: by
      // the time it comes, this branch has been moved onto a commit that is
      // already drawn.
      deliverBranchIndex([
        deepBranch,
        { ref: "fix/further", name: "fix/further", hash: "zzz999", logDepth: 2 },
        ancientBranch,
        furtherOne,
        furtherTwo
      ]);
    });

    it("takes Find to where the branch went, not to where the rebuild guessed", () => {
      // The rebuild has no idea the branch moved — it resolves the vanished tip
      // by depth and lands on the first match. Only the pass that follows the
      // branch refs knows better, and it is the one that has to paint.
      expect(counter()).toBe(counterFor(2, 3));
      expect(currentMatchHash()).toBe("zzz999");
      expect(sentOf("loadCommits")).toHaveLength(0);
      // The rebuild's guess is centred on the way past, which is the same
      // pre-existing double move as above, here landing on two different rows.
      expect(scrolledTo).toEqual(["ccc333", "zzz999"]);
    });

    describe("and moved to a commit that is also past the window", () => {
      beforeAll(() => {
        // Put the branch back where it was, and step onto it again.
        deliverBranchIndex([deepBranch, furtherBranch, ancientBranch, furtherOne, furtherTwo]);
        click("findNext"); // onto the third match
        deliverBranchIndex();
        mock.clearMessages();
        clearMovement();
        click("findNext"); // onto the tip past the window
        deliverBranchIndex([
          deepBranch,
          { ref: "fix/further", name: "fix/further", hash: "vvv777", logDepth: 6 },
          ancientBranch,
          furtherOne,
          furtherTwo
        ]);
      });

      it("counts the branch's new tip, not the one the rebuild settled on", () => {
        // Nothing can be highlighted — the new tip has no row either, which is
        // why a page is on its way — so the counter is the only reading there
        // is, and it has to be a reading of where Find now points. Leaving it
        // on the rebuild's guess until the page lands is #108 in miniature.
        expect(sentOf("loadCommits")).toMatchObject([{ hard: true }]);
        expect(counter()).toBe(counterFor(4, 4));
        expect(currentMatchHash()).toBeUndefined();
      });
    });
  });
});
