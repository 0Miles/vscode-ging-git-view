import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";

import {
  clickId,
  createVscodeMock,
  DEFAULT_REPO,
  makeViewState,
  parkViewportAt,
  receive,
  setupHtml
} from "./setup";

// The lock (#230, `modalScrollLock`) holds the page against the user's input.
// The webview's own `window.scrollTo` and `scrollIntoView` still move it,
// `overflow: hidden` or not (#269 — measured in Chromium under a dialog:
// `scrollTo` from 3000 to 3500, a row's `scrollIntoView` from 3000 to 8764).
//
// What is pinned here is that the scrolls which run while a dialog stands in
// ordinary use cannot move it. A reload under an action's progress dialog
// writes back the offset it took while the page was already held there, and a
// background refresh under a dialog of the user's scrolls nothing at all
// (measured: the same `scrollY` before and after, and no scroll event). The
// scrolls that would move it — Find's match, the one-time scroll to HEAD, a
// Commit Details View opening, the loaded-commit-window reset's focus scroll,
// and a Refresh-button restore whose load lands under a dialog opened since —
// each answer something the user asked for, and are left to land where they
// would have without a dialog; see the restore in `loadCommits`.

const commits: GitCommitNode[] = [
  {
    hash: "aaa111",
    parentHashes: [],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Tip commit",
    refs: [
      { hash: "aaa111", name: "main", type: "head" },
      { hash: "aaa111", name: "feature", type: "head" }
    ]
  }
];

const dialogShown = () => document.getElementById("dialog")!.classList.contains("active");
const locked = () => document.documentElement.classList.contains("dialogOpen");

function answerLoads() {
  receive({
    command: "loadBranches",
    token: 0,
    branches: ["main", "feature"],
    head: "main",
    hard: true,
    isRepo: true,
    filter: []
  });
  receive({
    command: "loadCommits",
    token: 0,
    commits,
    head: "aaa111",
    moreCommitsAvailable: false,
    hard: true
  });
}

describe("the webview's own scrolls while a dialog stands", () => {
  let mock: ReturnType<typeof createVscodeMock>;
  const scrollTo = vi.fn();
  const scrollIntoView = vi.fn();
  const realScrollTo = window.scrollTo;
  const realScrollIntoView = Element.prototype.scrollIntoView;

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(makeViewState());
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    Element.prototype.scrollIntoView = scrollIntoView;
    await import("@/webview/main");
    answerLoads();
    parkViewportAt(3000);
  });

  afterAll(() => {
    window.scrollTo = realScrollTo;
    Element.prototype.scrollIntoView = realScrollIntoView;
    parkViewportAt(0);
  });

  it("writes back the offset an action's reload took under its progress dialog", () => {
    clickId("fetchBtn");
    receive({ command: "fetch", status: null }); // success: refresh, keeping the place
    expect(locked(), "the reload starts under the progress dialog").toBe(true);
    scrollTo.mockClear();
    scrollIntoView.mockClear();

    answerLoads();

    expect(scrollTo.mock.calls).toEqual([[0, 3000]]);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(dialogShown(), "the reload closes the progress dialog it finished").toBe(false);
  });

  it("scrolls nothing when a background refresh lands under a dialog of the user's", () => {
    receive({
      command: "runRefAction",
      repo: DEFAULT_REPO,
      ref: "feature",
      action: "delete",
      seq: 1
    });
    expect(dialogShown()).toBe(true);
    mock.clearMessages();
    receive({ command: "refresh" });
    expect(mock.sentMessages.some((m) => m.command === "loadBranches")).toBe(true);
    scrollTo.mockClear();
    scrollIntoView.mockClear();

    answerLoads();

    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(locked()).toBe(true);
  });
});
