import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode, GitResetMode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";

import {
  clickId,
  clickItem,
  createVscodeMock,
  DEFAULT_REPO,
  graphRow,
  makeViewState,
  receive,
  rightClick,
  setupHtml
} from "./setup";

// The Reset dialog on a commit's context menu (#207): Keep sits beside Soft,
// Mixed and Hard, and is what `dialogDefaults.resetMode: "keep"` preselects.

const L = getWebviewLocalizedStrings();
const RESET = L.reset + "…"; // the rendered form of the ELLIPSIS entity

const commits: GitCommitNode[] = [
  {
    hash: "tip",
    parentHashes: ["base"],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "tip",
    refs: [{ hash: "tip", name: "main", type: "head" }]
  },
  {
    hash: "base",
    parentHashes: [],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "base",
    refs: []
  }
];

async function boot(dialogResetMode: GitResetMode) {
  vi.resetModules();
  const mock = createVscodeMock();
  setupHtml(makeViewState({ dialogResetMode }));
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
    head: "tip",
    moreCommitsAvailable: false,
    hard: true
  });
  return mock;
}

function openResetDialog(hash: string) {
  rightClick(graphRow(hash));
  clickItem(RESET);
  const select = document.getElementById("dialogInput0") as HTMLSelectElement | null;
  expect(select).not.toBeNull();
  return select!;
}

describe("the Reset dialog", () => {
  let mock: Awaited<ReturnType<typeof boot>>;

  beforeAll(async () => {
    mock = await boot("mixed");
  });

  it("offers Keep after Hard, and sends it as the reset mode", () => {
    const select = openResetDialog("base");
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      "soft",
      "mixed",
      "hard",
      "keep"
    ]);
    expect(select.options[3].textContent).toBe(L.dialogResetKeep);

    select.value = "keep";
    mock.clearMessages();
    clickId("dialogAction");

    expect(mock.sentOf("resetToCommit")).toEqual([
      { command: "resetToCommit", repo: DEFAULT_REPO, commitHash: "base", resetMode: "keep" }
    ]);
  });
});

describe("the Reset dialog with dialogDefaults.resetMode set to keep", () => {
  beforeAll(async () => {
    await boot("keep");
  });

  it("opens with Keep selected", () => {
    expect(openResetDialog("base").value).toBe("keep");
  });
});
