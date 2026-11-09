import { describe, expect, it, vi } from "vitest";

import type { CommitChange } from "@/backend/queries/blameCommitChange";
import type { BlameLine } from "@/backend/queries/blameFile";
import { createBlameChanges } from "@/extension/blameChanges";

type Commit = Pick<BlameLine, "sha" | "filename" | "previous">;
const commit = (sha: string, filename = "a.txt"): Commit => ({ sha, filename, previous: null });
const CHANGE: CommitChange = { message: "m", hunks: [] };

/** A load whose every call can be settled by hand. */
function manualLoad() {
  const pending: ((change: CommitChange | null) => void)[] = [];
  const load = vi.fn(() => new Promise<CommitChange | null>((resolve) => pending.push(resolve)));
  return { load, settle: (i: number, change: CommitChange | null) => pending[i](change) };
}

describe("createBlameChanges", () => {
  it("loads a commit's change to a file once", async () => {
    const load = vi.fn(async () => CHANGE);
    const changeOf = createBlameChanges({ load, size: 10 });

    expect(await changeOf(commit("a"), "/repo")).toBe(CHANGE);
    expect(await changeOf(commit("a"), "/repo")).toBe(CHANGE);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("tells repositories, commits and files apart", async () => {
    const load = vi.fn(async () => CHANGE);
    const changeOf = createBlameChanges({ load, size: 10 });

    await changeOf(commit("a"), "/repo");
    await changeOf(commit("a"), "/other");
    await changeOf(commit("b"), "/repo");
    await changeOf(commit("a", "b.txt"), "/repo");
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("loads again after a failure", async () => {
    const load = vi.fn<() => Promise<CommitChange | null>>().mockResolvedValueOnce(null);
    load.mockResolvedValue(CHANGE);
    const changeOf = createBlameChanges({ load, size: 10 });

    expect(await changeOf(commit("a"), "/repo")).toBeNull();
    expect(await changeOf(commit("a"), "/repo")).toBe(CHANGE);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("drops the least recently used change to make room", async () => {
    const load = vi.fn(async () => CHANGE);
    const changeOf = createBlameChanges({ load, size: 2 });

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

  it("keeps a newer load when an older one for the same change fails late", async () => {
    const { load, settle } = manualLoad();
    const changeOf = createBlameChanges({ load, size: 1 });

    const first = changeOf(commit("a"), "/repo");
    void changeOf(commit("b"), "/repo"); // pushes a out while it still loads
    const second = changeOf(commit("a"), "/repo");
    settle(2, CHANGE);
    expect(await second).toBe(CHANGE);
    settle(0, null);
    expect(await first).toBeNull();

    expect(await changeOf(commit("a"), "/repo")).toBe(CHANGE);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("resolves null when the load rejects", async () => {
    const changeOf = createBlameChanges({
      load: () => Promise.reject(new Error("boom")),
      size: 10
    });
    expect(await changeOf(commit("a"), "/repo")).toBeNull();
  });
});
