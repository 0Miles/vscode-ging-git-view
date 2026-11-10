import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { gitClientFactory } from "@ging/core/backend/gitClient";
import type { BranchFilterChange } from "@ging/core/extension/branchFilter";
import {
  type MessageHandlerDeps,
  registerMessageHandlers
} from "@ging/core/extension/messageHandler";
import { webviewBridgeFactory } from "@ging/core/extension/webviewBridge";
import type { HostPorts } from "@ging/core/host/ports";
import type { RequestMessage, ResponseMessage } from "@ging/shared/types";

import { git, makeRepo, rmrf, toRepoPath } from "@ging/core/tests/helpers";

// The message dispatch, driven the way the webview drives it — a request in
// over the channel, the responses out of it — with every host capability a
// fake port. What a port was asked to do is the host-visible half of each
// handler's behaviour; the posted response is the webview-visible half.

const HASH = "0123456789abcdef0123456789abcdef01234567";

/** Every port, recording what it was asked in one ordered log. Answers the
 *  prompts and the clipboard can be steered per test. */
function fakePorts() {
  const calls: unknown[][] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const answers = {
    showError: undefined as string | undefined,
    saveLocation: undefined as string | undefined,
    clipboard: Promise.resolve() as Promise<void>,
    reposChanged: false,
    commitDiffOpened: true,
    /** Whether opening a file or diff fails, as VS Code's open command does
     *  for a document it cannot show. */
    openRejects: false
  };
  const opened = (call: unknown[]) => {
    calls.push(call);
    if (answers.openRejects) throw new Error("cannot open");
  };
  const ports: HostPorts = {
    config: {
      signTags: () => false,
      signCommits: () => false,
      squashMergeMessageFormat: () => "Default",
      commitOrder: () => "date",
      dateType: () => "Author Date",
      showUncommittedChanges: () => false,
      showSignatureStatus: () => false,
      useMailmap: () => false,
      inactiveBranchAlwaysShow: () => [],
      fetchAndPrune: () => true,
      fetchAndPruneTags: () => false,
      pullRequestProviders: () => []
    },
    prompts: {
      showInformation: record("showInformation"),
      showWarning: record("showWarning"),
      showError: async (...args) => {
        calls.push(["showError", ...args]);
        return answers.showError;
      },
      pickSaveLocation: async (options) => {
        calls.push(["pickSaveLocation", options]);
        return answers.saveLocation;
      },
      input: async () => undefined
    },
    opener: {
      openFile: async (...args) => opened(["openFile", ...args]),
      openFileAtRevision: async (...args) => opened(["openFileAtRevision", ...args]),
      diffWithWorking: async (...args) => opened(["diffWithWorking", ...args]),
      openCommitDiff: async (...args) => {
        calls.push(["openCommitDiff", ...args]);
        return answers.commitDiffOpened;
      },
      openMergeEditor: record("openMergeEditor"),
      openTerminal: record("openTerminal"),
      openExternalUrl: record("openExternalUrl")
    },
    clipboard: {
      writeText: (text) => {
        calls.push(["writeText", text]);
        return answers.clipboard;
      }
    },
    watcher: { start: record("watcher.start"), mute: record("mute"), unmute: record("unmute") },
    // Not the real bundles: the key and its arguments, so a test can see which
    // string was asked for without depending on its wording.
    l10n: { t: (key, ...args) => [key, ...args].join("|") },
    repoSource: {
      getRepos: () => ({ "/a": { columnWidths: null } }),
      getBootRepo: () => "/a",
      checkReposExist: async () => answers.reposChanged,
      dropRepo: record("dropRepo"),
      setRepoState: record("setRepoState")
    },
    logger: { log: record("log"), logError: record("logError"), reveal: record("reveal") }
  };
  return { ports, calls, answers };
}

function harness(depOverrides: Partial<MessageHandlerDeps> = {}) {
  const { ports, calls, answers } = fakePorts();
  let receive!: (msg: RequestMessage) => void | Promise<void>;
  const posted: ResponseMessage[] = [];
  const bridge = webviewBridgeFactory(
    {
      onDidReceiveMessage: (listener) => {
        receive = listener;
      },
      postMessage: async (msg) => {
        posted.push(msg);
        return true;
      }
    },
    ports.watcher,
    () => calls.push(["repoMutated"])
  );
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
    sequenceEditor: { stage: () => {}, wasApplied: () => true, discard: () => {} },
    resolveShowRemote: () => false,
    resolveRepoScope: () => ({}) as never,
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
    send: async (msg: RequestMessage) => {
      await receive(msg);
    }
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

function revParse(cwd: string, rev: string): string {
  return cp.execFileSync("git", ["rev-parse", rev], { cwd }).toString().trim();
}
