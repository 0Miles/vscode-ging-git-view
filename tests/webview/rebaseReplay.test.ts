import { describe, expect, it } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { rebaseReplay } from "@/webview/rebaseReplay";

// What the rebase dialog lists: the commits git would really replay for a
// range, read off the loaded commits alone. Its answers are what the ticks in
// that dialog are ticks *on*, so an over-long list promises a move git will not
// make and a short one hides one it will.

function node(
  hash: string,
  parentHashes: string[],
  message: string,
  refs: GitCommitNode["refs"] = []
): GitCommitNode {
  return {
    hash,
    parentHashes,
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message,
    refs
  };
}

/** Graph order — newest first, the order the rows are in on screen. */
function graph(commits: GitCommitNode[]) {
  const lookup: { [hash: string]: number } = {};
  commits.forEach((c, i) => (lookup[c.hash] = i));
  return { commits, lookup };
}

describe("rebaseReplay", () => {
  it("lists the range oldest first, excluding the lower bound", () => {
    const { commits, lookup } = graph([
      node("c", ["b"], "third"),
      node("b", ["a"], "second"),
      node("a", ["root"], "first"),
      node("root", [], "root")
    ]);

    const replay = rebaseReplay("a", "c", commits, lookup);

    // `upstream..tip` excludes the lower bound and includes the tip; oldest
    // first is git's own todo order, which is what `planRebase` reads.
    expect(replay.commits).toEqual([
      { hash: "b", message: "second" },
      { hash: "c", message: "third" }
    ]);
    expect(replay.mergesSquashed).toBe(0);
    expect(replay.strandedBranches).toEqual([]);
    expect(replay.incomplete).toBe(false);
  });

  it("is empty when the tip is already on the lower bound", () => {
    const { commits, lookup } = graph([node("a", ["root"], "first"), node("root", [], "root")]);

    // A rebase with nothing to replay is a fast-forward, not a refusal — the
    // dialog has to be able to tell that apart from an unticked list.
    expect(rebaseReplay("a", "a", commits, lookup)).toEqual({
      commits: [],
      mergesSquashed: 0,
      strandedBranches: [],
      incomplete: false
    });
  });

  it("leaves merge commits out and counts them, naming the branches left behind", () => {
    // main:  root ← m1 ← merge ← m2, side: root ← s1 ← s2, merged at `merge`.
    const { commits, lookup } = graph([
      node("m2", ["merge"], "after the merge"),
      node("merge", ["m1", "s2"], "Merge branch 'side'"),
      node("s2", ["s1"], "side two", [{ hash: "s2", name: "side", type: "head" }]),
      node("s1", ["root"], "side one"),
      node("m1", ["root"], "mainline one"),
      node("root", [], "root")
    ]);

    const replay = rebaseReplay("root", "m2", commits, lookup);

    // The merge is absent: without `--rebase-merges` git never replays it.
    expect(replay.commits.map((c) => c.hash)).toEqual(["m1", "s1", "s2", "m2"]);
    expect(replay.mergesSquashed).toBe(1);
    // `side` keeps pointing at s2 while a copy of s2 lands on the new base.
    expect(replay.strandedBranches).toEqual(["side"]);
    expect(replay.incomplete).toBe(false);
  });

  it("does not count the tip's own branch as left behind", () => {
    const { commits, lookup } = graph([
      node("b", ["a"], "second", [{ hash: "b", name: "topic", type: "head" }]),
      node("a", ["root"], "first"),
      node("root", [], "root")
    ]);

    // The tip's branch is the one git moves, so it is the one branch that does
    // not stay where it is.
    expect(rebaseReplay("root", "b", commits, lookup).strandedBranches).toEqual([]);
  });

  it("reports the range as incomplete when it runs past the loaded commits", () => {
    // `old` is named as a parent but was never loaded, so the walk cannot tell
    // how much further the range goes.
    const { commits, lookup } = graph([node("b", ["a"], "second"), node("a", ["old"], "first")]);

    const replay = rebaseReplay("unrelated", "b", commits, lookup);

    expect(replay.incomplete).toBe(true);
  });

  it("reports incomplete rather than an empty range when the tip is not loaded", () => {
    const { commits, lookup } = graph([node("a", [], "first")]);

    expect(rebaseReplay("a", "gone", commits, lookup)).toEqual({
      commits: [],
      mergesSquashed: 0,
      strandedBranches: [],
      incomplete: true
    });
  });

  it("takes the ancestry, not the graph order, as the range", () => {
    // `other` sits between the two in graph order but is on a branch of its
    // own, so it is not in `a..c` and git would not replay it.
    const { commits, lookup } = graph([
      node("c", ["b"], "third"),
      node("other", ["a"], "elsewhere"),
      node("b", ["a"], "second"),
      node("a", [], "first")
    ]);

    expect(rebaseReplay("a", "c", commits, lookup).commits.map((c) => c.hash)).toEqual(["b", "c"]);
  });
});
