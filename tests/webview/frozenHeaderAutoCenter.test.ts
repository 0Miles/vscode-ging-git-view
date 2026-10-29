import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitDetails, GitCommitNode } from "@/backend/types";

import {
  VIEWPORT_HEIGHT,
  createVscodeMock,
  makeViewState,
  parkViewportAt,
  receive,
  setupHtml
} from "./setup";

/* frozenHeader.test.ts with "Center Commit Details View" on: centring has to
 * mean centred in what the frozen header (#206) leaves visible, not in the
 * whole viewport, or the opened commit sits half a header too high. A suite of
 * its own because the setting is read once, when the webview starts.
 *
 * The strip's height is declared as Chromium resolves main.css's rule — see
 * the note atop frozenHeader.test.ts. */
const FROZEN = 63;

const viewState = makeViewState({ autoCenterCommitDetailsView: true });

const commits: GitCommitNode[] = [
  {
    hash: "aaa111",
    parentHashes: [],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Only commit",
    refs: [{ hash: "aaa111", name: "main", type: "head" }]
  }
];

const details: GitCommitDetails = {
  hash: "aaa111",
  parents: [],
  author: "Alice",
  email: "alice@example.com",
  committer: "Alice",
  committerEmail: "alice@example.com",
  authorDate: 1700000000,
  commitDate: 1700000000,
  body: "Body",
  fileChanges: []
};

describe("centring the Commit Details View under the frozen header", () => {
  const scrollTo = vi.fn();
  const frozenStyle = document.createElement("style");

  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock();
    setupHtml(viewState);
    frozenStyle.textContent = `#commitTable tr { scroll-margin-top: ${FROZEN}px; }`;
    document.head.appendChild(frozenStyle);
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    Object.defineProperty(HTMLTableRowElement.prototype, "offsetTop", {
      configurable: true,
      get(this: HTMLElement) {
        return this.id === "commitDetails" ? 2000 : 0;
      }
    });
    await import("@/webview/main");
    receive({
      command: "loadBranches",
      token: 0,
      branches: ["main"],
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
  });

  afterAll(() => {
    // The stub shadows HTMLElement's own getter; deleting it un-shadows it.
    delete (HTMLTableRowElement.prototype as { offsetTop?: number }).offsetTop;
    frozenStyle.remove();
    parkViewportAt(0);
  });

  it("centres the commit and its details in the part of the viewport below the header", () => {
    parkViewportAt(0);
    document
      .querySelector<HTMLElement>('#commitTable tr.commit[data-hash="aaa111"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    receive({ command: "commitDetails", commitDetails: details });
    // The row-plus-panel block is centred 177px past the CDV's offsetTop
    // (2177). The visible rows span 63..768 of the viewport, centre 415.5,
    // so the page has to stand at 2177 - 415.5.
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(0, 2177 - (VIEWPORT_HEIGHT + FROZEN) / 2);
  });
});
