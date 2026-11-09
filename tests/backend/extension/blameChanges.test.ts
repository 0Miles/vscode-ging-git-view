import { describe, expect, it, vi } from "vitest";

import type { BlamedCommit, CommitChange } from "@/backend/queries/blameCommitChange";
import { createBlameChanges } from "@/extension/blameChanges";

const commit = (sha: string, filename = "a.txt"): BlamedCommit => ({
  sha,
  filename,
  previous: null
});
const CHANGE: CommitChange = { message: "m", hunks: [] };

/** A load whose every call can be settled by hand, and whose signals are kept.
 *  Like the real one, an aborted load resolves null. */
function manualLoad() {
  const calls: { signal: AbortSignal; settle: (change: CommitChange | null) => void }[] = [];
  const load = vi.fn(
    (_commit: BlamedCommit, _repo: string, signal: AbortSignal) =>
      new Promise<CommitChange | null>((resolve) => {
        calls.push({ signal, settle: resolve });
        signal.addEventListener("abort", () => resolve(null));
      })
  );
  return { load, calls };
}

describe("createBlameChanges", () => {
  it("loads a commit's change to a file once", async () => {
    const load = vi.fn(async () => CHANGE);
    const { changeOf } = createBlameChanges({ load, size: 10 });

    expect(await changeOf(commit("a"), "/repo")).toBe(CHANGE);
    expect(await changeOf(commit("a"), "/repo")).toBe(CHANGE);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("tells repositories, commits and files apart", async () => {
    const load = vi.fn(async () => CHANGE);
    const { changeOf } = createBlameChanges({ load, size: 10 });

    await changeOf(commit("a"), "/repo");
    await changeOf(commit("a"), "/other");
    await changeOf(commit("b"), "/repo");
    await changeOf(commit("a", "b.txt"), "/repo");
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("loads again after a failure", async () => {
    const load = vi.fn<() => Promise<CommitChange | null>>().mockResolvedValueOnce(null);
    load.mockResolvedValue(CHANGE);
    const { changeOf } = createBlameChanges({ load, size: 10 });

    expect(await changeOf(commit("a"), "/repo")).toBeNull();
    expect(await changeOf(commit("a"), "/repo")).toBe(CHANGE);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("drops the least recently used change to make room", async () => {
    const load = vi.fn(async () => CHANGE);
    const { changeOf } = createBlameChanges({ load, size: 2 });

    await changeOf(commit("a"), "/repo");
    await changeOf(commit("b"), "/repo");
    await changeOf(commit("a"), "/repo"); // a is now the most recent
    await changeOf(commit("c"), "/repo"); // so b goes
    load.mockClear();

    await changeOf(commit("a"), "/repo");
    expect(load).not.toHaveBeenCalled();
    await changeOf(commit("b"), "/repo");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("resolves null when the load rejects", async () => {
    const { changeOf } = createBlameChanges({
      load: () => Promise.reject(new Error("boom")),
      size: 10
    });
    expect(await changeOf(commit("a"), "/repo")).toBeNull();
  });

  describe("only the latest request loads", () => {
    it("aborts the load in flight when another change is asked for", async () => {
      const { load, calls } = manualLoad();
      const { changeOf } = createBlameChanges({ load, size: 10 });

      const a = changeOf(commit("a"), "/repo");
      const b = changeOf(commit("b"), "/repo");

      expect(calls[0].signal.aborted).toBe(true);
      expect(calls[1].signal.aborted).toBe(false);
      expect(await a).toBeNull();
      calls[1].settle(CHANGE);
      expect(await b).toBe(CHANGE);
    });

    it("lets the load in flight run when the same change is asked for again", async () => {
      const { load, calls } = manualLoad();
      const { changeOf } = createBlameChanges({ load, size: 10 });

      const first = changeOf(commit("a"), "/repo");
      const again = changeOf(commit("a"), "/repo");

      expect(again).toBe(first);
      expect(load).toHaveBeenCalledTimes(1);
      expect(calls[0].signal.aborted).toBe(false);
    });

    it("aborts the load in flight when a change already loaded is asked for", async () => {
      const { load, calls } = manualLoad();
      const { changeOf } = createBlameChanges({ load, size: 10 });
      const loaded = changeOf(commit("a"), "/repo");
      calls[0].settle(CHANGE);
      await loaded;

      void changeOf(commit("b"), "/repo");
      expect(await changeOf(commit("a"), "/repo")).toBe(CHANGE);
      expect(calls[1].signal.aborted).toBe(true);
    });

    it("aborts the load in flight on cancel", () => {
      const { load, calls } = manualLoad();
      const changes = createBlameChanges({ load, size: 10 });

      void changes.changeOf(commit("a"), "/repo");
      changes.cancel();

      expect(calls[0].signal.aborted).toBe(true);
    });

    it("keeps nothing of an aborted load: asked again, it loads again", async () => {
      const { load, calls } = manualLoad();
      const { changeOf } = createBlameChanges({ load, size: 10 });

      void changeOf(commit("a"), "/repo");
      void changeOf(commit("b"), "/repo"); // aborts a
      const again = changeOf(commit("a"), "/repo"); // aborts b, loads a anew

      expect(load).toHaveBeenCalledTimes(3);
      calls[2].settle(CHANGE);
      expect(await again).toBe(CHANGE);
    });

    it("never lets a late failure of an older load drop a newer one", async () => {
      const { load, calls } = manualLoad();
      const { changeOf } = createBlameChanges({ load, size: 10 });

      void changeOf(commit("a"), "/repo");
      void changeOf(commit("b"), "/repo");
      const second = changeOf(commit("a"), "/repo");
      calls[2].settle(CHANGE);
      expect(await second).toBe(CHANGE);
      calls[0].settle(null); // the aborted first load reports late

      expect(await changeOf(commit("a"), "/repo")).toBe(CHANGE);
      expect(load).toHaveBeenCalledTimes(3);
    });
  });
});
