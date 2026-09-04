import * as assert from "node:assert";
import * as cp from "node:child_process";
import * as path from "node:path";

import * as vscode from "vscode";

import { gitClientFactory } from "@/backend/gitClient";
import { config } from "@/config";
import { createBranchCleanup } from "@/extension/branchCleanupService";
import { createBranchFacts, createGitSnapshotReader } from "@/extension/branchFacts";
import { registerMessageHandlers } from "@/extension/messageHandler";
import type { WebviewBridge } from "@/extension/webviewBridge";
import type { RequestMessage, ResponseMessage } from "@/types";

// End-to-end exercise of the extension-side branch flow against the real repo
// (the test workspace is this repo). Drives the real registerMessageHandlers
// with a real git client + real config through a fake bridge, mimicking the
// webview's selectRepo -> loadBranches handshake. Expectations are derived
// from git itself: CI checkouts only have the branch being built, never main.
const noop = () => {};

const resolveShowRemote = () => true;

/** Dependency slices a test may want to *observe* rather than ignore. Both are
 *  inert stubs in the base wiring below. */
type DepOverrides = {
  repoManager?: unknown;
  extensionState?: unknown;
};

/** The real handler dependencies, wired the way extension.ts wires them: a real
 *  git client, real config, and a real BranchFacts over both — so the flow this
 *  suite exercises is the production one, not a stub of it. */
function makeDeps(overrides: DepOverrides = {}) {
  // Inject an askpass-style env like the real extension. simple-git
  // (>=3.36) rejects GIT_ASKPASS in an explicitly-passed env unless we opt in
  // and merge it correctly — a regression that silently emptied every repo.
  const gitEnv = { GIT_ASKPASS: "/some/askpass.sh", ELECTRON_RUN_AS_NODE: "1" };
  const gitClient = gitClientFactory("", config.gitPath(), undefined, gitEnv);
  const gitClientFor = (repo: string) =>
    gitClientFactory(repo, config.gitPath(), undefined, gitEnv).getInstance();
  const branchFacts = createBranchFacts({
    readSnapshot: createGitSnapshotReader({ gitClientFor, gitPath: config.gitPath }),
    filterStore: { has: () => false, get: () => [], set: () => false },
    resolveShowRemote,
    resolveExemptPatterns: config.inactiveBranchAlwaysShow,
    resolveInactiveThresholdDays: config.inactiveBranchThresholdDays,
    resolveShowSpecificBranches: config.showSpecificBranches,
    resolveShowCurrentBranchByDefault: config.showCurrentBranchByDefault,
    nowMs: () => Date.now()
  });
  return {
    config,
    gitClient,
    repoManager: (overrides.repoManager ?? { getRepos: () => ({}), setRepoState: noop }) as never,
    extensionState: (overrides.extensionState ?? {
      setLastActiveRepo: noop,
      getLastActiveRepo: () => null
    }) as never,
    avatarManager: { fetchAvatarImage: noop } as never,
    repoFileWatcher: { start: noop, mute: noop, unmute: noop } as never,
    branchFilterStore: {
      has: () => false,
      get: () => [],
      set: () => false,
      onDidChangeFilter: () => ({ dispose: noop }),
      dispose: noop
    } as never,
    branchFacts,
    branchCleanup: createBranchCleanup({
      branchFacts,
      gitClientFor,
      resolveShowRemote,
      resolveExemptPatterns: config.inactiveBranchAlwaysShow,
      dateType: config.dateType
    }),
    resolveShowRemote,
    logger: { log: noop, logCmd: noop, logError: noop, logWebviewError: noop, reveal: noop },
    // No interactive rebase runs in this flow; a stager that reports its todo
    // as applied keeps the handler registration honest without touching disk.
    sequenceEditor: { stage: noop, wasApplied: () => true, discard: noop },
    onSelectRepo: noop
  };
}

suite("branch loading flow (integration)", () => {
  test("selectRepo then loadBranches posts the repo's branches", async () => {
    const repoPath = vscode.workspace.workspaceFolders![0]!.uri.fsPath;

    const handlers = new Map<string, (m: RequestMessage) => void | Promise<void>>();
    const posted: ResponseMessage[] = [];
    const bridge = {
      post: (m: ResponseMessage) => posted.push(m),
      onMessage: (cmd: string, h: (m: RequestMessage) => void | Promise<void>) =>
        handlers.set(cmd, h)
    } as unknown as WebviewBridge;

    // Inject an askpass-style env like the real extension. simple-git
    // (>=3.36) rejects GIT_ASKPASS in an explicitly-passed env unless we opt in
    // and merge it correctly — a regression that silently emptied every repo.
    registerMessageHandlers(bridge, makeDeps());

    // Mimic the webview's startup handshake.
    await handlers.get("selectRepo")!({ command: "selectRepo", repo: repoPath } as RequestMessage);
    await handlers.get("loadBranches")!({
      command: "loadBranches",
      hard: true,
      token: 0
    } as RequestMessage);

    const res = posted.find((m) => m.command === "loadBranches") as
      | Extract<ResponseMessage, { command: "loadBranches" }>
      | undefined;
    assert.ok(res, "a loadBranches response should be posted");
    assert.strictEqual(res!.isRepo, true, "the workspace should be recognised as a repo");
    assert.ok(
      Array.isArray(res!.branches) && res!.branches.length > 0,
      `expected branches, got ${JSON.stringify(res!.branches)}`
    );
    // for-each-ref rather than `git branch`: the latter adds a synthetic
    // "(HEAD detached at ...)" entry on CI's detached PR checkouts.
    const localBranches = cp
      .execFileSync("git", ["for-each-ref", "refs/heads", "--format=%(refname:short)"], {
        cwd: repoPath
      })
      .toString()
      .split("\n")
      .filter((b) => b !== "");
    for (const branch of localBranches) {
      assert.ok(res!.branches.includes(branch), `should include the local branch ${branch}`);
    }
  });

  test("selectRepo then commitDetails posts non-null details for HEAD", async () => {
    const repoPath = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    const head = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath }).toString().trim();

    const handlers = new Map<string, (m: RequestMessage) => void | Promise<void>>();
    const posted: ResponseMessage[] = [];
    const bridge = {
      post: (m: ResponseMessage) => posted.push(m),
      onMessage: (cmd: string, h: (m: RequestMessage) => void | Promise<void>) =>
        handlers.set(cmd, h)
    } as unknown as WebviewBridge;

    registerMessageHandlers(bridge, makeDeps());

    await handlers.get("selectRepo")!({ command: "selectRepo", repo: repoPath } as RequestMessage);
    await handlers.get("commitDetails")!({
      command: "commitDetails",
      repo: repoPath,
      commitHash: head,
      isStash: false
    } as RequestMessage);

    const res = posted.find((m) => m.command === "commitDetails") as
      | Extract<ResponseMessage, { command: "commitDetails" }>
      | undefined;
    assert.ok(res, "a commitDetails response should be posted");
    assert.ok(res!.commitDetails !== null, "commitDetails should be non-null for a real commit");
    assert.strictEqual(res!.commitDetails!.hash, head);
  });
});

/** The host's half of ADR-0024. The webview stamps a navigation token on every
 *  load request and drops any answer that comes back carrying a different one;
 *  the host's whole contribution is to copy it back untouched. Nothing else can
 *  test that: the webview suites fabricate the echo from the request they saw
 *  the webview send, so an echo the host never wrote still reads as correct
 *  there. Get it wrong in production and *every* answer is dropped — an empty
 *  graph and a Refresh button that spins forever, which is a worse #84 than the
 *  one the token exists to fix.
 *
 *  Non-zero tokens throughout, and different ones per case: a hard-coded `0`,
 *  or one handler's token reaching the other, would pass against zeros. */
suite("navigation token echo (integration)", () => {
  function makeBridge() {
    const handlers = new Map<string, (m: RequestMessage) => void | Promise<void>>();
    const posted: ResponseMessage[] = [];
    const bridge = {
      post: (m: ResponseMessage) => posted.push(m),
      onMessage: (cmd: string, h: (m: RequestMessage) => void | Promise<void>) =>
        handlers.set(cmd, h)
    } as unknown as WebviewBridge;
    return { handlers, posted, bridge };
  }

  test("loadBranches echoes the request's token verbatim", async () => {
    const repoPath = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    const { handlers, posted, bridge } = makeBridge();
    registerMessageHandlers(bridge, makeDeps());

    await handlers.get("selectRepo")!({ command: "selectRepo", repo: repoPath } as RequestMessage);
    await handlers.get("loadBranches")!({
      command: "loadBranches",
      hard: true,
      token: 7
    } as RequestMessage);

    const res = posted.find((m) => m.command === "loadBranches") as
      | Extract<ResponseMessage, { command: "loadBranches" }>
      | undefined;
    assert.ok(res, "a loadBranches response should be posted");
    assert.strictEqual(res!.token, 7, "the token must come back as it was sent");
  });

  test("loadCommits echoes the request's token verbatim", async () => {
    const repoPath = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    const { handlers, posted, bridge } = makeBridge();
    registerMessageHandlers(bridge, makeDeps());

    await handlers.get("selectRepo")!({ command: "selectRepo", repo: repoPath } as RequestMessage);
    await handlers.get("loadCommits")!({
      command: "loadCommits",
      repo: repoPath,
      branchNames: ["HEAD"],
      maxCommits: 1,
      hard: false,
      token: 12
    } as RequestMessage);

    const res = posted.find((m) => m.command === "loadCommits") as
      | Extract<ResponseMessage, { command: "loadCommits" }>
      | undefined;
    assert.ok(res, "a loadCommits response should be posted");
    assert.strictEqual(res!.token, 12, "the token must come back as it was sent");
  });
});

/** `selectRepo` is where the host commits to a repository, and it is the one
 *  step in the handshake that can fail: simple-git validates `baseDir` at
 *  construction, so a repo deleted since it was last seen throws. Both cases
 *  below are about the same invariant — the host and the webview must not be
 *  left holding different answers to "which repository is this panel on",
 *  because the load responses carry a navigation token and no repo, so nothing
 *  downstream can notice the disagreement. */
suite("selectRepo failures (integration)", () => {
  function makeBridge() {
    const handlers = new Map<string, (m: RequestMessage) => void | Promise<void>>();
    const posted: ResponseMessage[] = [];
    const bridge = {
      post: (m: ResponseMessage) => posted.push(m),
      onMessage: (cmd: string, h: (m: RequestMessage) => void | Promise<void>) =>
        handlers.set(cmd, h)
    } as unknown as WebviewBridge;
    return { handlers, posted, bridge };
  }

  test("a repository that is gone is dropped, not half-selected", async () => {
    const repoPath = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    const gone = path.join(repoPath, `no-such-repo-${process.pid}`);
    const removed: string[] = [];
    let broadcasts = 0;
    const persisted: (string | null)[] = [];

    const { handlers, posted, bridge } = makeBridge();
    registerMessageHandlers(
      bridge,
      makeDeps({
        repoManager: {
          getRepos: () => ({}),
          setRepoState: noop,
          removeRepo: (r: string) => removed.push(r),
          sendRepos: () => broadcasts++
        },
        extensionState: {
          setLastActiveRepo: (r: string | null) => persisted.push(r),
          getLastActiveRepo: () => null
        }
      })
    );

    await handlers.get("selectRepo")!({ command: "selectRepo", repo: repoPath } as RequestMessage);
    // Must not reject: the bridge has no catch, so a rejection here is an
    // unhandled one and the webview is told nothing at all.
    await handlers.get("selectRepo")!({ command: "selectRepo", repo: gone } as RequestMessage);

    assert.deepStrictEqual(removed, [gone], "the repo that is gone should be dropped from the set");
    assert.strictEqual(broadcasts, 1, "the panel should be re-seeded so it can move off it");
    assert.deepStrictEqual(persisted, [repoPath], "the dead repo must not become the stored one");

    // And the host is still on the repo it had — answering for it, rather than
    // aiming every later read at the one that is gone.
    await handlers.get("loadBranches")!({
      command: "loadBranches",
      hard: true,
      token: 3
    } as RequestMessage);
    const res = posted.find((m) => m.command === "loadBranches") as
      | Extract<ResponseMessage, { command: "loadBranches" }>
      | undefined;
    assert.ok(res, "a loadBranches response should be posted");
    assert.strictEqual(res!.isRepo, true, "the previous repo should still answer");
  });

  test("an empty path is refused rather than bound to the host's cwd", async () => {
    // simple-git reads an empty `baseDir` as absent and falls back to
    // `process.cwd()` — no throw, so nothing downstream would notice. It reads
    // as a repository whenever VS Code was started from one, which is how an
    // unrelated repository's history ends up drawn under an empty title.
    const repoPath = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    const persisted: (string | null)[] = [];
    const removed: string[] = [];

    const { handlers, bridge } = makeBridge();
    registerMessageHandlers(
      bridge,
      makeDeps({
        repoManager: {
          getRepos: () => ({}),
          setRepoState: noop,
          removeRepo: (r: string) => removed.push(r),
          sendRepos: noop
        },
        extensionState: {
          setLastActiveRepo: (r: string | null) => persisted.push(r),
          getLastActiveRepo: () => null
        }
      })
    );

    await handlers.get("selectRepo")!({ command: "selectRepo", repo: repoPath } as RequestMessage);
    await handlers.get("selectRepo")!({ command: "selectRepo", repo: "" } as RequestMessage);

    assert.deepStrictEqual(persisted, [repoPath], "an empty path must not be stored");
    assert.deepStrictEqual(removed, [], "an empty path is not a repo to drop, just one to refuse");
  });
});
