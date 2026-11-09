import { describe, expect, it, vi } from "vitest";

import { acknowledgeShowAll } from "@/extension/blameLocate";
import { createBranchFilterStore } from "@/extension/branchFilterStore";
import {
  createBranchSelectionReconciler,
  createDirectFilterWriter
} from "@/extension/branchSelectionReconciler";
import type { ResponseMessage } from "@/types";

// The store's only vscode dependency: a synchronous event emitter, which is
// what VS Code's is.
vi.mock("vscode", () => ({
  EventEmitter: class<T> {
    private listeners: ((e: T) => void)[] = [];
    event = (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    fire(e: T) {
      for (const listener of this.listeners) listener(e);
    }
    dispose() {}
  }
}));

// The graph's `clearBranchFilter` runs Show All and then acknowledges it. A
// locate waiting on Show All (#310) reads an acknowledgement with no empty
// filter ahead of it as "Show All moved nothing", so the order is load-bearing.
describe("acknowledgeShowAll", () => {
  it("acknowledges after a Show All that clears a filter, behind the filter it posts", async () => {
    const posted: ResponseMessage[] = [];
    const store = createBranchFilterStore();
    store.set("/repo", ["main"]);
    // As the message handler forwards filter changes to the graph showing them.
    store.onDidChangeFilter(({ branches }) =>
      posted.push({ command: "setBranchFilter", branches })
    );
    // As the Branches view binds its direct write — Show All is `directWrite(repo, [])`.
    const directWrite = createDirectFilterWriter(createBranchSelectionReconciler(), {
      branchSelection: () => [],
      cancelPendingWrite: () => {},
      writeFilter: (write) => {
        store.set(write.repo, write.branches);
      },
      clearVisualSelection: () => {}
    });

    await acknowledgeShowAll(
      async () => directWrite("/repo", []),
      (msg) => posted.push(msg)
    );

    expect(posted).toEqual([
      { command: "setBranchFilter", branches: [] },
      { command: "branchFilterCleared" }
    ]);
  });

  it("still acknowledges a Show All that fails", async () => {
    const post = vi.fn();
    await expect(
      acknowledgeShowAll(() => Promise.reject(new Error("no view")), post)
    ).rejects.toThrow("no view");
    expect(post).toHaveBeenCalledWith({ command: "branchFilterCleared" });
  });
});
