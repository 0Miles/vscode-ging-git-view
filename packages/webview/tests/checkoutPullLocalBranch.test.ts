import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@ging/shared/backend/types";

import { clickId, createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

const viewState = makeViewState({ combineLocalAndRemoteBranchLabels: false });

// A remote branch "origin/feature" that also has a local branch "feature".
const commits: GitCommitNode[] = [
  {
    hash: "abc123",
    parentHashes: [],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Add feature",
    refs: [{ hash: "abc123", name: "origin/feature", type: "remote" }]
  }
];

describe("checking out a remote branch and pulling it into the existing local branch (#290)", () => {
  let mock: ReturnType<typeof createVscodeMock>;

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    await import("@ging/webview/main");
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
      head: "abc123",
      moreCommitsAvailable: false,
      hard: true
    });
  });

  it("offers a pull option, second, that sends one checkoutAndPullBranch without a confirmation", () => {
    const ref = document.querySelector<HTMLElement>(".gitRef.remote");
    expect(ref).not.toBeNull();
    ref!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    const select = document.getElementById("dialogInput0") as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      "existing",
      "pull",
      "reset",
      "new"
    ]);

    select.value = "pull";
    mock.clearMessages();
    clickId("dialogAction");

    // Nothing is discarded, so no confirmation stands between the choice and git.
    expect(mock.sentMessages.find((m) => m.command === "checkoutBranch")).toBeUndefined();
    expect(mock.sentMessages.find((m) => m.command === "checkoutAndPullBranch")).toMatchObject({
      command: "checkoutAndPullBranch",
      branchName: "feature",
      remote: "origin",
      branchOnRemote: "feature"
    });
  });
});
