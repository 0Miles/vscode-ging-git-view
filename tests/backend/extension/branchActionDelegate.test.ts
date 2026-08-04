import { describe, expect, it, vi } from "vitest";

import {
  createBranchActionDelegate,
  type BranchActionDelegateDeps
} from "@/extension/branchActionDelegate";
import type { BranchActionTarget, BranchActionTargets } from "@/extension/branchesView";
import type { ResponseRunRefAction, ResponseRunRefBatchAction } from "@/types";

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
  const posted: (ResponseRunRefAction | ResponseRunRefBatchAction)[] = [];
  const deps = {
    resolveTarget: (item: unknown) => (item as BranchActionTarget | null) ?? null,
    resolveBatchTargets: vi.fn(() => batchTargets),
    openGraphView: vi.fn(async () => {}),
    post: vi.fn((msg: ResponseRunRefAction | ResponseRunRefBatchAction) => void posted.push(msg)),
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
    delegate.flushPendingRefAction("/elsewhere");
    expect(posted).toHaveLength(1);
    // … its own repo's flush delivers it (the webview dedupes by seq), once.
    delegate.flushPendingRefAction(REPO);
    delegate.flushPendingRefAction(REPO);
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
});
