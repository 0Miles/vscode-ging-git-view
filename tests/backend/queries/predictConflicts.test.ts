import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { predictConflicts } from "@/backend/queries/predictConflicts";

import { git, makeRepo } from "@tests/backend/helpers";

let repo: string;

beforeAll(() => {
  repo = makeRepo();
  // Base commit on main with two tracked files.
  fs.writeFileSync(path.join(repo, "shared.txt"), "line1\nline2\nline3\n");
  fs.writeFileSync(path.join(repo, "other.txt"), "orig\n");
  git(["add", "."], repo);
  git(["commit", "-m", "base"], repo);

  // ours: change shared.txt line 1.
  git(["checkout", "-b", "ours"], repo);
  fs.writeFileSync(path.join(repo, "shared.txt"), "OURS\nline2\nline3\n");
  git(["commit", "-am", "ours"], repo);

  // theirs-conflict: from base, change shared.txt line 1 differently.
  git(["checkout", "main"], repo);
  git(["checkout", "-b", "theirs-conflict"], repo);
  fs.writeFileSync(path.join(repo, "shared.txt"), "THEIRS\nline2\nline3\n");
  git(["commit", "-am", "theirs-conflict"], repo);

  // theirs-clean: from base, change only other.txt.
  git(["checkout", "main"], repo);
  git(["checkout", "-b", "theirs-clean"], repo);
  fs.writeFileSync(path.join(repo, "other.txt"), "changed\n");
  git(["commit", "-am", "theirs-clean"], repo);

  git(["checkout", "ours"], repo);
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("predictConflicts (real git)", () => {
  it("reports the files that would conflict", async () => {
    const r = await predictConflicts(simpleGit(repo), { ours: "ours", theirs: "theirs-conflict" });
    expect(r.ok).toBe(true);
    expect(r.conflictFiles).toContain("shared.txt");
  });

  it("reports no conflicts when the branches touch different files", async () => {
    const r = await predictConflicts(simpleGit(repo), { ours: "ours", theirs: "theirs-clean" });
    expect(r.ok).toBe(true);
    expect(r.conflictFiles).toEqual([]);
  });

  it("reports no conflicts for an already-merged ref", async () => {
    const r = await predictConflicts(simpleGit(repo), { ours: "ours", theirs: "main" });
    expect(r.ok).toBe(true);
    expect(r.conflictFiles).toEqual([]);
  });

  it("reports ok: false for an invalid ref", async () => {
    const r = await predictConflicts(simpleGit(repo), { ours: "ours", theirs: "no-such-ref" });
    expect(r.ok).toBe(false);
    expect(r.conflictFiles).toEqual([]);
  });
});
