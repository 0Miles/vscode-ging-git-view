import { describe, expect, it } from "vitest";

import type { CleanupCandidate } from "@/types";
import { defaultCheckedRefs, groupToggleState, mergeCheckedRefs } from "@/webview/branchCleanup";

/** A candidate row carrying exactly the facts named. */
function row(ref: string, facts: Partial<CleanupCandidate["facts"]>): CleanupCandidate {
  return {
    ref,
    isRemote: ref.startsWith("remotes/"),
    facts: { merged: false, redundant: false, inactive: false, ...facts }
  };
}

describe("defaultCheckedRefs", () => {
  it("pre-checks the branches whose content is already on the mainline", () => {
    const checked = defaultCheckedRefs([
      row("merged", { merged: true }),
      row("redundant", { redundant: true }),
      row("both", { merged: true, inactive: true })
    ]);
    expect(checked).toEqual(["merged", "redundant", "both"]);
  });

  it("never pre-checks a branch that is only inactive", () => {
    // The single mechanism holding ADR-0015 up. Inactive says nothing about
    // whether deleting loses work — a years-idle branch that was never merged is
    // inactive — and on a remote it is very likely somebody else's work.
    const checked = defaultCheckedRefs([
      row("old", { inactive: true }),
      row("remotes/origin/someone-elses", { inactive: true })
    ]);
    expect(checked).toEqual([]);
  });

  it("applies the same rule to remote branches as to local ones", () => {
    // Remote candidates are treated identically on purpose (ADR-0015): one list,
    // one rule, so what the user learns from the local rows holds for the
    // remote ones too.
    const checked = defaultCheckedRefs([
      row("remotes/origin/merged", { merged: true }),
      row("remotes/origin/idle", { inactive: true })
    ]);
    expect(checked).toEqual(["remotes/origin/merged"]);
  });
});

describe("groupToggleState", () => {
  const rows = [
    row("remotes/origin/a", { merged: true }),
    row("remotes/origin/b", { inactive: true }),
    row("local-a", { merged: true })
  ];

  it("reports a group whose every row is ticked", () => {
    const state = groupToggleState(rows, new Set(["remotes/origin/a", "remotes/origin/b"]), true);
    expect(state).toBe("all");
  });

  it("reports a group with no row ticked", () => {
    expect(groupToggleState(rows, new Set(["local-a"]), true)).toBe("none");
  });

  it("reports a partly ticked group, so the header can show it", () => {
    // The header is a tri-state: "some" is what makes it indeterminate rather
    // than lying in either direction about the rows below it.
    expect(groupToggleState(rows, new Set(["remotes/origin/a"]), true)).toBe("some");
  });

  it("treats an empty group as none, not as all", () => {
    // `[].every(...)` is true, so the obvious implementation would render a
    // ticked header over no rows.
    expect(groupToggleState([], new Set(), false)).toBe("none");
  });
});

describe("mergeCheckedRefs", () => {
  it("keeps the user's choice for rows they have already seen", () => {
    // A deep check re-renders the whole list. Re-applying the default rule would
    // silently re-check a merged branch the user had deliberately unticked.
    const checked = mergeCheckedRefs({
      candidates: [row("merged", { merged: true }), row("old", { inactive: true })],
      shown: new Set(["merged", "old"]),
      checked: new Set(["old"])
    });
    expect(checked).toEqual(["old"]);
  });

  it("applies the default rule to rows the scan has just added", () => {
    // The deep check grows the list: a branch squash-merged yesterday was in
    // neither fact set, so it appears for the first time here and gets the
    // default treatment its facts earn.
    const checked = mergeCheckedRefs({
      candidates: [
        row("merged", { merged: true }),
        row("squashed", { redundant: true }),
        row("also-new", { inactive: true })
      ],
      shown: new Set(["merged"]),
      checked: new Set()
    });
    expect(checked).toEqual(["squashed"]);
  });
});
