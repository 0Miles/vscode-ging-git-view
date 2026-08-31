import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

import { clickItem, createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// The single-remote push-tag confirmation reads `this.remotes[0]` only once the
// user has answered. Removing the remote in that window empties the list, and
// `[this.remotes[0]]` is then `[undefined]` — length 1, so `push`'s own
// `remotes.length === 0` guard waves it through and a tag is pushed to no
// remote at all. ADR-0019: the guard has to be re-taken at the front of the
// deferred code, because the reading it was made from is older than the change.

const L = getWebviewLocalizedStrings();
const E = "…"; // the rendered form of the ELLIPSIS entity

// No remote refs anywhere, so `tagCommitOnRemote` short-circuits to true and
// the tag goes straight to the single-remote confirmation.
const commits: GitCommitNode[] = [
  {
    hash: "aaa111",
    parentHashes: [],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Tagged commit",
    refs: [
      { hash: "aaa111", name: "main", type: "head" },
      { hash: "aaa111", name: "v1.0", type: "tag" }
    ]
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

describe("the remote a push-tag dialog resolved", () => {
  let mock: ReturnType<typeof createVscodeMock>;

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(makeViewState());
    await import("@/webview/main");
    receive(branchesResponse);
    receive({ command: "loadRemotes", remotes: ["origin"], pushDefault: null });
    receive({
      command: "loadCommits",
      commits,
      head: "aaa111",
      moreCommitsAvailable: false,
      hard: true
    });
    mock.clearMessages();
  });

  it("pushes nowhere rather than to an undefined remote once the remote is gone", () => {
    document
      .querySelector<HTMLElement>('.gitRef.tag[data-name="v1.0"]')!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    clickItem(L.pushTag + E);
    expect(document.getElementById("dialogAction")).not.toBeNull();

    // `git remote remove origin`, reaching the webview through the watcher.
    receive({ command: "loadRemotes", remotes: [], pushDefault: null });
    expect(document.getElementById("dialogAction"), "the dialog was dismissed").not.toBeNull();

    mock.clearMessages();
    document.getElementById("dialogAction")!.dispatchEvent(new MouseEvent("click"));

    expect(mock.sentMessages.filter((m) => m.command === "pushTag")).toEqual([]);
    // Said out loud, not swallowed. `push`'s own empty-list return is silent
    // because reaching it means the user unticked every remote; this one is a
    // refusal of something they did ask for, and the file's own rule (see
    // `confirmForRepoAndHead`) is that those are visible.
    expect(document.getElementById("dialog")!.textContent).toContain(L.dialogPushRemoteGone);
  });
});
