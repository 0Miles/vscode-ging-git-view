import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@ging/shared/backend/types";
import type * as GG from "@ging/shared/types";

import { createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// Messages the host delegates to the graph — side-view ref actions, the cleanup
// dialog, the blame hover's locate — wait here until the graph shows their repo
// with nothing loading. Until #325 they waited in one slot, so a second request
// made while the panel loaded quietly replaced the first. They now queue: a
// loading panel does what a loaded one would have, in the order asked. A request
// for another repo takes the graph there, so the ones before it are dropped
// rather than left to run whenever the user next opens their repo.
//
// One webview is booted for the file and the scenarios run in order against it.

const REPO_A = "/workspace/repo-a";
const REPO_B = "/workspace/repo-b";

const viewState = makeViewState({
  combineLocalAndRemoteBranchLabels: false,
  lastActiveRepo: REPO_A,
  repos: { [REPO_A]: { columnWidths: null }, [REPO_B]: { columnWidths: null } }
});

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

const commits = [
  commit("aaa111", "bbb222", [{ hash: "aaa111", name: "main", type: "head" }]),
  commit("bbb222", null, [{ hash: "bbb222", name: "feature", type: "head" }])
];

/** The branches, remotes and commits a (re)load of either repo brings. */
function load() {
  receive({
    command: "loadBranches",
    token: 0,
    branches: ["main", "feature"],
    head: "main",
    hard: true,
    isRepo: true,
    filter: []
  });
  receive({ command: "loadRemotes", remotes: ["origin"], pushDefault: null });
  receive({
    command: "loadCommits",
    token: 0,
    commits,
    head: "aaa111",
    moreCommitsAvailable: false,
    hard: true
  });
}

const merge = (repo: string, seq: number): GG.ResponseMessage => ({
  command: "runRefAction",
  repo,
  ref: "feature",
  action: "merge",
  seq
});
const locate = (repo: string, seq: number): GG.ResponseMessage => ({
  command: "locateCommit",
  repo,
  hash: "bbb222",
  seq
});

const dialogShown = () => document.getElementById("dialog")!.classList.contains("active");
const focusedHash = () => (document.activeElement as HTMLElement | null)?.dataset?.hash;

function dismissDialog() {
  document.getElementById("dialogDismiss")?.dispatchEvent(new MouseEvent("click"));
}

/** Put focus back on nothing in particular, so a later locate is observable. */
function blur() {
  (document.activeElement as HTMLElement | null)?.blur();
}

describe("messages delegated to a graph that is still loading", () => {
  let mock: ReturnType<typeof createVscodeMock>;

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    Element.prototype.scrollIntoView = () => {};
    await import("@ging/webview/main");
  });

  it("runs every message for its repo once the load lands, in the order asked", () => {
    receive(merge(REPO_A, 1));
    receive(locate(REPO_A, 2));
    expect(dialogShown()).toBe(false);

    load();

    // Both ran, merge first: its dialog is up, and the locate then selected
    // the commit — just as the two clicks would have on a loaded panel.
    expect(dialogShown()).toBe(true);
    expect(document.getElementById("dialogInput2")).not.toBeNull();
    expect(focusedHash()).toBe("bbb222");
    // Each reported as run, so the host stops holding it for a reload.
    expect(mock.sentOf("delegatedRan")).toEqual([
      { command: "delegatedRan", seq: 1 },
      { command: "delegatedRan", seq: 2 }
    ]);
    dismissDialog();
  });

  it("ignores both messages delivered again over the host's other path", () => {
    blur();
    receive(merge(REPO_A, 1));
    receive(locate(REPO_A, 2));
    expect(dialogShown()).toBe(false);
    expect(focusedHash()).toBeUndefined();
  });

  it("drops a message once a later one takes the graph to another repo", () => {
    receive({ command: "setRepo", repo: REPO_B });
    // Held: the graph is on its way to B, not showing A.
    receive(merge(REPO_A, 3));
    receive(locate(REPO_B, 4));
    load();
    expect(dialogShown()).toBe(false);
    expect(focusedHash()).toBe("bbb222");

    // Back on A, the merge asked for before the graph left is not sprung on
    // the user …
    blur();
    receive({ command: "setRepo", repo: REPO_A });
    load();
    expect(dialogShown()).toBe(false);
    // … nor revived by its late second delivery.
    receive(merge(REPO_A, 3));
    expect(dialogShown()).toBe(false);
  });

  it("still runs a message that arrives after the load, at once", () => {
    receive(merge(REPO_A, 5));
    expect(dialogShown()).toBe(true);
    dismissDialog();
  });
});
