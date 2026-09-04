import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import type * as GG from "@/types";

import { createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// Navigating while a load is in flight (#84). A navigation changes *which*
// commits belong on screen — the repository, whether remote branches count —
// and unlike a refresh it cannot stand down for the load already out: that load
// has never heard of where the user just went, so nothing is coming to correct
// the graph. It used to stand down anyway, and the panel then showed the
// previous repo's commits under the new repo's title, with every later attempt
// to reload refused by the same one-load-at-a-time gate. Closing the tab was
// the only way out, which is what made a slow worktree switch look like a hang.
//
// One webview is booted per scenario here rather than per suite: each is about
// what the panel does from a *settled* start, and threading them would make
// every assertion depend on which load the previous scenario left in the air.

const REPO_A = "/workspace/repo-a";
const REPO_B = "/workspace/repo-b";
const TWO_REPOS: GG.GitRepoSet = {
  [REPO_A]: { columnWidths: null },
  [REPO_B]: { columnWidths: null }
};

function commitsOf(repo: "a" | "b"): GitCommitNode[] {
  return [
    {
      hash: repo === "a" ? "aaa111" : "bbb111",
      parentHashes: [],
      author: "Author",
      email: "author@example.com",
      date: 1700000000,
      message: repo === "a" ? "commit in repo A" : "commit in repo B",
      refs: []
    }
  ];
}

const branchesResponse: GG.ResponseMessage = {
  command: "loadBranches",
  token: 0,
  branches: ["main"],
  head: "main",
  hard: true,
  isRepo: true,
  filter: []
};

function commitsResponse(
  repo: "a" | "b",
  moreCommitsAvailable = false
): Extract<GG.ResponseMessage, { command: "loadCommits" }> {
  return {
    command: "loadCommits",
    token: 0,
    commits: commitsOf(repo),
    head: repo === "a" ? "aaa111" : "bbb111",
    moreCommitsAvailable,
    hard: true
  };
}

let mock: ReturnType<typeof createVscodeMock>;

const sentOf = <T extends GG.RequestMessage["command"]>(command: T) => mock.sentOf(command);
const refreshing = () => document.getElementById("refreshBtn")!.classList.contains("refreshing");
const graphText = () => document.getElementById("commitTable")!.textContent ?? "";

/** Boot a panel on REPO_A and settle its opening load. `moreCommitsAvailable`
 *  is what puts the Load More button in the footer — only the scenario that
 *  widens the loaded commit window before navigating asks for it. */
async function bootSettled(moreCommitsAvailable = false) {
  vi.resetModules();
  mock = createVscodeMock();
  setupHtml(makeViewState({ repos: TWO_REPOS, lastActiveRepo: REPO_A }));
  await import("@/webview/main");
  receive(branchesResponse);
  receive(commitsResponse("a", moreCommitsAvailable));
}

function click(id: string) {
  const elem = document.getElementById(id);
  expect(elem, id).not.toBeNull();
  elem!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

/** Put a repo state for REPO_A on the wire, the way the host re-sends the set
 *  after writing to it. REPO_B rides along unchanged so the set never shrinks —
 *  a missing repo is the *other* navigation, and mixing the two would leave the
 *  scenario unable to say which one fired. */
function sendRepoState(state: GG.GitRepoState) {
  receive({
    command: "loadRepos",
    repos: { ...TWO_REPOS, [REPO_A]: state },
    lastActiveRepo: REPO_A
  });
}

/** Everything `ging-git-view.toggleRemoteVisibility` puts on the wire: the repo
 *  state with the remote hidden, then the plain refresh the command has always
 *  asked for. The refresh is the droppable half — before the state comparison
 *  it was the *only* half, and a load already out swallowed it in silence. */
function hideRemote(remote: string) {
  sendRepoState({ columnWidths: null, hiddenRemotes: [remote] });
  receive({ command: "refresh" });
}

/** Put a commit load in flight and hand back the request it went out as, so its
 *  answer can be delivered later — the only way to observe that it is dropped. */
function commitLoadInFlight() {
  document.getElementById("refreshBtn")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  receive(branchesResponse); // the branch half lands; the commit half goes out
  const request = sentOf("loadCommits").at(-1);
  expect(request, "a commit load to collide with").toBeDefined();
  return request!;
}

describe("a repo switch pushed by the host while a commit load is in flight", () => {
  let abandoned: ReturnType<typeof commitLoadInFlight>;

  beforeAll(async () => {
    await bootSettled();
    abandoned = commitLoadInFlight();
    mock.clearMessages();
    // The user picks another repository (or worktree) in the Source Control view.
    receive({ command: "setRepo", repo: REPO_B });
  });

  it("tells the host which repo it moved to", () => {
    expect(sentOf("selectRepo")).toContainEqual({ command: "selectRepo", repo: REPO_B });
  });

  it("asks for the new repo's branches over the load already out", () => {
    expect(sentOf("loadBranches")).toHaveLength(1);
  });

  describe("and when the new repo's branches come back", () => {
    beforeAll(() => {
      mock.clearMessages();
      receive(branchesResponse);
    });

    it("asks for the new repo's commits", () => {
      // The regression: this request used to be refused by the load still out
      // for the previous repo, and nothing ever asked again. The graph then sat
      // on the old repo's commits for the life of the panel.
      expect(sentOf("loadCommits")).toMatchObject([{ repo: REPO_B }]);
    });
  });

  describe("and when the abandoned load finally answers", () => {
    beforeAll(() => {
      // Nothing can stop a git read already running; the navigation token is
      // what stops its answer being drawn. Its commits are given a message of
      // their own: the graph still holds repo A's opening load, so an answer
      // carrying the same rows could not be told apart from one that was
      // dropped.
      receive(
        {
          ...commitsResponse("a"),
          commits: [{ ...commitsOf("a")[0], message: "stale answer from repo A" }],
          token: abandoned.token
        },
        { keepToken: true }
      );
    });

    it("does not draw the previous repo's commits under the new repo", () => {
      expect(graphText()).not.toContain("stale answer from repo A");
    });

    it("keeps the busy indicator up: the load it is waiting on is still out", () => {
      expect(refreshing()).toBe(true);
    });
  });

  describe("and when the new repo's own commits land", () => {
    beforeAll(() => {
      receive(commitsResponse("b"));
    });

    it("draws them", () => {
      expect(graphText()).toContain("commit in repo B");
    });

    it("puts the busy indicator out", () => {
      expect(refreshing()).toBe(false);
    });
  });
});

describe("a remote-branch toggle while a commit load is in flight", () => {
  beforeAll(async () => {
    await bootSettled();
    commitLoadInFlight();
    mock.clearMessages();
    // The Branches side-view owns this toggle and pushes the new value in.
    receive({ command: "setShowRemoteBranches", value: false });
  });

  it("asks for branches over the load already out", () => {
    // Same repo, so nothing here is caught by comparing repositories: the
    // toggle changes which commits belong on screen, and the load in flight
    // was built under the value the user just left.
    expect(sentOf("loadBranches")).toHaveLength(1);
  });

  it("asks for commits under the new value once those branches arrive", () => {
    mock.clearMessages();
    receive(branchesResponse);
    expect(sentOf("loadCommits")).toHaveLength(1);
  });

  it("leaves no busy claim behind when that load settles", () => {
    receive(commitsResponse("a"));
    expect(refreshing()).toBe(false);
  });
});

describe("a repo list that no longer holds the repo on screen", () => {
  beforeAll(async () => {
    await bootSettled();
    commitLoadInFlight();
    mock.clearMessages();
    // The host re-sends the repo set with the current repo gone (it was closed,
    // or `checkReposExist` found it deleted).
    receive({
      command: "loadRepos",
      repos: { [REPO_B]: { columnWidths: null } },
      lastActiveRepo: REPO_B
    });
  });

  it("moves to the surviving repo and asks it for branches", () => {
    expect(sentOf("selectRepo")).toMatchObject([{ repo: REPO_B }]);
    expect(sentOf("loadBranches")).toHaveLength(1);
  });

  it("asks that repo for commits once its branches arrive", () => {
    mock.clearMessages();
    receive(branchesResponse);
    expect(sentOf("loadCommits")).toMatchObject([{ repo: REPO_B }]);
  });
});

// The fifth navigation, and the one that arrives as a fact rather than as a
// call. `ging-git-view.toggleRemoteVisibility` writes `hiddenRemotes` into the
// repo state and asks for a plain refresh; the state becomes
// `--exclude=<remote>/*` on the `git log`, so it decides which commits belong
// on screen exactly as the other four do — but a plain refresh is droppable,
// and comparing repositories catches nothing here because the repository never
// moved. The panel recognises it by comparing the state that arrives against
// the one it has been loading under.

describe("a remote hidden while a commit load is in flight", () => {
  beforeAll(async () => {
    await bootSettled();
    commitLoadInFlight();
    mock.clearMessages();
    hideRemote("origin");
  });

  it("asks for branches over the load already out", () => {
    // Exactly one: the navigation's own load goes out, and the plain refresh
    // riding behind the state is dropped onto it rather than doubling it. The
    // branch half was never the half that stuck — it is the commit request
    // below that used to be refused, which is why this assertion held even
    // before the comparison existed.
    expect(sentOf("loadBranches")).toHaveLength(1);
  });

  it("asks for commits under the new exclusion once those branches arrive", () => {
    // The regression. This request used to be refused by the commit load still
    // out — the one built before the exclusion existed — and nothing ever asked
    // again, so the graph went on drawing the hidden remote's commits for the
    // life of the panel.
    mock.clearMessages();
    receive(branchesResponse);
    expect(sentOf("loadCommits")).toMatchObject([{ hiddenRemotes: ["origin"] }]);
  });

  it("leaves no busy claim behind when that load settles", () => {
    receive(commitsResponse("a"));
    expect(refreshing()).toBe(false);
  });
});

describe("a remote hidden after the loaded commit window was widened", () => {
  beforeAll(async () => {
    await bootSettled(true);
    click("loadMoreCommitsBtn"); // 300 -> 400
    receive(commitsResponse("a", true));
    // A load in flight again, so the reload below can only come from the
    // navigation: the plain refresh would be refused here, exactly as it is in
    // the scenario above.
    commitLoadInFlight();
    mock.clearMessages();
    hideRemote("origin");
    receive(branchesResponse);
  });

  it("keeps the window the user widened", () => {
    // Alone among the navigations, this one does not shrink it (ADR-0024).
    // Nothing here is a new repository or a longer read — an exclusion can only
    // make the `git log` cheaper — and the same path fires for changes made
    // outside this panel, where collapsing a widened graph would be a loss the
    // user cannot account for and can only undo one Load More at a time.
    expect(sentOf("loadCommits")).toMatchObject([{ maxCommits: 400 }]);
  });
});

describe("a repo set whose load-steering state has not moved", () => {
  beforeAll(async () => {
    await bootSettled();
    mock.clearMessages();
    // A rename and an empty exclusion list. `customName` is drawn in the Repo
    // dropdown and steers no `git log`; an empty `hiddenRemotes` excludes what
    // a missing one excludes, which is nothing — and the request normalises
    // them to the same thing, so neither is a change.
    sendRepoState({ columnWidths: null, customName: "Frontend", hiddenRemotes: [] });
  });

  it("does not reload the graph", () => {
    // The comparison is on the fields that steer the query, not on the set. The
    // host re-sends it for its own reasons — a repo added elsewhere in the
    // workspace, a name edited, its own echo of a change this panel made — and
    // a reload on each would put the graph through a navigation nobody asked
    // for. It is also what keeps the panel's own commit-ordering change from
    // firing twice: the menu writes the new order into this copy before the
    // host ever hears of it, so the echo that comes back is already equal.
    expect(sentOf("loadBranches")).toHaveLength(0);
    expect(sentOf("loadCommits")).toHaveLength(0);
  });
});

describe("a commit ordering changed outside this panel", () => {
  beforeAll(async () => {
    await bootSettled();
    commitLoadInFlight();
    mock.clearMessages();
    // Not the column-header menu, which refuses out loud while a load is out
    // and writes into this panel's own copy first (ADR-0024). This is the order
    // arriving already decided: a second graph panel, or the shareable config
    // file changing under a pull.
    sendRepoState({ columnWidths: null, commitOrdering: "author-date" });
  });

  it("navigates rather than standing down for the load already out", () => {
    expect(sentOf("loadBranches")).toHaveLength(1);
  });

  it("asks for commits in the new order once those branches arrive", () => {
    mock.clearMessages();
    receive(branchesResponse);
    expect(sentOf("loadCommits")).toMatchObject([{ commitOrder: "author-date" }]);
  });
});
