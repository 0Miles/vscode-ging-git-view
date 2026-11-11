import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { gitClientFactory } from "@ging/core/backend/gitClient";
import type { BranchFilterChange } from "@ging/core/extension/branchFilter";
import { createFetchService } from "@ging/core/extension/fetchService";
import {
  type MessageHandlerDeps,
  registerMessageHandlers
} from "@ging/core/extension/messageHandler";
import { webviewBridgeFactory } from "@ging/core/extension/webviewBridge";
import type { RequestMessage } from "@ging/shared/types";

import {
  fakePorts,
  fakeWebview,
  git,
  makeRepo,
  pushTwoStashes,
  rev,
  rmrf,
  toRepoPath
} from "@ging/core/tests/helpers";

// The message dispatch, driven the way the webview drives it — a request in
// over the channel, the responses out of it — with every host capability a
// fake port. What a port was asked to do is the host-visible half of each
// handler's behaviour; the posted response is the webview-visible half.

const HASH = "0123456789abcdef0123456789abcdef01234567";

function harness(depOverrides: Partial<MessageHandlerDeps> = {}) {
  const { ports, calls, answers } = fakePorts();
  const { webview, posted, receive } = fakeWebview();
  const bridge = webviewBridgeFactory(webview, ports.watcher, () => calls.push(["repoMutated"]));
  const filterListeners: ((change: BranchFilterChange) => void)[] = [];
  const deps: MessageHandlerDeps = {
    gitClient: gitClientFactory("", "git"),
    extensionState: {
      setLastActiveRepo: (repo) => calls.push(["setLastActiveRepo", repo]),
      saveDialogMemory: (key, values) => calls.push(["saveDialogMemory", key, values])
    },
    avatarManager: { fetchAvatarImage: (...args) => calls.push(["fetchAvatarImage", ...args]) },
    branchFilterStore: {
      onDidChangeFilter: (listener) => {
        filterListeners.push(listener);
        return { dispose: () => filterListeners.splice(filterListeners.indexOf(listener), 1) };
      }
    },
    branchFacts: {} as never,
    branchCleanup: {} as never,
    // The real service, with the hook its other callers run inside recorded:
    // the dispatch has it in hand and must still never reach for it.
    fetchService: createFetchService({
      config: ports.config,
      prompts: ports.prompts,
      l10n: ports.l10n,
      gitClientFor: (dir) => gitClientFactory(dir, "git").getInstance(),
      currentRepo: () => repo,
      repoSource: ports.repoSource,
      runRepoMutation: async (dir, work) => {
        calls.push(["runRepoMutation", dir]);
        await work();
      }
    }),
    sequenceEditor: { stage: () => {}, wasApplied: () => true, discard: () => {} },
    onSelectRepo: (repo) => calls.push(["onSelectRepo", repo]),
    onDelegatedRan: (seq) => calls.push(["onDelegatedRan", seq]),
    showAllBranches: async (repo) => calls.push(["showAllBranches", repo]),
    configurePullRequestProvider: (host) => calls.push(["configurePullRequestProvider", host]),
    openScmView: () => calls.push(["openScmView"]),
    ...depOverrides
  };
  const handlers = registerMessageHandlers(bridge, ports, deps);
  return {
    calls,
    answers,
    posted,
    handlers,
    fireFilterChange: (change: BranchFilterChange) => filterListeners.forEach((l) => l(change)),
    send: receive
  };
}

let repo: string;
beforeEach(() => {
  repo = toRepoPath(makeRepo());
});
afterEach(() => rmrf(repo));

describe("selectRepo", () => {
  it("binds the repo, persists it, watches it, then tells the host — in that order", async () => {
    const h = harness();
    await h.send({ command: "selectRepo", repo });
    expect(h.calls).toEqual([
      ["setLastActiveRepo", repo],
      ["watcher.start", repo],
      ["onSelectRepo", repo]
    ]);
  });

  it("does nothing for the repo it is already on", async () => {
    const h = harness();
    await h.send({ command: "selectRepo", repo });
    h.calls.length = 0;
    await h.send({ command: "selectRepo", repo });
    expect(h.calls).toEqual([]);
  });

  it("refuses an empty path", async () => {
    const h = harness();
    await h.send({ command: "selectRepo", repo: "" });
    expect(h.calls).toEqual([]);
  });

  it("drops a repo that is gone, says so, and re-seeds the panel", async () => {
    const h = harness();
    const gone = `${repo}/no-such-repo`;
    await h.send({ command: "selectRepo", repo: gone });
    expect(h.calls).toEqual([
      ["log", `Cannot open a repository that is gone, dropping it: ${gone}`],
      ["dropRepo", gone]
    ]);
  });
});

describe("loadRepos", () => {
  it("answers with the known repos and the boot repo", async () => {
    const h = harness();
    await h.send({ command: "loadRepos", check: false });
    expect(h.posted).toEqual([
      { command: "loadRepos", repos: { "/a": { columnWidths: null } }, lastActiveRepo: "/a" }
    ]);
  });

  it("leaves the answer to the broadcast when a check dropped repos", async () => {
    const h = harness();
    h.answers.reposChanged = true;
    await h.send({ command: "loadRepos", check: true });
    expect(h.posted).toEqual([]);
  });
});

describe("branch filter", () => {
  it("forwards a filter change for the repo the panel shows, and only that one", async () => {
    const h = harness();
    await h.send({ command: "selectRepo", repo });
    h.fireFilterChange({ repo: "/elsewhere", branches: ["x"] });
    h.fireFilterChange({ repo, branches: ["main"] });
    expect(h.posted).toEqual([{ command: "setBranchFilter", branches: ["main"] }]);
  });

  it("stops forwarding once disposed", async () => {
    const h = harness();
    await h.send({ command: "selectRepo", repo });
    h.handlers.dispose();
    h.fireFilterChange({ repo, branches: ["main"] });
    expect(h.posted).toEqual([]);
  });

  it("forgets the repo when the panel is shown again", async () => {
    const h = harness();
    await h.send({ command: "selectRepo", repo });
    h.handlers.onPanelShown();
    h.fireFilterChange({ repo, branches: ["main"] });
    expect(h.posted).toEqual([]);
  });

  it("clears it through the host's Show All, then acknowledges", async () => {
    const h = harness();
    await h.send({ command: "clearBranchFilter", repo });
    expect(h.calls).toEqual([["showAllBranches", repo]]);
    expect(h.posted).toEqual([{ command: "branchFilterCleared" }]);
  });
});

describe("locateCommitNotInGraph", () => {
  it("warns when a filter Show All could not clear hides the commit", async () => {
    const h = harness();
    await h.send({ command: "locateCommitNotInGraph", hash: HASH, reason: "filterNotCleared" });
    expect(h.calls).toEqual([["showWarning", "blame.locate.filterNotCleared|01234567"]]);
  });

  it("informs when the history leaves it out", async () => {
    const h = harness();
    await h.send({ command: "locateCommitNotInGraph", hash: HASH });
    expect(h.calls).toEqual([["showInformation", "blame.locate.notInGraph|01234567"]]);
  });

  it("says nothing about something that is not a commit hash", async () => {
    const h = harness();
    await h.send({ command: "locateCommitNotInGraph", hash: "<b>nope</b>" });
    expect(h.calls).toEqual([]);
  });
});

describe("actions", () => {
  it("answers a failed action with git's error, inside the watcher's mute", async () => {
    const h = harness();
    await h.send({ command: "selectRepo", repo });
    h.calls.length = 0;
    await h.send({ command: "checkoutBranch", branchName: "no-such-branch" } as RequestMessage);
    expect(h.calls).toEqual([["mute"], ["unmute"], ["repoMutated"]]);
    expect(h.posted).toHaveLength(1);
    const res = h.posted[0] as { command: string; status: string | null };
    expect(res.command).toBe("checkoutBranch");
    expect(res.status).toMatch(/no-such-branch/);
  });

  it("answers a successful action with a null status", async () => {
    const h = harness();
    await h.send({ command: "selectRepo", repo });
    await h.send({
      command: "createBranch",
      commitHash: "HEAD",
      branchName: "made",
      checkout: false,
      force: false
    } as RequestMessage);
    expect(h.posted).toEqual([{ command: "createBranch", status: null }]);
  });

  it("names the selector of a stash action refused because the stack moved", async () => {
    const { older } = pushTwoStashes(repo);
    const h = harness();
    await h.send({ command: "selectRepo", repo });

    await h.send({
      command: "dropStash",
      selector: "stash@{0}",
      expectedHash: older
    } as RequestMessage);

    expect(h.posted).toEqual([
      { command: "dropStash", status: expect.any(String), movedSelector: "stash@{0}" }
    ]);
  });

  it("names no selector for a stash action that went through", async () => {
    fs.writeFileSync(path.join(repo, "f"), "changed");
    git(["stash", "push", "-m", "wip"], repo);
    const h = harness();
    await h.send({ command: "selectRepo", repo });

    await h.send({
      command: "dropStash",
      selector: "stash@{0}",
      expectedHash: rev(repo, "stash@{0}")
    } as RequestMessage);

    expect(h.posted).toEqual([{ command: "dropStash", status: null, movedSelector: null }]);
  });
});

// The graph's two fetches arrive through the bridge, whose `mutatesRepo`
// handler mutes the watcher and reports the mutation; the hook the service's
// other callers run inside would nest a second mute in the first, and the
// watcher's mute is a flag, not a count.
describe("fetch", () => {
  it("fetches inside the bridge's mute, not the service's hook", async () => {
    const h = harness();
    await h.send({ command: "selectRepo", repo });
    h.calls.length = 0;
    await h.send({ command: "fetch", repo });
    expect(h.calls).toEqual([["mute"], ["unmute"], ["repoMutated"]]);
    expect(h.posted).toEqual([{ command: "fetch", status: null }]);
  });

  it("answers a failure with git's error as the webview's status", async () => {
    git(["remote", "add", "origin", path.join(repo, "no-such-remote")], repo);
    const h = harness();
    await h.send({ command: "selectRepo", repo });
    h.calls.length = 0;
    await h.send({ command: "fetch", repo });
    expect(h.calls).toEqual([["mute"], ["unmute"], ["repoMutated"]]);
    expect(h.posted).toEqual([{ command: "fetch", status: expect.stringMatching(/\S/) }]);
  });

  it("fetches first for the cleanup dialog, inside the bridge's mute too", async () => {
    git(["remote", "add", "origin", path.join(repo, "no-such-remote")], repo);
    const payload = { candidates: [] };
    const h = harness({
      branchCleanup: {
        build: async (dir: string, opts: unknown) => {
          h.calls.push(["build", dir, opts]);
          return { payload, scannable: [] };
        }
      } as never
    });
    await h.send({ command: "selectRepo", repo });
    h.calls.length = 0;
    await h.send({ command: "branchCleanupOpen", repo, token: 7, fetch: true } as RequestMessage);
    // A failed fetch is a flag on the answer: the pre-fetch list still comes.
    expect(h.calls).toEqual([
      ["mute"],
      ["build", repo, { hard: true }],
      ["unmute"],
      ["repoMutated"]
    ]);
    expect(h.posted).toEqual([
      { command: "branchCleanupOpen", token: 7, payload, fetchFailed: true }
    ]);
  });
});

describe("createArchive", () => {
  it("asks where to save, offering the ref's name in the repo", async () => {
    const h = harness();
    await h.send({ command: "createArchive", repo, ref: "feat/x y" });
    expect(h.calls).toContainEqual([
      "pickSaveLocation",
      {
        saveLabel: "action.createArchive",
        filters: { Archives: ["zip", "tar"] },
        defaultPath: `${repo}/feat-x-y.zip`
      }
    ]);
  });

  it("counts a cancelled save as a success that writes nothing", async () => {
    const h = harness();
    await h.send({ command: "createArchive", repo, ref: "main" });
    expect(h.posted).toEqual([{ command: "createArchive", success: true }]);
  });

  it("writes the archive where the user chose", async () => {
    const h = harness();
    await h.send({ command: "selectRepo", repo });
    const out = path.join(repo, "..", `${path.basename(repo)}-out.zip`);
    h.answers.saveLocation = out;
    try {
      await h.send({ command: "createArchive", repo, ref: "main" });
      expect(h.posted).toEqual([{ command: "createArchive", success: true }]);
      expect(fs.existsSync(out)).toBe(true);
    } finally {
      fs.rmSync(out, { force: true });
    }
  });
});

describe("exportPatch", () => {
  it("asks where to save, offering the short hash in the repo", async () => {
    const h = harness();
    await h.send({ command: "exportPatch", repo, commitHash: HASH });
    expect(h.calls).toContainEqual([
      "pickSaveLocation",
      {
        saveLabel: "action.exportPatch",
        filters: { Patches: ["patch"] },
        defaultPath: `${repo}/01234567.patch`
      }
    ]);
    expect(h.posted).toEqual([{ command: "exportPatch", success: true }]);
  });
});

describe("createPullRequest", () => {
  it("opens the provider's pre-filled URL", async () => {
    git(["remote", "add", "origin", "https://github.com/owner/repo.git"], repo);
    const h = harness();
    await h.send({ command: "selectRepo", repo });
    h.calls.length = 0;
    await h.send({ command: "createPullRequest", repo, branchName: "dev", remote: "origin" });
    expect(h.calls).toEqual([
      ["openExternalUrl", "https://github.com/owner/repo/compare/dev?expand=1"]
    ]);
  });

  it("offers to configure a host with no provider, and does when asked", async () => {
    git(["remote", "add", "origin", "https://git.example.com/owner/repo.git"], repo);
    const h = harness();
    await h.send({ command: "selectRepo", repo });
    h.calls.length = 0;
    h.answers.showError = "pullRequest.configureProvider";
    await h.send({ command: "createPullRequest", repo, branchName: "dev", remote: "origin" });
    expect(h.calls).toEqual([
      [
        "showError",
        "pullRequest.noProviderForHost|git.example.com",
        "pullRequest.configureProvider"
      ],
      ["configurePullRequestProvider", "git.example.com"]
    ]);
  });

  it("offers nothing to configure for a remote with no host", async () => {
    const h = harness();
    await h.send({ command: "selectRepo", repo });
    h.calls.length = 0;
    await h.send({ command: "createPullRequest", repo, branchName: "dev", remote: "origin" });
    expect(h.calls).toEqual([["showError", "pullRequest.unsupported"]]);
  });
});

describe("opening things", () => {
  it("opens a terminal named after the repo's folder", async () => {
    const h = harness();
    await h.send({ command: "openTerminal", repo: "/work/my-repo/" });
    expect(h.calls).toEqual([["openTerminal", "/work/my-repo/", "GING: my-repo"]]);
  });

  it("opens an external URL, the merge editor and the SCM view as asked", async () => {
    const h = harness();
    await h.send({ command: "openExternalUrl", url: "https://example.com/" });
    await h.send({ command: "openMergeEditor", repo: "/r", filePath: "a/b.ts" });
    await h.send({ command: "openScmView" });
    expect(h.calls).toEqual([
      ["openExternalUrl", "https://example.com/"],
      ["openMergeEditor", "/r", "a/b.ts"],
      ["openScmView"]
    ]);
  });

  it("opens a working-tree file and reports it opened", async () => {
    const h = harness();
    await h.send({ command: "openFile", repo, filePath: "f", commitHash: HASH });
    expect(h.calls).toEqual([["openFile", `${repo}/f`]]);
    expect(h.posted).toEqual([{ command: "openFile", success: true }]);
  });

  it("follows a file renamed since the commit it was viewed from", async () => {
    git(["mv", "f", "g"], repo);
    git(["commit", "-m", "rename"], repo);
    const first = revParse(repo, "HEAD~1");
    const h = harness();
    await h.send({ command: "selectRepo", repo });
    h.calls.length = 0;
    await h.send({ command: "openFile", repo, filePath: "f", commitHash: first });
    expect(h.calls).toEqual([["openFile", `${repo}/g`]]);
  });

  it("diffs a revision against the working file, titled with the short hash", async () => {
    const h = harness();
    await h.send({ command: "viewDiffWithWorking", repo, filePath: "f", commitHash: HASH });
    expect(h.calls).toEqual([
      [
        "diffWithWorking",
        { repo, filePath: "f", commit: HASH },
        `${repo}/f`,
        "f (01234567diff.workingTreeSep)"
      ]
    ]);
    expect(h.posted).toEqual([{ command: "viewDiffWithWorking", success: true }]);
  });

  it("opens a file as of a revision", async () => {
    const h = harness();
    await h.send({ command: "viewFileAtRevision", repo, filePath: "f", commitHash: HASH });
    expect(h.calls).toEqual([["openFileAtRevision", { repo, filePath: "f", commit: HASH }]]);
    expect(h.posted).toEqual([{ command: "viewFileAtRevision", success: true }]);
  });

  it("reads a stash's untracked file from where the stash keeps it", async () => {
    const h = harness();
    await h.send({
      command: "viewFileAtRevision",
      repo,
      filePath: "u",
      commitHash: HASH,
      origin: "untracked"
    });
    await h.send({
      command: "viewDiffWithWorking",
      repo,
      filePath: "u",
      commitHash: HASH,
      origin: "untracked"
    });
    await h.send({
      command: "viewDiff",
      repo,
      commitHash: HASH,
      oldFilePath: "u",
      newFilePath: "u",
      type: "A",
      origin: "untracked"
    });
    expect(h.calls).toEqual([
      ["openFileAtRevision", { repo, filePath: "u", commit: `${HASH}^3` }],
      [
        "diffWithWorking",
        { repo, filePath: "u", commit: `${HASH}^3` },
        `${repo}/u`,
        "u (01234567diff.workingTreeSep)"
      ],
      [
        "openCommitDiff",
        {
          repo,
          commitHash: HASH,
          oldFilePath: "u",
          newFilePath: "u",
          type: "A",
          fromHash: undefined,
          origin: "untracked"
        }
      ]
    ]);
  });

  it("reports a failure when the opener could not open it", async () => {
    const h = harness();
    h.answers.openRejects = true;
    await h.send({ command: "viewFileAtRevision", repo, filePath: "f", commitHash: HASH });
    await h.send({ command: "openFile", repo, filePath: "f" });
    await h.send({ command: "viewDiffWithWorking", repo, filePath: "f", commitHash: HASH });
    expect(h.posted).toEqual([
      { command: "viewFileAtRevision", success: false },
      { command: "openFile", success: false },
      { command: "viewDiffWithWorking", success: false }
    ]);
  });

  it("answers a commit diff with whether the opener opened it", async () => {
    const h = harness();
    h.answers.commitDiffOpened = false;
    await h.send({
      command: "viewDiff",
      repo,
      commitHash: HASH,
      oldFilePath: "f",
      newFilePath: "f",
      type: "M"
    } as RequestMessage);
    expect(h.posted).toEqual([{ command: "viewDiff", success: false }]);
  });
});

describe("copyToClipboard", () => {
  it("reports success when the clipboard took it", async () => {
    const h = harness();
    await h.send({ command: "copyToClipboard", type: "hash", data: HASH });
    expect(h.calls).toEqual([["writeText", HASH]]);
    expect(h.posted).toEqual([{ command: "copyToClipboard", type: "hash", success: true }]);
  });

  it("reports failure when it did not", async () => {
    const h = harness();
    h.answers.clipboard = Promise.reject(new Error("denied"));
    await h.send({ command: "copyToClipboard", type: "hash", data: HASH });
    expect(h.posted).toEqual([{ command: "copyToClipboard", type: "hash", success: false }]);
  });
});

describe("persisted state", () => {
  it("saves repo state and dialog memory where they belong", async () => {
    const h = harness();
    await h.send({
      command: "saveRepoState",
      repo: "/a",
      state: { columnWidths: [1] }
    } as RequestMessage);
    await h.send({ command: "saveDialogMemory", dialogKey: "k", values: { x: "1" } });
    expect(h.calls).toEqual([
      ["setRepoState", "/a", { columnWidths: [1] }],
      ["saveDialogMemory", "k", { x: "1" }]
    ]);
  });
});

describe("reportError", () => {
  it("logs the failure, notifies, and reveals the log when asked", async () => {
    const h = harness();
    h.answers.showError = "error.showLog";
    await h.send({
      command: "reportError",
      report: { origin: "uncaught", command: null, message: "boom", stack: null }
    });
    // The notification's answer arrives after the handler returns.
    await vi.waitFor(() => expect(h.calls).toContainEqual(["reveal"]));
    expect(h.calls).toEqual([
      ["logError", "webview uncaught: boom"],
      ["showError", "error.webviewFailed", "error.showLog"],
      ["reveal"]
    ]);
  });
});

function revParse(cwd: string, revision: string): string {
  return cp.execFileSync("git", ["rev-parse", revision], { cwd }).toString().trim();
}
