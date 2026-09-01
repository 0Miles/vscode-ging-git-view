import { describe, expect, it } from "vitest";

import { planRebase, rebaseTodo, type RebaseCommit } from "@/backend/utils/rebasePlan";

/** Build a replay list oldest-first from a keep/drop mask: "kkd" = oldest and
 *  middle kept, newest dropped. */
function list(mask: string): RebaseCommit[] {
  return [...mask].map((flag, i) => ({
    hash: `c${i + 1}`,
    message: `commit ${i + 1}`,
    keep: flag === "k"
  }));
}

describe("planRebase", () => {
  it("leaves an untouched dialog running the command it already had", () => {
    // The whole point: ticking nothing off may not change what runs.
    expect(planRebase(list("kkkk"))).toEqual({ kind: "unchanged" });
  });

  it("reports an empty plan rather than running git on nothing", () => {
    expect(planRebase(list("ddd"))).toEqual({ kind: "empty" });
    expect(planRebase([])).toEqual({ kind: "empty" });
  });

  it("narrows the range when only the oldest commits are dropped", () => {
    // c1, c2 dropped → the range still describes it, starting after c2.
    expect(planRebase(list("ddkk"))).toEqual({ kind: "narrowed", upstream: "c2" });
    expect(planRebase(list("dkkk"))).toEqual({ kind: "narrowed", upstream: "c1" });
  });

  it("goes interactive when the newest commits are dropped", () => {
    // A range cannot express this: `--onto X A c2` would detach HEAD at the
    // replayed c2 and leave the branch where it was.
    expect(planRebase(list("kkdd"))).toMatchObject({ kind: "interactive" });
  });

  it("goes interactive on a gap in the middle", () => {
    expect(planRebase(list("kdk"))).toMatchObject({ kind: "interactive" });
    expect(planRebase(list("kddk"))).toMatchObject({ kind: "interactive" });
  });

  it("treats a single kept commit by where it sits", () => {
    expect(planRebase(list("ddk"))).toEqual({ kind: "narrowed", upstream: "c2" }); // newest kept
    expect(planRebase(list("kdd"))).toMatchObject({ kind: "interactive" }); // oldest kept
  });
});

describe("rebaseTodo", () => {
  it("writes one line per commit, oldest first, dropped ones spelled out", () => {
    expect(rebaseTodo(list("kdk"))).toBe("pick c1 commit 1\ndrop c2 commit 2\npick c3 commit 3\n");
  });

  it("keeps a subject on one line so it cannot become a second todo command", () => {
    const commits: RebaseCommit[] = [{ hash: "c1", message: "subject\nexec rm -rf /", keep: true }];
    expect(rebaseTodo(commits)).toBe("pick c1 subject exec rm -rf /\n");
  });
});
