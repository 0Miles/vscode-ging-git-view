import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pushBranches } from "@/backend/actions/branch";

import { git, makeRepo, rmrf } from "@tests/backend/helpers";

let repo: string;
let remote: string;

beforeAll(() => {
  repo = makeRepo();
  remote = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-remote-"));
  cp.execFileSync("git", ["init", "--bare", "--initial-branch=main"], { cwd: remote });
  git(["remote", "add", "origin", remote], repo);
  git(["push", "origin", "main"], repo);
});

afterAll(() => {
  rmrf(repo);
  rmrf(remote);
});

const onRemote = (branch: string) =>
  cp
    .execFileSync("git", ["ls-remote", "--heads", "origin", branch], { cwd: repo })
    .toString()
    .trim();

describe("pushBranches", () => {
  it("pushes every branch and keeps going past one that cannot be pushed", async () => {
    git(["branch", "ship-a", "main"], repo);
    git(["branch", "ship-b", "main"], repo);

    const results = await pushBranches(simpleGit(repo), {
      // `missing` sits between the two so a failure in the middle is proven not
      // to strand the branch queued behind it.
      branchNames: ["ship-a", "missing", "ship-b"],
      remotes: ["origin"],
      forceMode: "normal"
    });

    expect(results.map((r) => [r.ref, r.status === null])).toEqual([
      ["ship-a", true],
      ["missing", false],
      ["ship-b", true]
    ]);
    expect(onRemote("ship-a")).not.toBe("");
    expect(onRemote("ship-b")).not.toBe("");
  });
});
