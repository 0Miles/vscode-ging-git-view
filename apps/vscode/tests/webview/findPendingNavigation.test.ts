import { beforeAll, describe, expect, it, vi } from "vitest";

import type { BranchSearchEntry, GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

import {
  clickId,
  createVscodeMock,
  dialogText,
  makeViewState,
  receive,
  search,
  setupHtml
} from "./setup";

// A Find step onto a match a branch name accounts for waits for a fresh branch
// index before it happens: the branch may have moved since the index in hand
// was fetched. While it waits it is a wish, not a move — `pendingFindNavigation`
// — and the answer decides. findCounterOnDroppedLoad pins the answers that say
// "go there" and "a load is in the way". This file pins what was left:
//
// - the answer that says the branch is gone, so the step has nowhere to go and
//   Find must stay where it was (#246);
// - a later press that steps past the wish onto a match no branch names, which
//   is a move made on the spot — so the wish it went past must not come back
//   and undo it when the answer lands (#247).
//
// One webview is booted for the whole file and the scenarios run in order;
// re-importing per scenario would leave the previous instance listening on
// `window` (#80). Every scenario starts by re-running the search, which puts
// Find back on the first match.

const L = getWebviewLocalizedStrings();

const viewState = makeViewState();

/** Two commits the search finds by message, and one between them it finds only
 *  through {@link baseBranch}. */
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

/** A branch on a drawn commit that matches nothing on its own. Being drawn, a
 *  step onto it needs no page: what it waits for is the index alone. */
const baseBranch: BranchSearchEntry = {
  ref: "fix/base",
  name: "fix/base",
  hash: "bbb222",
  logDepth: 1
};

const branchesResponse: GG.ResponseMessage = {
  command: "loadBranches",
  token: 0,
  branches: ["main"],
  head: "main",
  hard: true,
  isRepo: true,
  filter: []
};

const commitsResponse: GG.ResponseMessage = {
  command: "loadCommits",
  token: 0,
  commits,
  head: "aaa111",
  moreCommitsAvailable: true,
  hard: true
};

let mock: ReturnType<typeof createVscodeMock>;

/** Which rows were centred, by commit hash — the receiver rather than the
 *  argument, since `scrollIntoView` is stubbed on the prototype (jsdom has
 *  none) and the hash is the only handle that survives a redraw. */
const scrolledTo: (string | undefined)[] = [];

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

/** Answer the newest branch-index request; the webview drops staler ones. */
function deliverBranchIndex(branches: BranchSearchEntry[]) {
  const requests = mock.sentOf("branchSearch");
  expect(requests.length, "a branch index request to answer").toBeGreaterThan(0);
  receive({
    command: "branchSearch",
    branches,
    token: requests[requests.length - 1].token,
    status: null
  });
}

/** Search "fix" against an index that has {@link baseBranch} in it, so the
 *  matches are the tip, the branch, and the base — Find on the tip. */
function searchWithTheBranch() {
  deliverBranchIndex([baseBranch]);
  search("fix");
  expect(counter()).toBe(counterFor(1, 3));
  expect(currentMatchHash()).toBe("aaa111");
}

beforeAll(async () => {
  vi.resetModules();
  mock = createVscodeMock();
  setupHtml(viewState);
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
    scrolledTo.push((this as HTMLElement).dataset.hash);
  });
  await import("@/webview/main");
  receive(branchesResponse);
  receive(commitsResponse);
  clickId("findBtn");
});

describe("a step onto a branch that is gone by the time the answer lands", () => {
  beforeAll(() => {
    searchWithTheBranch();
    scrolledTo.length = 0;
    clickId("findNext"); // onto fix/base, a wish until the index comes back
    deliverBranchIndex([]); // and it comes back without that branch
  });

  it("leaves Find on the match it was on", () => {
    // The rebuild resolved the vanished target to the match after it, and
    // nothing put Find back: it sat on the base, a step the user never made.
    expect(counter()).toBe(counterFor(1, 2));
    expect(currentMatchHash()).toBe("aaa111");
  });

  it("moves nothing in front of the user", () => {
    // No step happened, so no step's scroll is owed — not even to the row the
    // rebuild guessed on its way past.
    expect(scrolledTo).toEqual([]);
  });

  it("leaves Find stepping from there", () => {
    clickId("findNext");
    expect(counter()).toBe(counterFor(2, 2));
    expect(currentMatchHash()).toBe("ccc333");
  });
});

describe("a second press past a step still waiting on its answer", () => {
  let afterSecondPress = "";

  beforeAll(() => {
    searchWithTheBranch();
    clickId("findNext"); // onto fix/base, a wish until the index comes back
    clickId("findNext"); // and on, from that wish, to the base — no branch there
    afterSecondPress = counter() ?? "";
    deliverBranchIndex([baseBranch]); // the first press's answer lands
  });

  it("counts the second press from where the first was heading", () => {
    // The precondition: presses compound while an answer is out.
    expect(afterSecondPress).toBe(counterFor(3, 3));
  });

  it("is not undone when the first press's answer lands", () => {
    // The second press moved Find on the spot. The wish it stepped past was
    // still standing, and its answer took Find back to the branch.
    expect(counter()).toBe(counterFor(3, 3));
    expect(currentMatchHash()).toBe("ccc333");
  });

  it("leaves Find stepping from there", () => {
    clickId("findNext"); // wraps to the tip, no branch there either
    expect(counter()).toBe(counterFor(1, 3));
    expect(currentMatchHash()).toBe("aaa111");
  });
});

// The confirmed load's twin of the case above. A step far enough out to ask
// first leaves the question standing, and a step waiting on its index can be
// raised under it; Yes then sends the page, the page re-requests the index,
// and that answer used to carry the wish back over the step the user had just
// confirmed. In the real webview the Find widget is `inert` behind the dialog
// (#141), so the press under the question is out of reach there — jsdom does
// not enforce `inert`, which is the only way in for this test. What it pins is
// the rule, not the route: the answer to a question is the last thing the user
// asked for, so it supersedes any wish still standing.
describe("a confirmed step over a step still waiting on its answer", () => {
  const farHash = "far999";
  let farBranch: BranchSearchEntry;
  let dialogUpUnderThePress = false;

  beforeAll(() => {
    farBranch = {
      ref: "fix/far",
      name: "fix/far",
      hash: farHash,
      // Over 200 past the loaded window, so the step asks before loading.
      logDepth: mock.getState()!.maxCommits + 400
    };
    deliverBranchIndex([baseBranch, farBranch]);
    search("fix"); // the tip, the branch, the base and the far tip; Find on the tip
    clickId("findPrev"); // wraps back onto the far tip
    deliverBranchIndex([baseBranch, farBranch]); // and asks first
    dialogUpUnderThePress = document.getElementById("dialogAction") !== null;
    clickId("findNext"); // onto fix/base: a wish, raised under the question
    clickId("dialogAction"); // Yes, to the far tip, before that wish's answer
    receive({
      ...commitsResponse,
      commits: [
        ...commits,
        {
          hash: farHash,
          parentHashes: [],
          author: "Dan",
          email: "dan@example.com",
          date: 1690000000,
          message: "Far commit",
          refs: []
        }
      ]
    });
    deliverBranchIndex([baseBranch, farBranch]); // the page's own re-request
  });

  it("had the question standing when the second press was made", () => {
    expect(dialogUpUnderThePress).toBe(true);
  });

  it("stays on the step the user confirmed", () => {
    expect(counter()).toBe(counterFor(4, 4));
    expect(currentMatchHash()).toBe(farHash);
  });
});

// The index is an answer to a `git` call, and the user may open a dialog while
// it is out. A step that then has to ask before loading is a host answer
// raising a question, so it waits behind that dialog rather than writing over
// it (#243); until the question is answered the step has not happened, owed or
// on screen.
describe("a step whose index lands behind a dialog the user has opened", () => {
  const fartherHash = "far888";
  let fartherBranch: BranchSearchEntry;
  let before = "";
  let underTheAnswer = "";

  beforeAll(async () => {
    fartherBranch = {
      ref: "fix/farther",
      name: "fix/farther",
      hash: fartherHash,
      logDepth: mock.getState()!.maxCommits + 400
    };
    deliverBranchIndex([baseBranch, fartherBranch]);
    search("fix"); // Find on the tip
    before = counter() ?? "";
    clickId("findPrev"); // wraps onto fix/farther: a wish until the index lands
    // A dialog of the user's, opened while the index is out.
    receive({ command: "copyToClipboard", type: "Commit Hash", success: false });
    deliverBranchIndex([baseBranch, fartherBranch]);
    underTheAnswer = dialogText();
  });

  it("leaves the user's dialog standing, and Find where it was", () => {
    expect(underTheAnswer).toContain(L.unableToCopyToClipboard.replace("{0}", L.typeCommitHash));
    expect(counter()).toBe(before);
  });

  it("asks once that dialog is closed", async () => {
    clickId("dialogDismiss");
    await Promise.resolve();
    expect(dialogText()).toContain(L.dialogFindLoadMoreConfirm.split("{0}")[0]);
    expect(document.getElementById("dialogAction")).not.toBeNull();
    clickId("dialogDismiss");
  });
});
