import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import type * as GG from "@/types";

import { createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

const defaultViewState = makeViewState({
  // Asserted below: merge commits (>1 parent) render with the `muted` class.
  muteMergeCommits: true
});

const twoCommits: GitCommitNode[] = [
  {
    hash: "merge789",
    parentHashes: ["abc123", "def456"],
    author: "Alice",
    email: "alice@example.com",
    date: 1700100000,
    message: "Merge feature",
    refs: [
      { hash: "merge789", name: "main", type: "head" },
      { hash: "merge789", name: "origin/main", type: "remote" }
    ]
  },
  {
    hash: "abc123",
    parentHashes: ["def456"],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Add feature",
    refs: []
  },
  {
    hash: "def456",
    parentHashes: [],
    author: "Bob",
    email: "bob@example.com",
    date: 1699000000,
    message: "Initial commit",
    refs: [{ hash: "def456", name: "v1.0", type: "tag" }]
  }
];

describe("webview rendering", () => {
  let vscodeMock: ReturnType<typeof createVscodeMock>;

  beforeAll(async () => {
    vi.resetModules();
    vscodeMock = createVscodeMock();
    setupHtml(defaultViewState);
    await import("@/webview/main");
    receive({
      command: "loadBranches",
      branches: ["main"],
      head: "main",
      hard: true,
      isRepo: true,
      filter: []
    });
    receive({
      command: "loadCommits",
      commits: twoCommits,
      head: "merge789",
      moreCommitsAvailable: true,
      hard: true
    });
    vscodeMock.clearMessages();
  });

  it("shows Load More Commits button when more commits are available", () => {
    expect(document.getElementById("loadMoreCommitsBtn")).not.toBeNull();
  });

  it("renders tag labels when showTags is enabled", () => {
    const tagRef = document.querySelector(".gitRef.tag");
    expect(tagRef).not.toBeNull();
    expect(tagRef!.textContent).toContain("v1.0");
  });

  it("requests the repository-wide branch index when Find opens", () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }));

    expect(
      vscodeMock.sentMessages.some(
        (message) => (message as { command: string }).command === "branchSearch"
      )
    ).toBe(true);

    document
      .getElementById("findInput")!
      .dispatchEvent(new KeyboardEvent("keyup", { key: "Escape" }));
  });

  it("counts an unloaded branch hit without loading commits while typing", () => {
    vscodeMock.clearMessages();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }));
    const request = vscodeMock.sentMessages.find(
      (message) => (message as { command: string }).command === "branchSearch"
    ) as { token: number };
    const input = document.getElementById("findInput") as HTMLInputElement;
    input.value = "legacy";
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "y" }));
    vscodeMock.clearMessages();

    receive({
      command: "branchSearch",
      token: request.token,
      status: null,
      branches: [{ ref: "feature/legacy", name: "feature/legacy", hash: "old123", depth: 500 }]
    });

    expect(document.getElementById("findCount")!.textContent).toBe("1 of 1");
    expect(
      vscodeMock.sentMessages.some(
        (message) => (message as { command: string }).command === "loadCommits"
      )
    ).toBe(false);

    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape" }));
  });

  it("loads through an unloaded branch head only after explicit navigation", () => {
    vscodeMock.clearMessages();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }));
    const request = vscodeMock.sentMessages.find(
      (message) => (message as { command: string }).command === "branchSearch"
    ) as { token: number };
    const input = document.getElementById("findInput") as HTMLInputElement;
    input.value = "legacy";
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "y" }));
    receive({
      command: "branchSearch",
      token: request.token,
      status: null,
      branches: [{ ref: "feature/legacy", name: "feature/legacy", hash: "old123", depth: 350 }]
    });
    vscodeMock.clearMessages();

    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter" }));

    const revalidation = vscodeMock.sentMessages.find(
      (message) => (message as { command: string }).command === "branchSearch"
    ) as { token: number };
    expect(revalidation).toBeDefined();
    expect(
      vscodeMock.sentMessages.some(
        (message) => (message as { command: string }).command === "loadCommits"
      )
    ).toBe(false);

    receive({
      command: "branchSearch",
      token: revalidation.token,
      status: null,
      branches: [
        {
          ref: "feature/legacy",
          name: "feature/legacy",
          hash: "moved123",
          depth: 350
        }
      ]
    });

    expect(
      vscodeMock.sentMessages.find(
        (message) => (message as { command: string }).command === "loadCommits"
      )
    ).toMatchObject({ maxCommits: 351 });

    receive({
      command: "loadCommits",
      commits: [
        ...twoCommits,
        {
          hash: "newlegacy",
          parentHashes: [],
          author: "New",
          email: "new@example.com",
          date: 2,
          message: "legacy cleanup",
          refs: []
        },
        {
          hash: "moved123",
          parentHashes: [],
          author: "Old",
          email: "old@example.com",
          date: 1,
          message: "legacy head",
          refs: [{ hash: "moved123", name: "feature/legacy", type: "head" }]
        }
      ],
      head: "merge789",
      moreCommitsAvailable: false,
      hard: true
    });
    expect(document.getElementById("findCount")!.textContent).toBe("2 of 2");
    expect(
      document
        .querySelector('tr.commit[data-hash="moved123"]')!
        .classList.contains("findMatchCurrent")
    ).toBe(true);
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape" }));
  });

  it("does not follow a different branch that reuses the same display ref", () => {
    vscodeMock.clearMessages();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }));
    const request = vscodeMock.sentMessages.find(
      (message) => (message as { command: string }).command === "branchSearch"
    ) as { token: number };
    const input = document.getElementById("findInput") as HTMLInputElement;
    input.value = "collision";
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "n" }));
    receive({
      command: "branchSearch",
      token: request.token,
      status: null,
      branches: [
        {
          ref: "origin/collision",
          name: "origin/collision",
          hash: "local-old",
          depth: 350
        }
      ]
    });
    vscodeMock.clearMessages();

    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter" }));
    const revalidation = vscodeMock.sentMessages.find(
      (message) => (message as { command: string }).command === "branchSearch"
    ) as { token: number };
    receive({
      command: "branchSearch",
      token: revalidation.token,
      status: null,
      branches: [
        {
          ref: "remotes/origin/collision",
          name: "origin/collision",
          hash: "remote-new",
          depth: 350
        }
      ]
    });

    expect(
      vscodeMock.sentMessages.some(
        (message) => (message as { command: string }).command === "loadCommits"
      )
    ).toBe(false);
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape" }));
  });

  it("confirms before explicit navigation loads more than 200 additional commits", () => {
    vscodeMock.clearMessages();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }));
    const request = vscodeMock.sentMessages.find(
      (message) => (message as { command: string }).command === "branchSearch"
    ) as { token: number };
    const input = document.getElementById("findInput") as HTMLInputElement;
    input.value = "ancient";
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "t" }));
    receive({
      command: "branchSearch",
      token: request.token,
      status: null,
      branches: [
        {
          ref: "feature/ancient",
          name: "feature/ancient",
          hash: "ancient123",
          depth: 600
        }
      ]
    });
    vscodeMock.clearMessages();

    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter" }));
    const revalidation = vscodeMock.sentMessages.find(
      (message) => (message as { command: string }).command === "branchSearch"
    ) as { token: number };
    receive({
      command: "branchSearch",
      token: revalidation.token,
      status: null,
      branches: [
        {
          ref: "feature/ancient",
          name: "feature/ancient",
          hash: "ancient123",
          depth: 600
        }
      ]
    });

    expect(document.getElementById("dialog")!.classList.contains("active")).toBe(true);
    expect(document.getElementById("dialog")!.textContent).toContain("250");
    expect(
      vscodeMock.sentMessages.some(
        (message) => (message as { command: string }).command === "loadCommits"
      )
    ).toBe(false);

    document.getElementById("dialogAction")!.dispatchEvent(new MouseEvent("click"));
    expect(
      vscodeMock.sentMessages.find(
        (message) => (message as { command: string }).command === "loadCommits"
      )
    ).toMatchObject({ maxCommits: 601 });

    receive({
      command: "loadCommits",
      commits: [
        ...twoCommits,
        {
          hash: "ancient123",
          parentHashes: [],
          author: "Ancient",
          email: "ancient@example.com",
          date: 1,
          message: "ancient head",
          refs: [{ hash: "ancient123", name: "feature/ancient", type: "head" }]
        }
      ],
      head: "merge789",
      moreCommitsAvailable: false,
      hard: true
    });
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape" }));
  });

  it("highlights every matching branch chip while counting the head once", () => {
    vscodeMock.clearMessages();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }));
    const request = vscodeMock.sentMessages.find(
      (message) => (message as { command: string }).command === "branchSearch"
    ) as { token: number };
    const input = document.getElementById("findInput") as HTMLInputElement;
    input.value = "main";
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "n" }));
    receive({
      command: "branchSearch",
      token: request.token,
      status: null,
      branches: [
        { ref: "main", name: "main", hash: "merge789", depth: 0 },
        {
          ref: "remotes/origin/main",
          name: "origin/main",
          hash: "merge789",
          depth: 0
        }
      ]
    });

    expect(document.getElementById("findCount")!.textContent).toBe("1 of 1");
    expect(
      Array.from(document.querySelectorAll<HTMLElement>('.commit[data-hash="merge789"] .gitRef'))
        .filter((ref) => ref.classList.contains("findBranchMatch"))
        .map((ref) => ref.dataset.name)
    ).toEqual(["main", "origin/main"]);

    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape" }));
  });

  it("reports a git failure while building the branch search index", () => {
    vscodeMock.clearMessages();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }));
    const request = vscodeMock.sentMessages.find(
      (message) => (message as { command: string }).command === "branchSearch"
    ) as { token: number };

    receive({
      command: "branchSearch",
      token: request.token,
      branches: [],
      status: "fatal: could not read refs"
    } as GG.ResponseMessage);

    expect(document.getElementById("dialog")!.textContent).toContain("Unable to search branches");
    expect(document.getElementById("dialog")!.textContent).toContain("could not read refs");
    document.getElementById("dialogDismiss")!.dispatchEvent(new MouseEvent("click"));
    document
      .getElementById("findInput")!
      .dispatchEvent(new KeyboardEvent("keyup", { key: "Escape" }));
  });

  it("refreshes the branch index even when the loaded commits are unchanged", () => {
    receive({
      command: "loadCommits",
      commits: twoCommits,
      head: "merge789",
      moreCommitsAvailable: true,
      hard: true
    });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }));
    vscodeMock.clearMessages();

    receive({
      command: "loadCommits",
      commits: twoCommits,
      head: "merge789",
      moreCommitsAvailable: true,
      hard: false
    });

    expect(
      vscodeMock.sentMessages.some(
        (message) => (message as { command: string }).command === "branchSearch"
      )
    ).toBe(true);
    document
      .getElementById("findInput")!
      .dispatchEvent(new KeyboardEvent("keyup", { key: "Escape" }));
  });

  it("restores the initial load limit when remote branch visibility changes", () => {
    vscodeMock.clearMessages();
    receive({ command: "setShowRemoteBranches", value: false });
    receive({
      command: "loadBranches",
      branches: ["main"],
      head: "main",
      hard: true,
      isRepo: true,
      filter: []
    });

    expect(
      vscodeMock.sentMessages.find((message) => message.command === "loadCommits")
    ).toMatchObject({ maxCommits: 300 });

    receive({
      command: "loadCommits",
      commits: twoCommits,
      head: "merge789",
      moreCommitsAvailable: true,
      hard: true
    });
  });

  it("highlights matching commits via the Find widget (Ctrl+F)", () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }));
    const input = document.getElementById("findInput") as HTMLInputElement;
    input.value = "Add feature";
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "e" }));

    expect(
      document.querySelector('tr.commit[data-hash="abc123"]')!.classList.contains("findMatch")
    ).toBe(true);
    expect(
      document.querySelector('tr.commit[data-hash="def456"]')!.classList.contains("findMatch")
    ).toBe(false);
    expect(document.getElementById("findCount")!.textContent).toBe("1 of 1");

    // Close it again so later tests start clean.
    document
      .getElementById("findInput")!
      .dispatchEvent(new KeyboardEvent("keyup", { key: "Escape" }));
  });

  it("blinks the HEAD commit when Ctrl+H is pressed", () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "h", ctrlKey: true }));
    const headRow = document.querySelector('tr.commit[data-hash="merge789"]');
    expect(headRow!.classList.contains("blinking")).toBe(true);
  });

  it("marks the current head branch label as active", () => {
    const activeRef = document.querySelector(".gitRef.head.active");
    expect(activeRef).not.toBeNull();
    expect(activeRef!.textContent).toContain("main");
  });

  it("mutes merge commits (>1 parent) when muteMergeCommits is enabled", () => {
    const mergeRow = document.querySelector('.commit[data-hash="merge789"]');
    expect(mergeRow).not.toBeNull();
    expect(mergeRow!.classList.contains("muted")).toBe(true);

    const normalRow = document.querySelector('.commit[data-hash="abc123"]');
    expect(normalRow!.classList.contains("muted")).toBe(false);
  });
});
