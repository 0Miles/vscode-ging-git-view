import { describe, expect, it, vi } from "vitest";

import {
  createBranchActionDelegate,
  type BranchActionDelegateDeps
} from "@/extension/branchActionDelegate";
import type { BranchActionTarget, BranchActionTargets } from "@/extension/branchesView";
import type { DelegatedMessage } from "@/types";

const REPO = "/repo";

const local = (branch: string, isCurrent = false): BranchActionTarget => ({
  repo: REPO,
  branch,
  isRemote: false,
  isCurrent
});
const remote = (branch: string): BranchActionTarget => ({
  repo: REPO,
  branch,
  isRemote: true,
  isCurrent: false
});

/** A delegate whose deps are all spies. `resolveTarget` passes the item
 *  through, so tests hand targets in directly; `resolveBatchTargets` returns
 *  whatever the test seeds. */
function makeDelegate(batchTargets: BranchActionTargets | null = null) {
  const posted: DelegatedMessage[] = [];
  const deps = {
    resolveTarget: (item: unknown) => (item as BranchActionTarget | null) ?? null,
    resolveBatchTargets: vi.fn(() => batchTargets),
    openGraphView: vi.fn(async () => {}),
    post: vi.fn((msg: DelegatedMessage) => void posted.push(msg)),
    writeClipboard: vi.fn(),
    showNoTargets: vi.fn()
  } satisfies BranchActionDelegateDeps;
  return { delegate: createBranchActionDelegate(deps), deps, posted };
}

describe("createBranchActionDelegate", () => {
  it("shares one monotonic seq between single and batch actions", async () => {
    const { delegate, deps, posted } = makeDelegate({
      repo: REPO,
      targets: ["feature/a"],
      skipped: []
    });
    await delegate.run(local("feature/a"), "merge");
    await delegate.runBatch([{}], "push");
    await delegate.run(local("feature/a"), "rename");
    expect(posted.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(deps.openGraphView).toHaveBeenCalledTimes(3);
  });

  it("delivers over two paths: the direct post, and the selectRepo flush for the action's repo only", async () => {
    const { delegate, deps, posted } = makeDelegate();
    await delegate.run(local("feature/a"), "merge");
    expect(posted).toHaveLength(1); // direct post, panel already live

    // A selectRepo for some other repo must not discard the pending action …
    delegate.flushDelegated("/elsewhere");
    expect(posted).toHaveLength(1);
    // … its own repo's flush delivers it (the webview dedupes by seq), once.
    delegate.flushDelegated(REPO);
    delegate.flushDelegated(REPO);
    expect(posted).toHaveLength(2);
    expect(posted[1]).toBe(posted[0]);
    expect(deps.openGraphView).toHaveBeenCalledTimes(1);
  });

  it("stops head-guarded actions on the checked-out branch before the panel would open", async () => {
    const { delegate, deps, posted } = makeDelegate();
    await delegate.run(local("main", true), "delete");
    expect(deps.openGraphView).not.toHaveBeenCalled();
    expect(posted).toHaveLength(0);
    // push carries no head guard: pushing the checked-out branch is fine.
    await delegate.run(local("main", true), "push");
    expect(posted).toHaveLength(1);
  });

  it("throws on a ref-kind mismatch instead of silently no-opping", async () => {
    const { delegate, posted } = makeDelegate();
    await expect(delegate.run(remote("remotes/origin/x"), "rename")).rejects.toThrow(
      /does not apply to remote ref/
    );
    await expect(delegate.run(local("feature/a"), "pull")).rejects.toThrow(
      /does not apply to local ref/
    );
    expect(posted).toHaveLength(0);
  });

  it("puts the canonical ref on the wire, with no separate remote flag", async () => {
    const { delegate, posted } = makeDelegate();
    await delegate.run(remote("remotes/origin/feature"), "checkout");
    expect(posted[0]).toEqual({
      command: "runRefAction",
      repo: REPO,
      ref: "remotes/origin/feature",
      action: "checkout",
      seq: 1
    });
    expect(posted[0]).not.toHaveProperty("isRemote");
  });

  it("runs copyName in the host: display refs on the clipboard, no panel", async () => {
    const { delegate, deps, posted } = makeDelegate({
      repo: REPO,
      targets: ["remotes/origin/x", "main", "feature/a"],
      skipped: []
    });
    await delegate.run(remote("remotes/origin/feature"), "copyName");
    expect(deps.writeClipboard).toHaveBeenCalledWith("origin/feature");
    // The batch joins tree order, one display ref per line.
    await delegate.runBatch([{}], "copyName");
    expect(deps.writeClipboard).toHaveBeenCalledWith("origin/x\nmain\nfeature/a");
    expect(deps.openGraphView).not.toHaveBeenCalled();
    expect(posted).toHaveLength(0);
  });

  it("reports a batch whose every branch was ruled out, naming the skipped refs", async () => {
    const skipped = [{ ref: "main", reason: "checkedOut" as const }];
    const { delegate, deps, posted } = makeDelegate({ repo: REPO, targets: [], skipped });
    await delegate.runBatch([{}], "delete");
    expect(deps.showNoTargets).toHaveBeenCalledWith(skipped);
    expect(deps.openGraphView).not.toHaveBeenCalled();
    expect(posted).toHaveLength(0);
  });

  // The blame hover's "locate in the graph" (#310) waits for the graph the same
  // way a delegated action does, and shares the counter so it can never be read
  // as some action's retry.
  it("opens the graph on the commit's repository and delivers the locate over both paths", async () => {
    const { delegate, deps, posted } = makeDelegate();
    await delegate.run(local("feature/a"), "merge");
    await delegate.locateCommit("/other", "a".repeat(40));
    expect(deps.openGraphView).toHaveBeenLastCalledWith("/other");
    expect(posted.at(-1)).toEqual({
      command: "locateCommit",
      repo: "/other",
      hash: "a".repeat(40),
      seq: 2
    });

    // A panel that reloads for the repo gets it again from the flush.
    delegate.flushDelegated(REPO);
    expect(posted).toHaveLength(2);
    delegate.flushDelegated("/other");
    expect(posted).toHaveLength(3);
    expect(posted.at(-1)).toMatchObject({ command: "locateCommit", seq: 2 });
  });

  // #325: the waiting message used to be one slot, so a second request made
  // while the panel loaded quietly replaced the first. Both are for the repo
  // the graph is opening on, so both are owed.
  it("keeps every message for the repo the graph is opening on, and flushes them in order", async () => {
    const { delegate, posted } = makeDelegate();
    await delegate.run(local("feature/a"), "merge");
    await delegate.locateCommit(REPO, "a".repeat(40));
    posted.splice(0);

    delegate.flushDelegated(REPO);
    expect(posted.map((m) => [m.command, m.seq])).toEqual([
      ["runRefAction", 1],
      ["locateCommit", 2]
    ]);
    delegate.flushDelegated(REPO);
    expect(posted).toHaveLength(2);
  });

  // A request for another repo takes the graph there, away from the repo the
  // earlier one was waiting on: that one would otherwise run whenever the user
  // next happened to open its repo, long after asking.
  it("drops a waiting message once a later one takes the graph to another repo", async () => {
    const { delegate, posted } = makeDelegate();
    await delegate.run(local("feature/a"), "merge");
    await delegate.locateCommit("/other", "a".repeat(40));
    posted.splice(0);

    delegate.flushDelegated(REPO);
    expect(posted).toEqual([]);
    delegate.flushDelegated("/other");
    expect(posted.map((m) => m.seq)).toEqual([2]);
  });

  // A reloaded panel remembers no seq, so whatever the flush hands it runs: a
  // message the webview has already run must not still be held for one.
  it("stops holding a message once the webview has run it, with every one before it", async () => {
    const { delegate, posted } = makeDelegate();
    await delegate.run(local("feature/a"), "merge");
    await delegate.locateCommit(REPO, "a".repeat(40));
    await delegate.run(local("feature/a"), "rename");
    posted.splice(0);

    delegate.delegatedRan(2);
    delegate.flushDelegated(REPO);
    expect(posted.map((m) => m.seq)).toEqual([3]);
  });

  it("forgets what was waiting when the panel closes", async () => {
    const { delegate, posted } = makeDelegate();
    await delegate.run(local("feature/a"), "merge");
    posted.splice(0);

    delegate.forgetPending();
    delegate.flushDelegated(REPO);
    expect(posted).toEqual([]);
  });
});
