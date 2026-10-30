import { beforeAll, describe, expect, it, vi } from "vitest";

import type { BranchSearchEntry, GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

import { clickId, createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// A Find step onto a match a branch name accounts for waits for a fresh branch
// index before it happens: the branch may have moved since the index in hand
// was fetched. While it waits it is a wish, not a move — `pendingFindNavigation`
// — and the answer decides. findCounterOnDroppedLoad pins the answers that say
// "go there" and "a load is in the way". This file pins what was left:
//
// - the answer that says the branch is gone, so the step has nowhere to go and
//   Find must stay where it was (#246).
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

function search(query: string) {
  const input = document.getElementById("findInput") as HTMLInputElement;
  input.value = query;
  input.dispatchEvent(new KeyboardEvent("keyup", { key: "x", bubbles: true }));
}

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

function sentOf(command: GG.RequestMessage["command"]) {
  return mock.sentMessages.filter((m) => m.command === command);
}

/** Answer the newest branch-index request; the webview drops staler ones. */
function deliverBranchIndex(branches: BranchSearchEntry[]) {
  const requests = sentOf("branchSearch");
  expect(requests.length, "a branch index request to answer").toBeGreaterThan(0);
  receive({
    command: "branchSearch",
    branches,
    token: (requests[requests.length - 1] as { token: number }).token,
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
