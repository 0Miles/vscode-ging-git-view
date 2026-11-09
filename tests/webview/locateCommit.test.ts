import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import type * as GG from "@/types";

import {
  clickId,
  commitDetails,
  createVscodeMock,
  DEFAULT_REPO,
  dialogShown,
  dialogText,
  makeViewState,
  openDetailsOn,
  receive,
  setupHtml
} from "./setup";

// The blame hover's "locate in the graph" (#310): the host opens the graph on
// the blamed file's repository and sends `locateCommit`; the graph selects the
// commit's row and brings it into view, loading as far as it has to — sized by
// the commit's `git log` position, as Find sizes a load for a match past the
// window — and says so quietly when the graph's history leaves it out.
//
// One webview is booted for the file and the scenarios run in order against it,
// the way a session unfolds (see findLoadPlanBoundAtConsent for why not one
// per scenario).

const REPO = DEFAULT_REPO;

function commit(hash: string, parent: string | null, refs: GitCommitNode["refs"] = []) {
  return {
    hash,
    parentHashes: parent === null ? [] : [parent],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: `Commit ${hash}`,
    refs
  } satisfies GitCommitNode;
}

const tip = commit("aaa111", "bbb222", [{ hash: "aaa111", name: "main", type: "head" }]);
const base = commit("bbb222", null);

const branchesResponse: GG.ResponseMessage = {
  command: "loadBranches",
  token: 0,
  branches: ["main"],
  head: "main",
  hard: true,
  isRepo: true,
  filter: []
};

function commitsResponse(commits: GitCommitNode[]): GG.ResponseMessage {
  return {
    command: "loadCommits",
    token: 0,
    commits,
    head: "aaa111",
    moreCommitsAvailable: true,
    hard: true
  };
}

let seq = 0;
const locate = (hash: string, repo = REPO): GG.ResponseMessage => ({
  command: "locateCommit",
  repo,
  hash,
  seq: ++seq
});

let mock: ReturnType<typeof createVscodeMock>;

/** Which rows were centred, by commit hash. jsdom has no scrolling; the stub
 *  records the receiver, as every redraw replaces the row objects. */
const centred: (string | undefined)[] = [];
/** Every row scroll, with how it was asked for. */
const scrolls: { hash: string | undefined; block: ScrollLogicalPosition | undefined }[] = [];
const scrollIntoView = vi.fn(function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
  const hash = (this as HTMLElement).dataset.hash;
  const block = typeof arg === "object" ? arg.block : undefined;
  scrolls.push({ hash, block });
  if (block === "center") centred.push(hash);
});

const focusedHash = () => (document.activeElement as HTMLElement | null)?.dataset?.hash;
const busy = () => document.getElementById("refreshBtn")!.classList.contains("refreshing");

function lastDepthRequest() {
  const requests = mock.sentOf("commitLogDepth");
  expect(requests.length, "a commit log depth request").toBeGreaterThan(0);
  return requests[requests.length - 1];
}

function answerDepth(logDepth: number | null, status: string | null = null) {
  const request = lastDepthRequest();
  receive({
    command: "commitLogDepth",
    hash: request.hash,
    logDepth,
    token: request.token,
    status
  });
}

describe("locating a blamed commit in the graph", () => {
  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(makeViewState());
    Element.prototype.scrollIntoView = scrollIntoView;
    await import("@/webview/main");
  });

  it("holds a locate that arrives before the graph has loaded, then selects the commit", () => {
    receive(locate("bbb222"));
    expect(focusedHash()).toBeUndefined();
    expect(mock.sentOf("commitLogDepth")).toHaveLength(0);

    receive(branchesResponse);
    receive(commitsResponse([tip, base]));

    expect(focusedHash()).toBe("bbb222");
    expect(centred.at(-1)).toBe("bbb222");
    // Drawn already, so nothing to measure or load.
    expect(mock.sentOf("commitLogDepth")).toHaveLength(0);
    // Selection and scroll only: the Commit Details View stays shut.
    expect(document.getElementById("commitDetails")).toBeNull();
  });

  it("ignores the same locate delivered a second time", () => {
    centred.splice(0);
    (document.activeElement as HTMLElement | null)?.blur();
    receive({ command: "locateCommit", repo: REPO, hash: "bbb222", seq });
    expect(centred).toEqual([]);
    expect(focusedHash()).toBeUndefined();
  });

  it("loads exactly as far as the commit sits, then selects it", () => {
    mock.clearMessages();
    centred.splice(0);
    receive(locate("deep333"));
    expect(lastDepthRequest()).toMatchObject({ repo: REPO, hash: "deep333" });
    expect(mock.sentOf("loadCommits")).toHaveLength(0);

    answerDepth(899);
    const loads = mock.sentOf("loadCommits");
    expect(loads).toHaveLength(1);
    expect(loads[0].maxCommits).toBe(900);
    expect(busy()).toBe(true);

    receive(commitsResponse([tip, base, commit("deep333", null)]));
    expect(busy()).toBe(false);
    expect(focusedHash()).toBe("deep333");
    expect(centred.at(-1)).toBe("deep333");
  });

  it("says so quietly when the graph's history leaves the commit out", () => {
    mock.clearMessages();
    receive(locate("gone444"));
    answerDepth(null);
    expect(mock.sentOf("locateCommitNotInGraph")).toEqual([
      { command: "locateCommitNotInGraph", hash: "gone444" }
    ]);
    expect(mock.sentOf("loadCommits")).toHaveLength(0);
  });

  it("gives up on a locate a navigation lands on while its page loads", () => {
    mock.clearMessages();
    centred.splice(0);
    receive(locate("far555"));
    answerDepth(1999);
    expect(mock.sentOf("loadCommits")).toHaveLength(1);

    // The user picks a branch filter meanwhile: a navigation (ADR-0024).
    receive({ command: "setBranchFilter", branches: ["main"] });
    expect(mock.sentOf("loadCommits")).toHaveLength(2);
    receive(commitsResponse([tip, base, commit("far555", null)]));

    expect(centred).not.toContain("far555");
    expect(focusedHash()).not.toBe("far555");
    expect(busy()).toBe(false);
    expect(mock.sentOf("locateCommitNotInGraph")).toHaveLength(0);
  });

  it("gives up on a locate a navigation lands on while its depth is measured", () => {
    mock.clearMessages();
    centred.splice(0);
    receive(locate("far666"));
    const request = lastDepthRequest();
    receive({ command: "setBranchFilter", branches: [] });
    receive(commitsResponse([tip, base]));
    mock.clearMessages();

    receive({
      command: "commitLogDepth",
      hash: request.hash,
      logDepth: 10,
      token: request.token,
      status: null
    });
    expect(mock.sentOf("loadCommits")).toHaveLength(0);
    expect(mock.sentOf("locateCommitNotInGraph")).toHaveLength(0);
  });

  it("waits for a load already in flight rather than refusing", () => {
    mock.clearMessages();
    centred.splice(0);
    receive(locate("late777"));
    // A background refresh starts while the depth is out.
    receive({ command: "refresh" });
    answerDepth(5);
    // Nothing requested over the load in flight …
    expect(mock.sentOf("loadCommits")).toHaveLength(0);
    receive(branchesResponse);
    receive(commitsResponse([tip, base]));
    // … then the locate's own page, once it has landed.
    const loads = mock.sentOf("loadCommits");
    expect(loads.at(-1)?.maxCommits).toBeGreaterThanOrEqual(6);
    receive(commitsResponse([tip, base, commit("late777", null)]));
    expect(focusedHash()).toBe("late777");
    expect(centred.at(-1)).toBe("late777");
  });

  // The maintainer's ruling on #310: a branch filter is cleared — through Show
  // All, the graph's filter chip's own request — only when it is what keeps the
  // commit off the graph.
  describe("under a branch filter", () => {
    it("leaves a filter that shows the commit alone", () => {
      receive({ command: "setBranchFilter", branches: ["main"] });
      receive(commitsResponse([tip, base]));
      mock.clearMessages();
      centred.splice(0);

      receive(locate("aaa111"));
      expect(focusedHash()).toBe("aaa111");
      expect(mock.sentOf("clearBranchFilter")).toHaveLength(0);
    });

    it("asks whether the commit is anywhere in the history before blaming the filter", () => {
      mock.clearMessages();
      receive(locate("nowhere888"));
      expect(lastDepthRequest().branchNames).toEqual(["main"]);
      answerDepth(null);
      // Measured again across every branch, rather than clearing on a guess.
      expect(lastDepthRequest().branchNames).toEqual([""]);
      answerDepth(null);

      expect(mock.sentOf("clearBranchFilter")).toHaveLength(0);
      expect(mock.sentOf("locateCommitNotInGraph")).toEqual([
        { command: "locateCommitNotInGraph", hash: "nowhere888" }
      ]);
    });

    it("clears a filter that hides the commit through Show All, then locates it", () => {
      mock.clearMessages();
      centred.splice(0);
      receive(locate("side999"));
      answerDepth(null);
      answerDepth(4);
      expect(mock.sentOf("clearBranchFilter")).toHaveLength(1);
      // Nothing loaded under the filter that hides it.
      expect(mock.sentOf("loadCommits")).toHaveLength(0);

      // The host's Show All arrives as the empty filter, then its
      // acknowledgement — in that order, the filter being posted while Show All
      // runs — and the reload lands.
      receive({ command: "setBranchFilter", branches: [] });
      receive({ command: "branchFilterCleared" });
      receive(commitsResponse([tip, base]));
      // Measured afresh, on the history now on screen.
      answerDepth(4);
      expect(mock.sentOf("loadCommits").at(-1)?.maxCommits).toBeGreaterThanOrEqual(5);
      receive(commitsResponse([tip, base, commit("side999", null)]));
      expect(focusedHash()).toBe("side999");
      expect(centred.at(-1)).toBe("side999");
    });

    it("gives up waiting for Show All when another navigation gets there first", () => {
      receive({ command: "setBranchFilter", branches: ["main"] });
      receive(commitsResponse([tip, base]));
      mock.clearMessages();
      centred.splice(0);
      receive(locate("side999"));
      answerDepth(null);
      answerDepth(4);
      expect(mock.sentOf("clearBranchFilter")).toHaveLength(1);

      // The user picks another filter before Show All lands, then Show All does.
      receive({ command: "setBranchFilter", branches: ["main", "feature"] });
      receive({ command: "setBranchFilter", branches: [] });
      receive({ command: "branchFilterCleared" });
      receive(commitsResponse([tip, base]));
      expect(mock.sentOf("commitLogDepth")).toHaveLength(2);
      expect(centred).not.toContain("side999");
    });

    it("forgets the locate when Show All moved nothing, so a later Show All cannot revive it", () => {
      receive({ command: "setBranchFilter", branches: ["main"] });
      receive(commitsResponse([tip, base]));
      mock.clearMessages();
      centred.splice(0);
      receive(locate("side999"));
      answerDepth(null);
      answerDepth(4);
      expect(mock.sentOf("clearBranchFilter")).toHaveLength(1);

      // The host's filter was already empty: Show All posted no filter, only
      // its acknowledgement. The user asked from the editor, so they are told
      // why nothing moved.
      receive({ command: "branchFilterCleared" });
      expect(mock.sentOf("locateCommitNotInGraph")).toEqual([
        { command: "locateCommitNotInGraph", hash: "side999", reason: "filterNotCleared" }
      ]);

      // Much later, the user shows all branches themselves.
      receive({ command: "setBranchFilter", branches: [] });
      receive(commitsResponse([tip, base]));
      expect(mock.sentOf("commitLogDepth")).toHaveLength(2);
      expect(centred).not.toContain("side999");
    });
  });

  describe("when the depth cannot be measured", () => {
    it("says so", () => {
      mock.clearMessages();
      receive(locate("broken111"));
      answerDepth(null, "fatal: bad object");
      expect(dialogShown()).toBe(true);
      expect(dialogText()).toContain("Unable to locate the commit in the GING graph");
      clickId("dialogDismiss");
    });

    it("stays silent about a failure a navigation has overtaken", () => {
      receive(locate("broken222"));
      const request = lastDepthRequest();
      receive({ command: "setBranchFilter", branches: ["main"] });
      receive(commitsResponse([tip, base]));
      receive({
        command: "commitLogDepth",
        hash: request.hash,
        logDepth: null,
        token: request.token,
        status: "fatal: bad object"
      });
      expect(dialogShown()).toBe(false);
    });
  });

  // Focus is the graph's selection, and an open Commit Details View follows it
  // (ADR-0014); what the locate never does is open one that is closed.
  describe("with the Commit Details View", () => {
    it("leaves a closed view closed", () => {
      receive({ command: "setBranchFilter", branches: [] });
      receive(commitsResponse([tip, base]));
      mock.clearMessages();
      receive(locate("aaa111"));
      expect(focusedHash()).toBe("aaa111");
      expect(mock.sentOf("commitDetails")).toHaveLength(0);
    });

    it("moves an open view onto the located commit", () => {
      openDetailsOn("aaa111");
      receive({ command: "commitDetails", commitDetails: commitDetails("aaa111") });
      mock.clearMessages();

      receive(locate("bbb222"));
      expect(focusedHash()).toBe("bbb222");
      expect(mock.sentOf("commitDetails").map((m) => m.commitHash)).toEqual(["bbb222"]);
    });

    // With centring on, the view's opening centres the row, so the locate
    // must not move the page first — the two-stage motion #256 removed.
    it("leaves the one move to a view that centres its opening", () => {
      openDetailsOn("aaa111");
      receive({ command: "commitDetails", commitDetails: commitDetails("aaa111") });
      scrolls.splice(0);

      receive(locate("bbb222"));
      expect(focusedHash()).toBe("bbb222");
      expect(scrolls.filter((s) => s.hash === "bbb222")).toEqual([]);
    });

    it("centres the row itself when that view's details cannot be loaded", () => {
      openDetailsOn("aaa111");
      receive({ command: "commitDetails", commitDetails: commitDetails("aaa111") });
      receive(locate("bbb222"));
      scrolls.splice(0);
      receive({ command: "commitDetails", commitDetails: null });
      clickId("dialogDismiss");
      expect(scrolls).toContainEqual({ hash: "bbb222", block: "center" });
    });
  });
});
