import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";

import { clickId, createVscodeMock, makeViewState, receive, search, setupHtml } from "./setup";

/* findOpensDockedCdv.test.ts with "Center Commit Details View" off. Then the
 * opening only brings the row out from under the panel, and centring the
 * match is still Find's to do: #256 hands the scroll to the opening only when
 * the opening will centre. One webview per file (#80): the setting is read at
 * boot. */

const viewState = makeViewState({
  commitDetailsViewLocation: "Docked to Bottom",
  autoCenterCommitDetailsView: false
});

const commits: GitCommitNode[] = ["aaa111", "bbb222", "ccc333"].map((hash, i, all) => ({
  hash,
  parentHashes: i + 1 < all.length ? [all[i + 1]] : [],
  author: "Alice",
  email: "alice@example.com",
  date: 1700000000 - i,
  message: "Commit " + hash,
  refs: i === 0 ? [{ hash, name: "main", type: "head" }] : []
}));

describe("Find opening a Commit Details View with centring off", () => {
  /** Which rows were centred, by hash. */
  const centred: (string | undefined)[] = [];
  let mock: ReturnType<typeof createVscodeMock>;

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    Element.prototype.scrollIntoView = vi.fn(function (this: Element, arg?: ScrollIntoViewOptions) {
      if (arg?.block === "center") centred.push((this as HTMLElement).dataset.hash);
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
    clickId("findBtn");
    clickId("findOpenCdv");
    centred.length = 0;
    mock.clearMessages();
    search("Commit bbb");
  });

  it("centres the match itself, and asks for its details", () => {
    expect(centred).toEqual(["bbb222"]);
    expect(mock.sentOf("commitDetails").map((m) => m.commitHash)).toEqual(["bbb222"]);
  });
});
