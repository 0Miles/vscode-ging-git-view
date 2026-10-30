import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

import { DEFAULT_REPO, createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// A Repository Setting's default changed in VS Code's settings (#211). The host
// pushes the new defaults; a repo with no override of its own for a moved
// default loads under it, so the graph reloads. A repo that overrides it is not
// affected, and neither is the graph when only a side-view default moved.
//
// One webview for the whole suite, the scenarios in order, as a session runs.

const L = getWebviewLocalizedStrings();

const viewState = makeViewState({
  // The repo overrides Show stashes and nothing else that steers the load.
  repos: { [DEFAULT_REPO]: { columnWidths: null, showStashes: true } }
});
const defaults = viewState.repoSettingDefaults;

const commits: GitCommitNode[] = [
  {
    hash: "aaa111",
    parentHashes: ["bbb222"],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Tip commit",
    refs: [{ hash: "aaa111", name: "main", type: "head" }]
  },
  {
    hash: "bbb222",
    parentHashes: [],
    author: "Bob",
    email: "bob@example.com",
    date: 1699000000,
    message: "Base commit",
    refs: []
  }
];

const branchesResponse: GG.ResponseMessage = {
  command: "loadBranches",
  token: 0,
  branches: ["main"],
  head: "main",
  hard: true,
  isRepo: true,
  filter: []
};

const commitsResponse: GG.ResponseMessage = {
  command: "loadCommits",
  token: 0,
  commits,
  head: "aaa111",
  moreCommitsAvailable: true,
  hard: true
};

let mock: ReturnType<typeof createVscodeMock>;
let pushed: GG.RepoSettingDefaults = { ...defaults };

function pushDefaults(changes: Partial<GG.RepoSettingDefaults>) {
  pushed = { ...pushed, ...changes };
  receive({ command: "setRepoSettingDefaults", defaults: pushed });
}

function reloadsSent() {
  return mock.sentOf("loadBranches").length + mock.sentOf("loadCommits").length;
}

function drawer() {
  return document.getElementById("repoSettingsDrawer")!;
}

/** The drawer's checkbox whose label begins with `label`, looked up afresh:
 *  the drawer redraws itself. */
function checkbox(label: string) {
  const input = Array.from(drawer().querySelectorAll<HTMLLabelElement>("label"))
    .find((l) => (l.textContent ?? "").trim().startsWith(label))
    ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(input, label).toBeDefined();
  return input!;
}

describe("a Repository Setting default changed in VS Code's settings", () => {
  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    await import("@/webview/main");
    receive(branchesResponse);
    receive(commitsResponse);
    // Widen the loaded commit window, so whether the reload keeps it can be told.
    document.getElementById("loadMoreCommitsBtn")!.click();
    receive(commitsResponse);
    // Open the drawer: it shows the defaults, and has to keep up with them.
    document.getElementById("repoSettingsBtn")!.click();
  });

  describe("one the repo has not overridden", () => {
    let maxCommitsBefore: number;
    beforeAll(() => {
      maxCommitsBefore = mock.getState()!.maxCommits;
      mock.clearMessages();
      pushDefaults({ onlyFollowFirstParent: !defaults.onlyFollowFirstParent });
    });

    it("reloads the graph", () => {
      expect(mock.sentOf("loadBranches")).toHaveLength(1);
      receive(branchesResponse);
      expect(mock.sentOf("loadCommits")).toHaveLength(1);
      receive(commitsResponse);
    });

    it("leaves the loaded commit window where the user put it: the change came from outside the panel", () => {
      expect(maxCommitsBefore).toBeGreaterThan(viewState.initialLoadCommits);
      expect(mock.getState()!.maxCommits).toBe(maxCommitsBefore);
    });

    it("shows the new default in the open drawer", () => {
      expect(checkbox(L.repoSettingsFirstParentOnly).checked).toBe(!defaults.onlyFollowFirstParent);
    });
  });

  describe("one the repo overrides", () => {
    beforeAll(() => {
      mock.clearMessages();
      pushDefaults({ showStashes: false });
    });

    it("leaves the graph alone", () => {
      expect(reloadsSent()).toBe(0);
    });

    it("keeps showing the repo's own value", () => {
      expect(checkbox(L.repoSettingsShowStashes).checked).toBe(true);
    });
  });

  describe("one only the Branches side-view shows", () => {
    beforeAll(() => {
      mock.clearMessages();
      pushDefaults({ showInactiveBranches: !defaults.showInactiveBranches });
    });

    it("leaves the graph alone", () => {
      expect(reloadsSent()).toBe(0);
    });

    it("shows the new default in the open drawer", () => {
      expect(checkbox(L.repoSettingsShowInactiveBranches).checked).toBe(
        !defaults.showInactiveBranches
      );
    });
  });

  describe("defaults that arrive unchanged", () => {
    it("leave the graph alone", () => {
      mock.clearMessages();
      pushDefaults({});
      expect(reloadsSent()).toBe(0);
    });
  });

  describe("while a load is still in flight", () => {
    it("abandons it and reloads, rather than being refused by it", () => {
      receive({ command: "refresh" });
      expect(mock.sentOf("loadBranches")).toHaveLength(1);
      mock.clearMessages();
      pushDefaults({ showTagOnlyCommits: !defaults.showTagOnlyCommits });
      expect(mock.sentOf("loadBranches")).toHaveLength(1);
      receive(branchesResponse);
      receive(commitsResponse);
    });
  });
});
