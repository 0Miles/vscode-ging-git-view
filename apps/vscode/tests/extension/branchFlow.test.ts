import * as assert from "node:assert";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import { gitClientFactory } from "@ging/core/backend/gitClient";
import { createBranchCleanup } from "@ging/core/extension/branchCleanupService";
import { createBranchFacts, createGitSnapshotReader } from "@ging/core/extension/branchFacts";
import { createFetchService } from "@ging/core/extension/fetchService";
import {
  type MessageHandlerDeps,
  registerMessageHandlers
} from "@ging/core/extension/messageHandler";
import type { WebviewBridge } from "@ging/core/extension/webviewBridge";
import type { HostPorts, RepoSource } from "@ging/core/host/ports";
import type { RequestMessage, ResponseMessage } from "@ging/shared/types";
import { config } from "@ging/vscode/config";
import { createVscodeOpener } from "@ging/vscode/hostPorts";

import { fakePorts, git, makeRepo, rev, rmrf, SEED_TIMEOUT_MS } from "@ging/core/tests/helpers";

import { useSharedRepo } from "./helpers";

// End-to-end exercise of the extension-side branch flow against a real repo.
// Drives the real registerMessageHandlers with a real git client + real config
// through a fake bridge and fake ports, mimicking the webview's selectRepo -> loadBranches
// handshake. The repo is a small one made for these tests, not the workspace
// they run in, and one copy is shared by all of them: they only read it, so a
// fresh copy per test (`useSeededRepo`) would isolate nothing and cost a git
// spawn and a removal each. None of the assertions depend on what is in it;
// expectations are read from git, not written in.
const noop = () => {};

const resolveShowRemote = () => true;

/** Dependency slices a test may want to *observe* or steer rather than take
 *  as wired below, where both are fakes (and no repo the dispatch reads
 *  overrides a setting). What is given replaces the fake's members. */
type DepOverrides = {
  repoSource?: Partial<RepoSource>;
  extensionState?: Partial<MessageHandlerDeps["extensionState"]>;
};

/** The real handler dependencies, wired the way extension.ts wires them: a real
 *  git client, real config, and a real BranchFacts over both — so the flow this
 *  suite exercises is the production one, not a stub of it. The ports other
 *  than `config` are fakes: nothing here opens, prompts or watches anything. */
function makeDeps(overrides: DepOverrides = {}): [HostPorts, MessageHandlerDeps] {
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
  const fake = fakePorts().ports;
  const ports: HostPorts = {
    ...fake,
    config,
    repoSource: { ...fake.repoSource, ...overrides.repoSource }
  };
  const deps: MessageHandlerDeps = {
    gitClient,
    extensionState: {
      setLastActiveRepo: noop,
      saveDialogMemory: noop,
      ...overrides.extensionState
    },
    avatarManager: { fetchAvatarImage: noop },
    branchFilterStore: { onDidChangeFilter: () => ({ dispose: noop }) },
    branchFacts,
    branchCleanup: createBranchCleanup({
      branchFacts,
      gitClientFor,
      resolveShowRemote,
      resolveExemptPatterns: config.inactiveBranchAlwaysShow,
      dateType: config.dateType
    }),
    // Only the git call is reachable from the dispatch; the hook around the
    // service's other callers has nothing to do here.
    fetchService: createFetchService({
      config,
      prompts: fake.prompts,
      l10n: fake.l10n,
      gitClientFor,
      currentRepo: () => null,
      runRepoMutation: (_repo, work) => work()
    }),
    // No interactive rebase runs in this flow; a stager that reports its todo
    // as applied keeps the handler registration honest without touching disk.
    sequenceEditor: { stage: noop, wasApplied: () => true, discard: noop },
    onSelectRepo: noop,
    onDelegatedRan: noop,
    showAllBranches: async () => {},
    configurePullRequestProvider: noop,
    openScmView: noop
  };
  return [ports, deps];
}

/** A stand-in for the webview's end of the bridge: the handlers registered on
 *  it, by command, and every response posted back. */
function makeBridge() {
  const handlers = new Map<string, (m: RequestMessage) => void | Promise<void>>();
  const posted: ResponseMessage[] = [];
  const bridge = {
    post: (m: ResponseMessage) => posted.push(m),
    onMessage: (cmd: string, h: (m: RequestMessage) => void | Promise<void>) => handlers.set(cmd, h)
  } as unknown as WebviewBridge;
  return { handlers, posted, bridge };
}

suite("branchFlow (integration)", () => {
  let repoPath: string;
  useSharedRepo((repo) => {
    repoPath = repo;
  });

  /** The real handlers on a fresh bridge, with the shared repo selected the
   *  way the webview's startup handshake selects it. */
  async function selectSharedRepo(overrides?: DepOverrides) {
    const wired = makeBridge();
    registerMessageHandlers(wired.bridge, ...makeDeps(overrides));
    await wired.handlers.get("selectRepo")!({
      command: "selectRepo",
      repo: repoPath
    } as RequestMessage);
    return wired;
  }

  suite("branch loading flow (integration)", () => {
    test("selectRepo then loadBranches posts the repo's branches", async () => {
      const { handlers, posted } = await selectSharedRepo();
      await handlers.get("loadBranches")!({
        command: "loadBranches",
        hard: true,
        token: 0
      } as RequestMessage);

      const res = posted.find((m) => m.command === "loadBranches") as
        | Extract<ResponseMessage, { command: "loadBranches" }>
        | undefined;
      assert.ok(res, "a loadBranches response should be posted");
      assert.strictEqual(res!.isRepo, true, "the seeded repo should be recognised as a repo");
      assert.ok(
        Array.isArray(res!.branches) && res!.branches.length > 0,
        `expected branches, got ${JSON.stringify(res!.branches)}`
      );
      // for-each-ref rather than `git branch`: the latter adds a synthetic
      // "(HEAD detached at ...)" entry whenever HEAD is detached.
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
      const head = cp
        .execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath })
        .toString()
        .trim();

      const { handlers, posted } = await selectSharedRepo();
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
    test("loadBranches echoes the request's token verbatim", async () => {
      const { handlers, posted } = await selectSharedRepo();
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
      const { handlers, posted } = await selectSharedRepo();
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

  /** #205: the graph draws a `--first-parent` load with each commit's first
   *  parent alone, and the load answer is the only place it learns the mode —
   *  the commits keep every parent either way. The webview suites build that
   *  answer themselves, so only this can show the host writes it, and writes the
   *  repo's resolved setting rather than a constant. */
  suite("first-parent mode rides with the commits (integration)", () => {
    for (const onlyFollowFirstParent of [true, false]) {
      test(`loadCommits answers onlyFollowFirstParent: ${onlyFollowFirstParent} when the repo resolves to it`, async () => {
        const { handlers, posted } = await selectSharedRepo({
          repoSource: {
            getRepos: () => ({ [repoPath]: { columnWidths: null, onlyFollowFirstParent } })
          }
        });
        await handlers.get("loadCommits")!({
          command: "loadCommits",
          repo: repoPath,
          branchNames: ["HEAD"],
          maxCommits: 1,
          hard: false,
          token: 3
        } as RequestMessage);

        const res = posted.find((m) => m.command === "loadCommits") as
          | Extract<ResponseMessage, { command: "loadCommits" }>
          | undefined;
        assert.ok(res, "a loadCommits response should be posted");
        assert.strictEqual(res!.onlyFollowFirstParent, onlyFollowFirstParent);
      });
    }
  });

  /** `selectRepo` is where the host commits to a repository, and it is the one
   *  step in the handshake that can fail: simple-git validates `baseDir` at
   *  construction, so a repo deleted since it was last seen throws. Both cases
   *  below are about the same invariant — the host and the webview must not be
   *  left holding different answers to "which repository is this panel on",
   *  because the load responses carry a navigation token and no repo, so nothing
   *  downstream can notice the disagreement. */
  suite("selectRepo failures (integration)", () => {
    test("a repository that is gone is dropped, not half-selected", async () => {
      const gone = path.join(repoPath, `no-such-repo-${process.pid}`);
      const dropped: string[] = [];
      const persisted: (string | null)[] = [];

      const { handlers, posted } = await selectSharedRepo({
        repoSource: { dropRepo: (r) => dropped.push(r) },
        extensionState: { setLastActiveRepo: (r) => persisted.push(r) }
      });
      // Must not reject: the bridge has no catch, so a rejection here is an
      // unhandled one and the webview is told nothing at all.
      await handlers.get("selectRepo")!({ command: "selectRepo", repo: gone } as RequestMessage);

      // Dropping it also re-seeds the panel, so it can move off it.
      assert.deepStrictEqual(
        dropped,
        [gone],
        "the repo that is gone should be dropped from the set"
      );
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
      const persisted: (string | null)[] = [];
      const dropped: string[] = [];

      const { handlers } = await selectSharedRepo({
        repoSource: { dropRepo: (r) => dropped.push(r) },
        extensionState: { setLastActiveRepo: (r) => persisted.push(r) }
      });
      await handlers.get("selectRepo")!({ command: "selectRepo", repo: "" } as RequestMessage);

      assert.deepStrictEqual(persisted, [repoPath], "an empty path must not be stored");
      assert.deepStrictEqual(
        dropped,
        [],
        "an empty path is not a repo to drop, just one to refuse"
      );
    });
  });
});

/** A stash's untracked file read the whole way through (#332): the real
 *  dispatch, the real VS Code opener, and the extension's own diff document
 *  provider reading git. The stash's tree does not have the file, so each reader
 *  that read it from there drew a blank document. Every side is read back from
 *  the editor VS Code actually opened, so a reader that never got the revision
 *  the host worked out shows here as an empty string. */
suite("a stash's untracked file opens with its contents (integration)", () => {
  const STASHED = "brand new untracked\n";
  const WORKING = "edited in the worktree\n";
  let repo: string;
  let stash: string;

  suiteSetup(async function () {
    this.timeout(SEED_TIMEOUT_MS);
    // The diff document provider is the extension's: activate it.
    await vscode.extensions.getExtension("0miles.ging-git-view")!.activate();
    repo = makeRepo();
    fs.mkdirSync(path.join(repo, "sub"));
    fs.writeFileSync(path.join(repo, "sub", "untracked.txt"), STASHED);
    git(["stash", "push", "--include-untracked", "-m", "wip"], repo);
    stash = rev(repo, "stash@{0}");
    // The stash took the file, and its folder, away; View Diff with Working
    // needs one to compare.
    fs.mkdirSync(path.join(repo, "sub"));
    fs.writeFileSync(path.join(repo, "sub", "untracked.txt"), WORKING);
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    rmrf(repo);
  });

  async function dispatch() {
    const { handlers, posted, bridge } = makeBridge();
    const [ports, deps] = makeDeps();
    registerMessageHandlers(bridge, { ...ports, opener: createVscodeOpener(config) }, deps);
    await handlers.get("selectRepo")!({ command: "selectRepo", repo } as RequestMessage);
    const send = async (m: RequestMessage) => {
      posted.length = 0;
      await handlers.get(m.command)!(m);
      return posted;
    };
    return send;
  }

  const activeInput = () => vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  const textOf = async (uri: vscode.Uri) =>
    (await vscode.workspace.openTextDocument(uri)).getText();

  test("each reader of the CDV row reads the stashed file", async () => {
    const send = await dispatch();

    const [details] = await send({
      command: "commitDetails",
      repo,
      commitHash: stash,
      isStash: true
    } as RequestMessage);
    const row = (
      details as Extract<ResponseMessage, { command: "commitDetails" }>
    ).commitDetails!.fileChanges.find((f) => f.newFilePath === "sub/untracked.txt");
    assert.deepStrictEqual(row, {
      oldFilePath: "sub/untracked.txt",
      newFilePath: "sub/untracked.txt",
      type: "A",
      additions: 1,
      deletions: 0,
      origin: "untracked"
    });
    const read = { repo, commitHash: stash, origin: row!.origin };

    // View Diff: nothing on the left, the stashed file on the right.
    assert.deepStrictEqual(
      await send({
        command: "viewDiff",
        ...read,
        oldFilePath: row!.oldFilePath,
        newFilePath: row!.newFilePath,
        type: row!.type
      } as RequestMessage),
      [{ command: "viewDiff", success: true }]
    );
    let input = activeInput();
    assert.ok(input instanceof vscode.TabInputTextDiff, "View Diff opens a diff editor");
    assert.strictEqual(await textOf(input.original), "");
    assert.strictEqual(await textOf(input.modified), STASHED);

    // View File at Revision: the stashed file.
    assert.deepStrictEqual(
      await send({
        command: "viewFileAtRevision",
        ...read,
        filePath: row!.newFilePath
      } as RequestMessage),
      [{ command: "viewFileAtRevision", success: true }]
    );
    input = activeInput();
    assert.ok(input instanceof vscode.TabInputText, "View File at Revision opens an editor");
    assert.strictEqual(await textOf(input.uri), STASHED);

    // View Diff with Working: the stashed file against the one in the worktree.
    assert.deepStrictEqual(
      await send({
        command: "viewDiffWithWorking",
        ...read,
        filePath: row!.newFilePath
      } as RequestMessage),
      [{ command: "viewDiffWithWorking", success: true }]
    );
    input = activeInput();
    assert.ok(input instanceof vscode.TabInputTextDiff, "View Diff with Working opens a diff");
    assert.strictEqual(await textOf(input.original), STASHED);
    assert.strictEqual(input.modified.scheme, "file");
    assert.strictEqual(await textOf(input.modified), WORKING);
  });
});
