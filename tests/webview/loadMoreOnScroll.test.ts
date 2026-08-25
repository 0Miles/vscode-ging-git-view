import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitDetails, GitCommitNode } from "@/backend/types";
import type * as GG from "@/types";

import { createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// Automatic loading on scroll is the continuation of *browsing*, so it must be
// indistinguishable from browsing: it may not move anything the user did not
// ask to have moved (ADR-0018). Pressing the button is an operation and may
// take the viewport with it; reaching the bottom of the graph is not.
//
// The load is asynchronous, and the user is by definition still scrolling when
// it fires — so anything that pins or restores a scroll offset taken at the
// moment of the trigger is pinning a stale one, and lands the user somewhere
// they had already left.

const viewState = makeViewState({ loadMoreAutomatically: true });

const commits: GitCommitNode[] = [
  {
    hash: "aaa111",
    parentHashes: ["bbb222"],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Tip commit",
    refs: [{ hash: "aaa111", name: "main", type: "head" }]
  },
  {
    hash: "bbb222",
    parentHashes: [],
    author: "Bob",
    email: "bob@example.com",
    date: 1699000000,
    message: "Base commit",
    refs: []
  }
];

const branchesResponse: GG.ResponseMessage = {
  command: "loadBranches",
  branches: ["main"],
  head: "main",
  hard: true,
  isRepo: true,
  filter: []
};

const commitsResponse: GG.ResponseMessage = {
  command: "loadCommits",
  commits,
  head: "aaa111",
  moreCommitsAvailable: true,
  hard: true
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

/** Park the viewport at a known offset. jsdom never scrolls on its own, and
 *  its scrollTo is unimplemented, so the offset has to be declared. */
function parkViewportAt(offset: number) {
  Object.defineProperty(window, "scrollY", { value: offset, configurable: true });
  Object.defineProperty(window, "pageYOffset", { value: offset, configurable: true });
}

describe("reaching the bottom of the graph with the Commit Details View open", () => {
  const scrollTo = vi.fn();
  let mock: ReturnType<typeof createVscodeMock>;
  let requestedOnTrigger: GG.RequestMessage[] = [];

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    await import("@/webview/main");
    receive(branchesResponse);
    receive(commitsResponse);

    // A CDV open above the viewport is what used to drag the user back: its
    // re-render re-ran the scroll that brings a CDV into view.
    document
      .querySelector<HTMLElement>('.commit[data-hash="aaa111"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    receive({ command: "commitDetails", commitDetails: tipDetails });

    parkViewportAt(900);
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    mock.clearMessages();

    // jsdom reports a zero-height body, so any scroll event clears the
    // "within 250px of the bottom" threshold.
    document.dispatchEvent(new Event("scroll"));
    requestedOnTrigger = mock.sentMessages.filter((m) => m.command === "loadCommits");

    // The user keeps going while the request is out — held PageDown, wheel
    // momentum, or simply still scrolling.
    parkViewportAt(1500);
    receive(commitsResponse);
  });

  it("loads the next page without being asked", () => {
    expect(requestedOnTrigger).toMatchObject([{ maxCommits: 400 }]);
  });

  it("keeps the CDV open across the load", () => {
    expect(document.getElementById("commitDetails")).not.toBeNull();
    expect(document.querySelector<HTMLElement>(".commit.commitDetailsOpen")?.dataset.hash).toBe(
      "aaa111"
    );
  });

  it("never moves the viewport, least of all back to where the load was triggered", () => {
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
