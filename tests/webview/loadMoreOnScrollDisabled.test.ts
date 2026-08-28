import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import type * as GG from "@/types";

import { createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// The other half of the auto-load-on-scroll switch. `loadMoreAutomatically` is
// read once, at boot, so "off" needs a webview of its own — hence a file of its
// own rather than a second describe in loadMoreOnScroll.test.ts, which boots
// with it on.
//
// The page is given the same geometry that file uses to trip the threshold, so
// the setting is the only thing standing between this scroll event and a load.

const viewState = makeViewState({ loadMoreAutomatically: false });

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

// More commits are available, so the switch is the only guard left that can
// refuse: a suite that let this be false would pass on the wrong reason.
const commitsResponse: GG.ResponseMessage = {
  command: "loadCommits",
  commits,
  head: "aaa111",
  moreCommitsAvailable: true,
  hard: true
};

const VIEWPORT_HEIGHT = 768;
const PAGE_HEIGHT = 10000;
const NEAR_BOTTOM = PAGE_HEIGHT - 250 - VIEWPORT_HEIGHT;

describe("automatic loading on scroll, switched off", () => {
  let mock: ReturnType<typeof createVscodeMock>;
  let heightReads = 0;

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    Object.defineProperty(window, "innerHeight", { value: VIEWPORT_HEIGHT, configurable: true });
    Object.defineProperty(window, "scrollY", { value: NEAR_BOTTOM, configurable: true });
    await import("@/webview/main");
    receive(branchesResponse);
    receive(commitsResponse);

    // Reading offsetHeight forces the browser to lay the document out, so
    // count the reads rather than just stubbing a value: with the feature off
    // the scroll handler must not pay that cost at all. Installed after the
    // graph has been rendered, so only the scroll event is being measured.
    Object.defineProperty(document.body, "offsetHeight", {
      get() {
        heightReads++;
        return PAGE_HEIGHT;
      },
      configurable: true
    });
    mock.clearMessages();
    document.dispatchEvent(new Event("scroll"));
  });

  it("asks for nothing, however close to the bottom the user is", () => {
    expect(mock.sentMessages.filter((m) => m.command === "loadCommits")).toHaveLength(0);
  });

  it("never measures the page, so scrolling costs no layout", () => {
    // The threshold sits behind two cheap booleans for exactly this reason
    // (ADR-0019 left the scroll handler unthrottled on that basis). Reordering
    // the condition would light this up.
    expect(heightReads).toBe(0);
  });
});
