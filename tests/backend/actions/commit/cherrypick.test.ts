import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cherrypickCommit } from "@/backend/actions/commit";

import { git, makeRepo } from "@tests/backend/helpers";

let repo: string;
let cherrypickHash: string;

beforeAll(() => {
  repo = makeRepo();
  git(["checkout", "-b", "side"], repo);
  fs.writeFileSync(path.join(repo, "g"), "cherry");
  git(["add", "."], repo);
  git(["commit", "-m", "cherry commit"], repo);
  cherrypickHash = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
  git(["checkout", "main"], repo);
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("cherrypickCommit", () => {
  it("cherry-picks a commit onto the current branch", async () => {
    await cherrypickCommit(simpleGit(repo), {
      commitHash: cherrypickHash,
      parentIndex: 0,
      noCommit: false,
      recordOrigin: false
    });
    expect(fs.existsSync(path.join(repo, "g"))).toBe(true);
  });

  it("stages changes without committing when noCommit is true", async () => {
    const r = makeRepo();
    try {
      git(["checkout", "-b", "side"], r);
      fs.writeFileSync(path.join(r, "h"), "x");
      git(["add", "."], r);
      git(["commit", "-m", "side commit"], r);
      const h = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: r }).toString().trim();
      git(["checkout", "main"], r);
      const headBefore = cp
        .execFileSync("git", ["rev-parse", "HEAD"], { cwd: r })
        .toString()
        .trim();

      await cherrypickCommit(simpleGit(r), {
        commitHash: h,
        parentIndex: 0,
        noCommit: true,
        recordOrigin: false
      });

      const headAfter = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: r }).toString().trim();
      expect(headAfter).toBe(headBefore); // no new commit
      const staged = cp
        .execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: r })
        .toString();
      expect(staged).toContain("h"); // change is staged
    } finally {
      fs.rmSync(r, { recursive: true, force: true });
    }
  });

  it("throws for a nonexistent commit hash", async () => {
    await expect(
      cherrypickCommit(simpleGit(repo), {
        commitHash: "0000000000000000000000000000000000000000",
        parentIndex: 0,
        noCommit: false,
        recordOrigin: false
      })
    ).rejects.toThrow();
  });

  it("signs the cherry-picked commit when signCommits is true", async () => {
    const r = makeRepo();
    // Keep the signing key OUTSIDE the repo so `git add .` can't commit it.
    const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-key-"));
    try {
      const keyPath = path.join(keyDir, "id");
      cp.execFileSync("ssh-keygen", ["-t", "ed25519", "-f", keyPath, "-N", "", "-q", "-C", "t"]);
      git(["config", "gpg.format", "ssh"], r);
      git(["config", "user.signingkey", keyPath + ".pub"], r);
      git(["checkout", "-b", "side"], r);
      fs.writeFileSync(path.join(r, "p"), "pick me");
      git(["add", "."], r);
      git(["commit", "-m", "to cherry pick"], r);
      const hash = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: r }).toString().trim();
      git(["checkout", "main"], r);

      await cherrypickCommit(
        simpleGit(r),
        { commitHash: hash, parentIndex: 0, noCommit: false, recordOrigin: false },
        true
      );

      // The resulting commit carries an SSH signature (gpgsig header).
      const obj = cp.execFileSync("git", ["cat-file", "commit", "HEAD"], { cwd: r }).toString();
      expect(obj).toContain("-----BEGIN SSH SIGNATURE-----");
    } finally {
      fs.rmSync(r, { recursive: true, force: true });
      fs.rmSync(keyDir, { recursive: true, force: true });
    }
  });
});
