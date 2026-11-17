import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { WatchPath } from "@ging/core/backend/queries/gitDirs";
import type { BranchFactsResult } from "@ging/core/extension/branchFacts";
import { createBranchFilterStore } from "@ging/core/extension/branchFilterStore";
import type { CommitDiffRequest } from "@ging/core/extension/commitDiff";
import type { RemoteTarget } from "@ging/core/extension/remoteCommands";
import { createRepoGitClients } from "@ging/core/extension/repoGitClients";
import type { ListedStashHost } from "@ging/core/extension/stashList";
import { createSideViews } from "@ging/desktop/sideViews";
import type { GitRepoSet, GitRepoState } from "@ging/shared/types";
import type {
  SideViewMessage,
  SideViewStashFilesMessage,
  SideViewStateMessage
} from "@ging/webview/desktop/sideViews/protocol";

import {
  fakePorts,
  git,
  makeRepo,
  pushTwoStashes,
  rmrf,
  toRepoPath
} from "@ging/core/tests/helpers";

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

type SimpleGit = ListedStashHost["git"];

/** A git that lists no stash, and never runs: the tests on branches and
 *  remotes have no repository on disk. */
const NO_GIT = { raw: async () => "" } as unknown as SimpleGit;

/** The desktop host's own git client on `repo`, as an instance makes one
 *  (`simple-git` is core's dependency, not the app's). */
const simpleGit = (repo: string) =>
  createRepoGitClients({ gitPath: () => "git" }).gitClientFor(repo);

/** `repo`'s git, and a way to wait for the next `git stash list` it answers. */
function stashGit(repo: string) {
  const real = simpleGit(repo);
  let listed: (() => void)[] = [];
  const client = new Proxy(real, {
    get: (target, name, receiver) => {
      if (name !== "raw") return Reflect.get(target, name, receiver);
      return async (args: string[]) => {
        const out = await target.raw(args);
        if (args[0] === "stash" && args[1] === "list") {
          const waiting = listed;
          listed = [];
          waiting.forEach((resolve) => resolve());
        }
        return out;
      };
    }
  });
  return {
    client,
    /** Settles once git has answered the next stash list read. */
    nextStashList: () => new Promise<void>((resolve) => listed.push(resolve))
  };
}

function setUp(
  state: Partial<GitRepoState> = {},
  {
    stashRepo,
    diffOpens = true
  }: {
    /** A real repository whose stashes the Stash view lists. */
    stashRepo?: string;
    /** What opening a diff answers. */
    diffOpens?: boolean;
  } = {}
) {
  const { ports, calls: asked, answers } = fakePorts();
  const stashClient = stashRepo === undefined ? null : stashGit(stashRepo);
  let repos: GitRepoSet = { [REPO]: { columnWidths: null, ...state } };
  const filterStore = createBranchFilterStore();
  const posted: SideViewMessage[] = [];
  /** The states among what was posted. */
  const sent: SideViewStateMessage[] = [];
  /** The stash files among what was posted. */
  const filesSent: SideViewStashFilesMessage[] = [];
  const diffs: CommitDiffRequest[] = [];
  const mutations: string[] = [];
  /** The stash log's watch, once hung: fire it as the file system would. */
  const watched: { target: WatchPath; onEvent: () => void }[] = [];
  const told: string[] = [];
  const copied: string[] = [];
  const remoteCalls: [string, RemoteTarget | string][] = [];
  const showRemote: boolean[] = [];
  const reads = vi.fn(async (_repo: string, _opts?: { hard?: boolean }) =>
    facts(filterStore.get(REPO))
  );
  const views = createSideViews({
    repo: stashRepo ?? REPO,
    post: (message) => {
      posted.push(message);
      if (message.command === "sideViewState") sent.push(message);
      else filesSent.push(message);
    },
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
    stash: {
      git: stashClient?.client ?? NO_GIT,
      clipboard: {
        writeText: async (text) => {
          copied.push(text);
        }
      },
      prompts: ports.prompts,
      l10n: ports.l10n,
      mutate: async (work) => {
        mutations.push("start");
        try {
          await work();
        } finally {
          mutations.push("end");
        }
      }
    },
    stashWatch: {
      git: { gitPath: () => "git" },
      debounceMs: 10,
      // Where git would say it is, without asking: no repository on disk for
      // the branch tests, and nothing to wait out for the stash ones.
      findCommonDir: async (repo) => (stashRepo === undefined ? null : path.join(repo, ".git")),
      watch: (target, onEvent) => {
        watched.push({ target, onEvent });
        return { dispose: () => {} };
      }
    },
    openCommitDiff: async (request) => {
      diffs.push(request);
      return diffOpens;
    },
    formatDate: (unixSec) => `date ${unixSec}`,
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
  return {
    views,
    sent,
    posted,
    filesSent,
    told,
    copied,
    remoteCalls,
    showRemote,
    reads,
    filterStore,
    settled,
    asked,
    answers,
    diffs,
    mutations,
    watched,
    nextStashList: () => stashClient!.nextStashList()
  };
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

// The Stash view (#400), on a real repository: what it lists and runs is
// core's stash list, as VS Code's Stash view's is.
describe("the desktop Stash view's host half", () => {
  /** A repository with two stashes, `newer` on top. */
  function twoStashes() {
    const repo = toRepoPath(makeRepo());
    onTestFinished(() => rmrf(repo));
    return { repo, ...pushTwoStashes(repo) };
  }

  const stashList = (repo: string) =>
    cp.execFileSync("git", ["stash", "list", "--format=%H"], { cwd: repo }).toString().trim();

  /** The state once its stashes are `count`. */
  async function stashesListed(sent: SideViewStateMessage[], count: number) {
    await vi.waitFor(() => expect(sent.at(-1)?.stashes).toHaveLength(count));
    return sent.at(-1)!.stashes!;
  }

  it("lists the repository's stashes newest first, worded as VS Code's TreeItem is", async () => {
    const { repo, older, newer } = twoStashes();
    const { views, sent } = setUp({}, { stashRepo: repo });

    // Settles once the reads it started have been sent.
    await views.receive({ command: "sideViewReady" });

    const stashes = await stashesListed(sent, 2);
    expect(stashes).toEqual([
      {
        id: newer,
        selector: "stash@{0}",
        message: "On main: newer",
        tooltip: expect.stringMatching(/^stash@\{0\}\nOn main: newer\ndate \d+$/)
      },
      {
        id: older,
        selector: "stash@{1}",
        message: "On main: older",
        tooltip: expect.stringMatching(/^stash@\{1\}\nOn main: older\ndate \d+$/)
      }
    ]);
    expect(sent.at(-1)!.strings).toMatchObject({
      stashes: "desktop.sideView.stashes",
      noStashes: "desktop.sideView.noStashes"
    });
  });

  it("pops a listed stash through core, asking in the page, the git inside a repository mutation", async () => {
    const { repo, newer, older } = twoStashes();
    const { views, sent, asked, answers, mutations } = setUp({}, { stashRepo: repo });
    await views.receive({ command: "sideViewReady" });
    await stashesListed(sent, 2);
    answers.choose = "dialog.stash.pop";

    await views.receive({ command: "sideViewStash", action: "pop", id: newer });

    expect(asked[0]).toEqual([
      "choose",
      "dialog.stash.popConfirm|stash@{0}",
      {
        detail: "dialog.stash.reinstateIndexDetail",
        actions: ["dialog.stash.pop", "dialog.stash.popReinstateIndex"]
      }
    ]);
    expect(mutations).toEqual(["start", "end"]);
    expect(stashList(repo)).toBe(older);
    expect(fs.readFileSync(path.join(repo, "f"), "utf8")).toBe("newer");
    // And the list is read again.
    expect(await stashesListed(sent, 1)).toMatchObject([{ id: older, selector: "stash@{0}" }]);
  });

  it("runs nothing for a stash it did not list, nor on a dismissed question", async () => {
    const { repo, newer } = twoStashes();
    const { views, sent, asked, answers, mutations } = setUp({}, { stashRepo: repo });
    await views.receive({ command: "sideViewReady" });
    await stashesListed(sent, 2);

    await views.receive({ command: "sideViewStash", action: "drop", id: "not-listed" });
    expect(asked).toEqual([]);

    answers.choose = undefined;
    await views.receive({ command: "sideViewStash", action: "drop", id: newer });
    expect(asked.map(([kind]) => kind)).toEqual(["choose"]);
    expect(mutations).toEqual([]);
    expect(stashList(repo).split("\n")).toHaveLength(2);
  });

  it("copies a stash's name, and refuses one that moved since it was listed", async () => {
    const { repo, newer, older } = twoStashes();
    const { views, sent, asked, copied } = setUp({}, { stashRepo: repo });
    await views.receive({ command: "sideViewReady" });
    await stashesListed(sent, 2);

    await views.receive({ command: "sideViewStash", action: "copyName", id: older });
    expect(copied).toEqual(["stash@{1}"]);

    // Dropped outside the app: `older` is stash@{0} now, not the stash@{1}
    // the view listed.
    git(["stash", "drop", "stash@{0}"], repo);
    await views.receive({ command: "sideViewStash", action: "copyName", id: older });

    expect(copied).toEqual(["stash@{1}"]);
    expect(asked).toEqual([["showWarning", "stashView.stashMoved"]]);
    expect(await stashesListed(sent, 1)).toMatchObject([{ id: older }]);
    expect(newer).not.toBe(older);
  });

  it("reads an expanded stash's files, and opens the diff of one it read", async () => {
    const { repo, newer } = twoStashes();
    const { views, sent, filesSent, diffs } = setUp({}, { stashRepo: repo });
    await views.receive({ command: "sideViewReady" });
    await stashesListed(sent, 2);

    await views.receive({ command: "sideViewStashFiles", id: newer });

    expect(filesSent).toEqual([
      {
        command: "sideViewStashFiles",
        repo,
        id: newer,
        files: [{ path: "f", name: "f", dir: "", badge: "M", tooltip: "f" }]
      }
    ]);

    await views.receive({ command: "sideViewStashDiff", id: newer, path: "not-there" });
    await views.receive({ command: "sideViewStashDiff", id: newer, path: "f" });
    expect(diffs).toEqual([
      expect.objectContaining({ repo, commitHash: newer, oldFilePath: "f", newFilePath: "f" })
    ]);
  });

  it("says so when a stash file's diff cannot be opened", async () => {
    const { repo, newer } = twoStashes();
    const { views, sent, asked } = setUp({}, { stashRepo: repo, diffOpens: false });
    await views.receive({ command: "sideViewReady" });
    await stashesListed(sent, 2);

    await views.receive({ command: "sideViewStashDiff", id: newer, path: "f" });

    expect(asked).toEqual([["showError", "error.unableToViewDiff"]]);
  });

  it("watches the stash log while the page listens, and re-reads the list on its change", async () => {
    const { repo } = twoStashes();
    const { views, sent, watched, nextStashList } = setUp({}, { stashRepo: repo });
    await views.receive({ command: "sideViewReady" });
    await stashesListed(sent, 2);
    // Hung once git has said where the common dir is.
    await vi.waitFor(() => expect(watched).toHaveLength(1));
    expect(watched[0].target).toEqual({
      base: expect.stringMatching(/[\\/]\.git[\\/]logs[\\/]refs$/),
      glob: "stash"
    });

    // A stash pushed outside the app: the graph's watcher does not look at
    // the stash log, this one does.
    fs.writeFileSync(path.join(repo, "f"), "third");
    git(["stash", "push", "-m", "third"], repo);
    watched[0].onEvent();

    // The view re-reads once the log has been quiet for the debounce. A read
    // the watch's hanging started may land first; the event's comes after.
    const readsUntilThree = async (): Promise<void> => {
      if (sent.at(-1)!.stashes!.length === 3) return;
      await nextStashList();
      // What the read sends, it sends before the next task.
      await new Promise((resolve) => setImmediate(resolve));
      return readsUntilThree();
    };
    await readsUntilThree();
    expect(await stashesListed(sent, 3)).toMatchObject([{ message: "On main: third" }, {}, {}]);
  });
});
