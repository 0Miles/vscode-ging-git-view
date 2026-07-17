import * as assert from "node:assert";
import * as cp from "node:child_process";

import * as vscode from "vscode";

import { gitClientFactory } from "@/backend/gitClient";
import { config } from "@/config";
import { registerMessageHandlers } from "@/extension/messageHandler";
import type { WebviewBridge } from "@/extension/webviewBridge";
import type { RequestMessage, ResponseMessage } from "@/types";

// End-to-end exercise of the extension-side branch flow against the real repo
// (the test workspace is this repo). Drives the real registerMessageHandlers
// with a real git client + real config through a fake bridge, mimicking the
// webview's selectRepo -> loadBranches handshake. Expectations are derived
// from git itself: CI checkouts only have the branch being built, never main.
const noop = () => {};

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
    const gitClient = gitClientFactory("", config.gitPath(), undefined, {
      GIT_ASKPASS: "/some/askpass.sh",
      ELECTRON_RUN_AS_NODE: "1"
    });
    const deps = {
      config,
      gitClient,
      repoManager: { getRepos: () => ({}), setRepoState: noop } as never,
      extensionState: { setLastActiveRepo: noop, getLastActiveRepo: () => null } as never,
      avatarManager: { fetchAvatarImage: noop } as never,
      repoFileWatcher: { start: noop, mute: noop, unmute: noop } as never,
      branchFilterStore: {
        has: () => false,
        get: () => [],
        set: () => false,
        onDidChangeFilter: () => ({ dispose: noop }),
        dispose: noop
      } as never,
      onSelectRepo: noop
    };
    registerMessageHandlers(bridge, deps);

    // Mimic the webview's startup handshake.
    await handlers.get("selectRepo")!({ command: "selectRepo", repo: repoPath } as RequestMessage);
    await handlers.get("loadBranches")!({
      command: "loadBranches",
      showRemoteBranches: true,
      hard: true
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

    const gitClient = gitClientFactory("", config.gitPath(), undefined, {
      GIT_ASKPASS: "/some/askpass.sh",
      ELECTRON_RUN_AS_NODE: "1"
    });
    const deps = {
      config,
      gitClient,
      repoManager: { getRepos: () => ({}), setRepoState: noop } as never,
      extensionState: { setLastActiveRepo: noop, getLastActiveRepo: () => null } as never,
      avatarManager: { fetchAvatarImage: noop } as never,
      repoFileWatcher: { start: noop, mute: noop, unmute: noop } as never,
      branchFilterStore: {
        has: () => false,
        get: () => [],
        set: () => false,
        onDidChangeFilter: () => ({ dispose: noop }),
        dispose: noop
      } as never,
      onSelectRepo: noop
    };
    registerMessageHandlers(bridge, deps);

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
