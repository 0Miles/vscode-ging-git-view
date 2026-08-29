import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitDetails, GitCommitNode } from "@/backend/types";
import type * as GG from "@/types";

import {
  createVscodeMock,
  makeViewState,
  NEAR_BOTTOM,
  parkViewportAt,
  receive,
  setupHtml
} from "./setup";

// Stepping Find onto a branch far below the loaded window asks first, and the
// size it would load is worked out when the question goes up. The guard next to
// the mutations was already re-taken on the far side of that wait
// (droppedLoadRequests pins it); the *plan* was not.
//
// The window can still grow while the dialog stands. The overlay blocks the
// mouse and the keydown handler returns early, so neither Load More nor the
// keyboard can reach it — but the scroll listener has no dialog gate at all
// (issue #124), the overlay is not scrollable, and the wheel chains to the
// document. So a user who keeps scrolling behind the dialog widens the window,
// then presses Yes against a plan sized for the narrower one.
//
// `maxCommits` is assigned, not raised: the stale plan sets the window *back*,
// and every commit past the older number is dropped from a graph that had
// already drawn them — with the next Load More paging on from the smaller
// number, so nothing on screen ever says the two came apart. ADR-0019 states
// the rule this breaks: when the change is deferred into a callback, the
// reading it rests on is re-taken there too.
//
// One webview is booted for the file and the scenarios run in order against it,
// the way a session unfolds. Re-importing per scenario would leave the previous
// instance listening on `window` with its element handles pointing into a body
// that `setupHtml` has since replaced.

const viewState = makeViewState();

const tip: GitCommitNode = {
  hash: "aaa111",
  parentHashes: ["bbb222"],
  author: "Alice",
  email: "alice@example.com",
  date: 1700000000,
  message: "Tip commit",
  refs: [{ hash: "aaa111", name: "main", type: "head" }]
};

const base: GitCommitNode = {
  hash: "bbb222",
  parentHashes: [],
  author: "Bob",
  email: "bob@example.com",
  date: 1699000000,
  message: "Base commit",
  refs: []
};

/** The commit the deep branch points at, once a page deep enough brings it in. */
const ancient: GitCommitNode = {
  hash: "ancient999",
  parentHashes: [],
  author: "Carol",
  email: "carol@example.com",
  date: 1698000000,
  message: "Ancient commit",
  refs: [{ hash: "ancient999", name: "feature/ancient", type: "head" }]
};

/** Two more text hits for the same query, above and below the target, so that
 *  where Find lands after the target is amended away depends on which way the
 *  step it just made was going. */
const ancUp: GitCommitNode = {
  hash: "up111",
  parentHashes: [],
  author: "Dan",
  email: "dan@example.com",
  date: 1698500000,
  message: "ancient upper",
  refs: []
};
const ancDn: GitCommitNode = {
  hash: "dn222",
  parentHashes: [],
  author: "Erin",
  email: "erin@example.com",
  date: 1697000000,
  message: "ancient lower",
  refs: []
};

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

const branchesResponse: GG.ResponseMessage = {
  command: "loadBranches",
  branches: ["main"],
  head: "main",
  hard: true,
  isRepo: true,
  filter: []
};

function commitsResponse(commits: GitCommitNode[] = [tip, base]): GG.ResponseMessage {
  return {
    command: "loadCommits",
    commits,
    head: "aaa111",
    moreCommitsAvailable: true,
    hard: true
  };
}

let mock: ReturnType<typeof createVscodeMock>;

/** Which rows the webview asked to centre, by commit hash. jsdom implements no
 *  scrolling, so the stub records the receiver — every redraw replaces the row
 *  objects, and the hash is the only handle that survives to the assertion. */
const centred: (string | undefined)[] = [];
const scrollIntoView = vi.fn(function (this: Element) {
  centred.push((this as HTMLElement).dataset.hash);
});

const sentOf = (command: string) => mock.sentMessages.filter((m) => m.command === command);

function loadCommitsRequests() {
  return sentOf("loadCommits") as Extract<GG.RequestMessage, { command: "loadCommits" }>[];
}

function savedMaxCommits() {
  return mock.getState()!.maxCommits;
}

function click(id: string) {
  const elem = document.getElementById(id);
  expect(elem, id).not.toBeNull();
  elem!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function latestBranchSearchToken() {
  const requests = sentOf("branchSearch");
  expect(requests.length, "a branch index request").toBeGreaterThan(0);
  return (requests[requests.length - 1] as Extract<GG.RequestMessage, { command: "branchSearch" }>)
    .token;
}

/** How far past the loaded window the deep branch sits. Over 200, so
 *  `planFindLoad` asks before loading. Measured from the window rather than
 *  fixed, so the second scenario stands wherever the first one left it. */
const ADDITIONAL_COMMITS = 401;

let deepBranchLogDepth = 0;

/** Step Find onto a branch that far below the loaded window and leave its
 *  confirmation up. Two branch-index answers, because a step onto a branch hit
 *  revalidates the index before committing to a load.
 *
 *  `back` takes the Previous button instead of Enter, which is the only way to
 *  reach this dialog with a backwards direction on it — and direction is
 *  written nowhere until the step actually happens. */
function raiseFindLoadConfirmation(back = false) {
  // `logDepth` is a position in `git log` — the ruler `--max-count`, and so
  // `planFindLoad`, is measured on. See BranchSearchEntry.
  deepBranchLogDepth = savedMaxCommits() + ADDITIONAL_COMMITS - 1;
  const deepBranch = {
    ref: "feature/ancient",
    name: "feature/ancient",
    hash: "ancient999",
    logDepth: deepBranchLogDepth
  };
  const input = <HTMLInputElement>document.getElementById("findInput");
  input.value = "ancient";
  input.dispatchEvent(new KeyboardEvent("keyup", { key: "t" }));
  receive({
    command: "branchSearch",
    token: latestBranchSearchToken(),
    status: null,
    branches: [deepBranch]
  });
  if (back) click("findPrev");
  else input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter" }));
  receive({
    command: "branchSearch",
    token: latestBranchSearchToken(),
    status: null,
    branches: [deepBranch]
  });
  expect(document.getElementById("dialogAction"), "the confirmation dialog").not.toBeNull();
}

/** One turn of automatic loading behind the dialog: near the bottom, a scroll,
 *  and the page it asks for. Returns whether a request actually went out. */
function scrollLoadsAnotherPage(page: GitCommitNode[] = [tip, base]) {
  parkViewportAt(NEAR_BOTTOM);
  mock.clearMessages();
  document.dispatchEvent(new Event("scroll"));
  const asked = loadCommitsRequests().length > 0;
  if (asked) receive(commitsResponse(page));
  return asked;
}

describe("the size a confirmed Find load asks for", () => {
  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    Element.prototype.scrollIntoView = scrollIntoView;
    await import("@/webview/main");
    receive(branchesResponse);
    receive(commitsResponse());
    click("findBtn");
  });

  describe("when automatic loading widened the window while the question stood", () => {
    let planned = 0;
    let windowBeforeYes = 0;

    beforeAll(() => {
      raiseFindLoadConfirmation();
      // What the plan sized itself for, worked out from the fixture's own
      // numbers rather than read off the implementation: logDepth + 1, on the
      // `git log` ruler `--max-count` counts on.
      planned = deepBranchLogDepth + 1;

      // Five pages at loadMoreCount (100) each takes the window from the
      // opening 300 to 800, which is past the 701 the plan was sized for.
      for (let i = 0; i < 5; i++) {
        expect(scrollLoadsAnotherPage(), `automatic load ${i + 1} never went out`).toBe(true);
      }
      windowBeforeYes = savedMaxCommits();
      mock.clearMessages();
      click("dialogAction");
    });

    it("really did overtake the plan while the dialog stood", () => {
      // Without this the scenario proves nothing: a window still short of the
      // plan would satisfy the assertions below either way.
      expect(planned).toBe(701);
      expect(windowBeforeYes).toBe(800);
    });

    it("asks for at least the window that is already on screen", () => {
      const asked = loadCommitsRequests();
      expect(asked, "the confirmed load never went out").toHaveLength(1);
      expect(asked[0].maxCommits).toBeGreaterThanOrEqual(windowBeforeYes);
    });

    it("does not record a window narrower than the graph it is showing", () => {
      expect(savedMaxCommits()).toBeGreaterThanOrEqual(windowBeforeYes);
    });
  });

  describe("and when the target arrived on one of those pages instead", () => {
    let detailsOpenBefore = false;
    let detailsOpenAfter = false;

    beforeAll(() => {
      receive(commitsResponse()); // settle the load the previous scenario sent
      raiseFindLoadConfirmation();

      // The page that lands brings the branch's own commit with it, so the
      // match Find is stepping onto is now drawn.
      expect(scrollLoadsAnotherPage([tip, base, ancient])).toBe(true);

      // An expanded Commit Details View, so the reload's cost is observable:
      // the load path closes it to make room for a page that is not coming.
      document
        .querySelector<HTMLElement>('tr.commit[data-hash="aaa111"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      receive({ command: "commitDetails", commitDetails: tipDetails });
      detailsOpenBefore = document.getElementById("commitDetails") !== null;

      mock.clearMessages();
      centred.length = 0;
      click("dialogAction");
      detailsOpenAfter = document.getElementById("commitDetails") !== null;
    });

    it("really did draw the target, and had a details view to lose", () => {
      expect(document.querySelector('tr.commit[data-hash="ancient999"]')).not.toBeNull();
      expect(detailsOpenBefore).toBe(true);
    });

    it("reloads nothing, the match already being on screen", () => {
      expect(loadCommitsRequests()).toEqual([]);
    });

    it("leaves the Commit Details View open, having had no page to make room for", () => {
      expect(detailsOpenAfter).toBe(true);
    });

    it("still makes the step the user pressed Yes for", () => {
      // The highlight alone proves nothing here: with one match in the set,
      // the redraw that brought the target in had already resolved Find onto
      // it, so the class is there whether or not the press did anything.
      // Bringing the row into view is the part only the step does — and it is
      // the visible half of the step, on a match hundreds of rows down.
      expect(document.querySelector('tr.commit[data-hash="ancient999"]')!.className).toContain(
        "findMatchCurrent"
      );
      expect(centred).toContain("ancient999");
    });
  });

  // The step records which way it was going, and on this path it is the only
  // code left that can: the caller answered `hold` and returned long before Yes
  // was pressed, and no page is coming to carry the direction in.
  //
  // Nothing exposes it directly, so it is read where it is used. When a redraw
  // amends the current match away, Find falls back off the direction of the
  // step that put it there: backwards looks for the nearest match *above* the
  // depth it lost, forwards looks below and wraps to the top when there is
  // nothing there. Here those are two different rows.
  describe("and the direction that step was going", () => {
    let stepped: string[] = [];

    beforeAll(() => {
      // Back to a window the target is outside of, so the question can be asked
      // again — this time with Previous, the only route to this dialog carrying
      // a backwards direction.
      receive(commitsResponse([tip, base]));
      raiseFindLoadConfirmation(true);
      expect(scrollLoadsAnotherPage([tip, base, ancUp, ancient, ancDn])).toBe(true);
      centred.length = 0;
      click("dialogAction");
      stepped = centred.filter((hash): hash is string => hash !== undefined);

      // Now the target is rewritten away and its branch deleted with it, so
      // nothing Find is holding survives and the fallback has to choose.
      receive(commitsResponse([tip, base, ancUp, ancDn]));
      receive({
        command: "branchSearch",
        token: latestBranchSearchToken(),
        status: null,
        branches: []
      });
    });

    it("really did complete a backwards step first", () => {
      // Without this the assertion below would be reading whichever direction
      // the previous scenario happened to leave behind.
      expect(stepped).toContain("ancient999");
    });

    it("falls back the way a backwards step falls back, not a forwards one", () => {
      expect(document.querySelector('tr.commit[data-hash="dn222"]')!.className).toContain(
        "findMatchCurrent"
      );
      expect(document.querySelector('tr.commit[data-hash="up111"]')!.className).not.toContain(
        "findMatchCurrent"
      );
    });
  });
});
