import { vi } from "vitest";

import type { GitCommitNode } from "@ging/shared/backend/types";

import {
  commitDetails,
  createVscodeMock,
  makeViewState,
  openDetailsOn,
  receive,
  setupHtml
} from "./setup";
import { startDesktop } from "./startDesktop";

/** The commit the CDV is open on. */
export const HASH = "aaa111";

const commits: GitCommitNode[] = [
  {
    hash: HASH,
    parentHashes: [],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Only commit",
    refs: [{ hash: HASH, name: "main", type: "head" }]
  }
];

/** Boot `entry` with the CDV open on a commit that renamed one file. Once per
 *  file: a page's graph keeps listening on `window`, so a second boot in the
 *  same file would answer every message twice. */
export async function bootWithCdvFile(entry: "vscode" | "desktop") {
  vi.resetModules();
  const mock = createVscodeMock();
  setupHtml(makeViewState({ autoCenterCommitDetailsView: false }));
  if (entry === "vscode") await import("@ging/webview/main");
  else {
    // The host's word on what page it served (#388): a graph.
    document.documentElement.dataset.gingPage = "graph";
    await startDesktop();
  }
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
    head: HASH,
    moreCommitsAvailable: false,
    hard: true
  });
  openDetailsOn(HASH);
  receive({
    command: "commitDetails",
    commitDetails: {
      ...commitDetails(HASH),
      fileChanges: [
        { oldFilePath: "old.txt", newFilePath: "new.txt", type: "R", additions: 1, deletions: 0 }
      ]
    }
  });
  return mock;
}

export const cdvFileRow = () => document.querySelector<HTMLElement>("#commitDetails .gitFile")!;
