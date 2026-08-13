import { beforeAll, describe, expect, it, vi } from "vitest";

import { createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// The toolbar's left-hand title block: the repo's display name (custom name,
// else folder name) over the checked-out branch, kept in sync across branch
// loads and repo switches.

const REPO_A = "/workspace/repo-a";
const REPO_B = "/workspace/repo-b";

const titleText = () => document.getElementById("repoTitleName")!.textContent;
const branchText = () => document.getElementById("repoTitleBranch")!.textContent;

describe("toolbar repo title", () => {
  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock();
    setupHtml(
      makeViewState({
        repos: { [REPO_A]: { columnWidths: null }, [REPO_B]: { columnWidths: null } },
        lastActiveRepo: REPO_A
      })
    );
    await import("@/webview/main");
  });

  it("shows the repo's folder name on boot, with the branch still unknown", () => {
    expect(titleText()).toBe("repo-a");
    expect(branchText()).toBe("");
  });

  it("shows the checked-out branch once branches load", () => {
    receive({
      command: "loadBranches",
      branches: ["main"],
      head: "main",
      hard: true,
      isRepo: true,
      filter: []
    });
    expect(titleText()).toBe("repo-a");
    expect(branchText()).toBe("main");
  });

  it("updates the repo name immediately on a repo switch, then the branch on its load", () => {
    receive({ command: "setRepo", repo: REPO_B });
    expect(titleText()).toBe("repo-b");
    receive({
      command: "loadBranches",
      branches: ["develop"],
      head: "develop",
      hard: true,
      isRepo: true,
      filter: []
    });
    expect(branchText()).toBe("develop");
  });
});

describe("toolbar repo title with a custom repo name", () => {
  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock();
    setupHtml(
      makeViewState({
        repos: { [REPO_A]: { columnWidths: null, customName: "My Project" } },
        lastActiveRepo: REPO_A
      })
    );
    await import("@/webview/main");
  });

  it("prefers the custom name over the folder name", () => {
    expect(titleText()).toBe("My Project");
  });
});
