import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitDetails, GitCommitNode } from "@/backend/types";

import {
  VIEWPORT_HEIGHT,
  createVscodeMock,
  graphRow,
  makeViewState,
  receive,
  setupHtml
} from "./setup";

/* Docked to the bottom, the Commit Details View is a fixed panel over the
 * bottom of the window, and rows scroll *under* it the way they scroll under
 * the frozen header at the top (#206). Page Up/Down's screenful is what is
 * left between the two (#217).
 *
 * jsdom does no layout, so both heights are declared the way main.css
 * declares them, through the rows' scroll margins — see the note atop
 * frozenHeader.test.ts. The bottom one applies only while the panel is
 * docked, as main.css's does. 254 is the 252px panel and its 2px top border.
 * One webview per file (#80): the location is read at boot. */
const FROZEN = 63;
const DOCKED = 254;
const OVERLAP = 48;

const viewState = makeViewState({ commitDetailsViewLocation: "Docked to Bottom" });

const commits: GitCommitNode[] = ["aaa111", "bbb222"].map((hash, i, all) => ({
  hash,
  parentHashes: i + 1 < all.length ? [all[i + 1]] : [],
  author: "Alice",
  email: "alice@example.com",
  date: 1700000000 - i,
  message: "Commit " + hash,
  refs: i === 0 ? [{ hash, name: "main", type: "head" }] : []
}));

const details: GitCommitDetails = {
  hash: "aaa111",
  parents: ["bbb222"],
  author: "Alice",
  email: "alice@example.com",
  committer: "Alice",
  committerEmail: "alice@example.com",
  authorDate: 1700000000,
  commitDate: 1700000000,
  body: "Body",
  fileChanges: []
};

function press(key: string) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("Page Up/Down with the Commit Details View docked to the bottom", () => {
  const frozenStyle = document.createElement("style");
  const scrollBy = vi.fn();

  /** The distance one press of `key` scrolls the page. */
  function stepOf(key: "PageUp" | "PageDown") {
    scrollBy.mockClear();
    press(key);
    expect(scrollBy).toHaveBeenCalledTimes(1);
    return scrollBy.mock.calls[0][1] as number;
  }

  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock();
    setupHtml(viewState);
    frozenStyle.textContent =
      `#commitTable tr { scroll-margin-top: ${FROZEN}px; }` +
      `body.cdvDocked #commitTable tr { scroll-margin-bottom: ${DOCKED}px; }`;
    document.head.appendChild(frozenStyle);
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    window.scrollBy = scrollBy as unknown as typeof window.scrollBy;
    Element.prototype.scrollIntoView = vi.fn();
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
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    frozenStyle.remove();
  });

  it("jumps by what is visible between the header and the panel", () => {
    graphRow("aaa111").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    receive({ command: "commitDetails", commitDetails: details });
    expect(document.getElementById("commitDetails")!.classList.contains("docked")).toBe(true);

    const screenful = VIEWPORT_HEIGHT - FROZEN - DOCKED - OVERLAP;
    expect(stepOf("PageDown")).toBe(screenful);
    expect(stepOf("PageUp")).toBe(-screenful);
  });

  it("jumps by the whole space below the header again once the panel is closed", () => {
    document.getElementById("commitDetailsClose")!.click();
    expect(document.getElementById("commitDetails")).toBeNull();
    expect(stepOf("PageDown")).toBe(VIEWPORT_HEIGHT - FROZEN - OVERLAP);
  });
});
