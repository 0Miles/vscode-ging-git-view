import { describe, expect, it, vi } from "vitest";

import type { BranchFactsResult } from "@ging/core/extension/branchFacts";
import { createBranchFilterStore } from "@ging/core/extension/branchFilterStore";
import type { RemoteTarget } from "@ging/core/extension/remoteCommands";
import { createSideViews } from "@ging/desktop/sideViews";
import type { GitRepoSet, GitRepoState } from "@ging/shared/types";
import type { SideViewStateMessage } from "@ging/webview/desktop/sideViews/protocol";

import { fakePorts } from "@ging/core/tests/helpers";

// The host half of a Tab's side views (#399), against fakes of what it reads
// through: the page's requests in, the state it sends out, and what it asked
// core's services to do.

const REPO = "/repos/alpha";
const DAY = 86_400;
const NOW_SEC = 1_000 * DAY;

function facts(filter: string[] = []): BranchFactsResult {
  return {
    branches: ["main", "old", "done", "remotes/origin/main"],
    head: "main",
    isRepo: true,
    defaultBranch: "main",
    dates: { old: NOW_SEC - 40 * DAY },
    filter,
    merged: { matched: new Set(["done"]), hidable: new Set(["done"]) },
    inactive: { matched: new Set(["old"]), hidable: new Set(["old"]) },
    hidable: new Set(["done", "old"])
  };
}

function setUp(state: Partial<GitRepoState> = {}) {
  const { ports } = fakePorts();
  let repos: GitRepoSet = { [REPO]: { columnWidths: null, ...state } };
  const filterStore = createBranchFilterStore();
  const sent: SideViewStateMessage[] = [];
  const told: string[] = [];
  const copied: string[] = [];
  const remoteCalls: [string, RemoteTarget | string][] = [];
  const showRemote: boolean[] = [];
  const reads = vi.fn(async (_repo: string, _opts?: { hard?: boolean }) =>
    facts(filterStore.get(REPO))
  );
  const views = createSideViews({
    repo: REPO,
    post: (message) => sent.push(message),
    branchFacts: { facts: reads },
    filterStore,
    repoSource: {
      getRepos: () => repos,
      updateRepoState: (repo, patch) => {
        const before = repos[repo];
        repos = { ...repos, [repo]: { ...before, ...patch } };
        views.repoStateWritten(before, repos[repo]);
      }
    },
    config: {
      ...ports.config,
      showRemoteBranches: () => true,
      repoSettingDefaults: () => ({
        ...ports.config.repoSettingDefaults(),
        showInactiveBranches: true,
        showMergedBranches: true
      })
    },
    l10n: { t: (key: string, ...args: unknown[]) => [key, ...args].join("|") },
    prompts: {
      showInformation: async (message: string) => {
        told.push(message);
        return undefined;
      }
    },
    clipboard: {
      writeText: async (text) => {
        copied.push(text);
      }
    },
    remoteCommands: {
      list: async () => [
        {
          name: "origin",
          fetchUrl: "https://example.com/a.git",
          pushUrl: "https://example.com/a.git"
        }
      ],
      add: async (repo) => void remoteCalls.push(["add", repo ?? ""]),
      editUrl: async (target) => void remoteCalls.push(["editUrl", target]),
      rename: async (target) => void remoteCalls.push(["rename", target]),
      remove: async (target) => void remoteCalls.push(["remove", target])
    },
    fetchRemote: async (repo, remote) => void remoteCalls.push(["fetch", `${repo} ${remote}`]),
    managePullRequestProviders: () => void remoteCalls.push(["managePullRequestProviders", ""]),
    setShowRemoteBranches: (value) => void showRemote.push(value),
    logger: { logError: (line) => told.push(`ERROR: ${line}`) },
    nowMs: () => NOW_SEC * 1000
  });
  /** The state once both reads have landed. */
  const settled = async () => {
    await vi.waitFor(() => {
      const last = sent.at(-1);
      expect(last?.branches).not.toBeNull();
      expect(last?.remotes).not.toBeNull();
    });
    return sent.at(-1)!;
  };
  return { views, sent, told, copied, remoteCalls, showRemote, reads, filterStore, settled };
}

const leafRefs = (message: SideViewStateMessage) => Object.keys(message.branches?.rows ?? {});

describe("the desktop side views' host half", () => {
  it("sends nothing until the page listens, then both views", async () => {
    const { views, sent, settled } = setUp();
    views.refresh();
    expect(sent).toEqual([]);

    views.receive({ command: "sideViewReady" });
    const state = await settled();

    expect(state).toMatchObject({
      command: "sideViewState",
      repo: REPO,
      remotes: [{ name: "origin", fetchUrl: "https://example.com/a.git" }],
      strings: { branches: "desktop.sideView.branches", groupRemote: "branchView.group.remote" }
    });
    expect(leafRefs(state).toSorted()).toEqual(["done", "main", "old", "remotes/origin/main"]);
  });

  it("words each branch as VS Code's TreeItem does", async () => {
    const { views, settled } = setUp();
    views.receive({ command: "sideViewReady" });
    const { rows } = (await settled()).branches!;

    expect(rows.main.description).toBe("branchView.current");
    expect(rows.old.description).toBe("branchView.age.month|1");
    expect(rows.done.tooltip).toBe("done\nbranchView.mergedInto|main");
    expect(rows["remotes/origin/main"]).toEqual({
      description: "",
      tooltip: "remotes/origin/main"
    });
  });

  it("stops sending while the page loads anew, until it listens again", async () => {
    const { views, sent, settled } = setUp();
    views.receive({ command: "sideViewReady" });
    await settled();
    const before = sent.length;

    views.pageLoading();
    views.refresh();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sent).toHaveLength(before);
  });

  it("re-reads past the coalescing window when the user asks", async () => {
    const { views, reads, settled } = setUp();
    views.receive({ command: "sideViewReady" });
    await settled();

    views.receive({ command: "sideViewRefresh" });

    expect(reads).toHaveBeenLastCalledWith(REPO, { hard: true });
  });

  it("flips a toggle in the repository's state, and the view with it", async () => {
    const { views, settled, showRemote, sent } = setUp();
    views.receive({ command: "sideViewReady" });
    expect((await settled()).branches!.toggles.showMergedBranches).toBe(true);

    views.receive({ command: "sideViewToggle", field: "showMergedBranches" });

    await vi.waitFor(() => {
      expect(sent.at(-1)!.branches!.toggles.showMergedBranches).toBe(false);
      expect(leafRefs(sent.at(-1)!)).not.toContain("done");
    });
    // Only the remote branches are the graph's business.
    expect(showRemote).toEqual([]);
    views.receive({ command: "sideViewToggle", field: "showRemoteBranches" });
    expect(showRemote).toEqual([false]);
  });

  it("writes its own repository's filter, and follows a filter written anywhere", async () => {
    const { views, filterStore, settled, sent } = setUp();
    views.receive({ command: "sideViewReady" });
    await settled();

    void views.receive({
      command: "sideViewSetFilter",
      repo: "/repos/other",
      branches: ["main"],
      seq: 1
    });
    expect(filterStore.get(REPO)).toEqual([]);

    void views.receive({ command: "sideViewSetFilter", repo: REPO, branches: ["old"], seq: 2 });
    expect(filterStore.get(REPO)).toEqual(["old"]);
    // Sent with the number of the ask it follows.
    await vi.waitFor(() =>
      expect(sent.at(-1)).toMatchObject({ branches: { filter: ["old"] }, filterSeq: 2 })
    );

    // An ask that moves nothing is still owed word that it was taken.
    const before = sent.length;
    void views.receive({ command: "sideViewSetFilter", repo: REPO, branches: ["old"], seq: 3 });
    expect(sent).toHaveLength(before + 1);
    expect(sent.at(-1)).toMatchObject({ filterSeq: 3 });

    // The graph's filter chip, through the dispatch's hook.
    views.showAll("/repos/other");
    expect(filterStore.get(REPO)).toEqual(["old"]);
    views.showAll(REPO);
    expect(filterStore.get(REPO)).toEqual([]);
    await vi.waitFor(() => expect(sent.at(-1)!.branches!.filter).toEqual([]));
  });

  it("says why a batch action had nothing left to act on", () => {
    const { views, told } = setUp();

    views.receive({
      command: "sideViewNoTargets",
      skipped: [{ ref: "remotes/origin/main", reason: "remote" }]
    });

    expect(told).toEqual(["branchView.batch.noTargets dialog.batch.skippedRemote|origin/main"]);
  });

  it("runs a remote's commands in core on the remote as it was listed", async () => {
    const { views, settled, remoteCalls, copied } = setUp();
    views.receive({ command: "sideViewReady" });
    await settled();
    const origin = { repo: REPO, name: "origin", fetchUrl: "https://example.com/a.git" };

    views.receive({ command: "sideViewRemote", action: "editUrl", name: "origin" });
    views.receive({ command: "sideViewRemote", action: "rename", name: "origin" });
    views.receive({ command: "sideViewRemote", action: "remove", name: "origin" });
    views.receive({ command: "sideViewRemote", action: "fetch", name: "origin" });
    views.receive({ command: "sideViewRemote", action: "copyUrl", name: "origin" });
    // Not listed: nothing to act on.
    views.receive({ command: "sideViewRemote", action: "remove", name: "upstream" });
    views.receive({ command: "sideViewAddRemote" });
    views.receive({ command: "sideViewManagePullRequestProviders" });

    expect(remoteCalls).toEqual([
      ["editUrl", origin],
      ["rename", origin],
      ["remove", origin],
      ["fetch", `${REPO} origin`],
      ["add", REPO],
      ["managePullRequestProviders", ""]
    ]);
    expect(copied).toEqual(["https://example.com/a.git"]);
  });
});
