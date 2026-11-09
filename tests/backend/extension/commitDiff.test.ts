import { describe, expect, it } from "vitest";

import { type CommitDiffRequest, commitDiffView } from "@/extension/commitDiff";

const SHA = "a".repeat(40);
const FROM = "b".repeat(40);

const LABELS = {
  addedIn: (abbrev: string) => `Added in ${abbrev}`,
  deletedIn: (abbrev: string) => `Deleted in ${abbrev}`
};

function view(overrides: Partial<CommitDiffRequest> = {}) {
  return commitDiffView(
    {
      repo: "/repo",
      commitHash: SHA,
      oldFilePath: "src/a.ts",
      newFilePath: "src/a.ts",
      type: "M",
      ...overrides
    },
    LABELS
  );
}

describe("commitDiffView", () => {
  it("compares a modified file with the commit's first parent", () => {
    expect(view()).toEqual({
      left: { repo: "/repo", filePath: "src/a.ts", commit: `${SHA}^` },
      right: { repo: "/repo", filePath: "src/a.ts", commit: SHA },
      title: "a.ts (aaaaaaaa^ ↔ aaaaaaaa)",
      reveal: null
    });
  });

  it("shows a renamed file's old path on the left and its new one on the right", () => {
    const { left, right, title } = view({
      type: "R",
      oldFilePath: "old/name.ts",
      newFilePath: "new/renamed.ts"
    });
    expect(left).toEqual({ repo: "/repo", filePath: "old/name.ts", commit: `${SHA}^` });
    expect(right).toEqual({ repo: "/repo", filePath: "new/renamed.ts", commit: SHA });
    expect(title).toBe("renamed.ts (aaaaaaaa^ ↔ aaaaaaaa)");
  });

  it("compares against the given commit instead of the parent when there is one", () => {
    const { left, right, title } = view({ fromHash: FROM });
    expect(left).toEqual({ repo: "/repo", filePath: "src/a.ts", commit: FROM });
    expect(right).toEqual({ repo: "/repo", filePath: "src/a.ts", commit: SHA });
    expect(title).toBe("a.ts (bbbbbbbb ↔ aaaaaaaa)");
  });

  it("titles an added file as added in the commit", () => {
    const { left, right, title } = view({ type: "A" });
    // The parent has no such file: the left side reads as an empty document.
    expect(left).toEqual({ repo: "/repo", filePath: "src/a.ts", commit: `${SHA}^` });
    expect(right).toEqual({ repo: "/repo", filePath: "src/a.ts", commit: SHA });
    expect(title).toBe("a.ts (Added in aaaaaaaa)");
  });

  it("titles a deleted file as deleted in the commit", () => {
    expect(view({ type: "D" }).title).toBe("a.ts (Deleted in aaaaaaaa)");
  });

  it("reveals the asked line of the commit's version, counted from zero", () => {
    expect(view({ revealLine: 1 }).reveal).toBe(0);
    expect(view({ revealLine: 42 }).reveal).toBe(41);
  });
});
