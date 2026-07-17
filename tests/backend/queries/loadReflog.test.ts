import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadDanglingCommits, loadReflog } from "@/backend/queries/loadReflog";

import { git, makeRepo } from "@tests/backend/helpers";

let repo: string;
let danglingHash: string;

beforeAll(() => {
  repo = makeRepo(); // main with an "init" commit
  fs.writeFileSync(path.join(repo, "f"), "b");
  git(["commit", "-am", "c2"], repo);
  git(["checkout", "-b", "feat"], repo);
  fs.writeFileSync(path.join(repo, "f"), "c");
  git(["commit", "-am", "c3-dangling"], repo);
  danglingHash = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
  git(["checkout", "main"], repo);
  // Deleting the branch leaves c3 reachable only via the reflog → dangling
  // once reflogs are ignored.
  git(["branch", "-D", "feat"], repo);
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("loadReflog (real git)", () => {
  it("returns reflog entries with a selector and subject", async () => {
    const entries = await loadReflog(simpleGit(repo));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].selector).toMatch(/^HEAD@\{\d+\}$/);
    expect(entries[0].shortHash).toMatch(/^[0-9a-f]{7,}$/); // clean, no stray whitespace
    expect(entries.every((e) => e.hash.length > 0 && !e.dangling)).toBe(true);
    expect(entries.some((e) => e.subject.includes("c3-dangling"))).toBe(true);
  });

  it("finds the commit dangling beyond the reflog", async () => {
    const dangling = await loadDanglingCommits(simpleGit(repo));
    expect(dangling.some((e) => e.hash === danglingHash && e.dangling)).toBe(true);
  });
});
