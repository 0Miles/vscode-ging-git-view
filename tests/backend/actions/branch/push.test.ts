import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pushBranch } from "@/backend/actions/branch";

import { bareGit, git, makeRepo } from "@tests/backend/helpers";

let repo: string;
let remote: string;

beforeAll(() => {
  repo = makeRepo();
  remote = fs.mkdtempSync(path.join(os.tmpdir(), "neo-remote-"));
  cp.execFileSync("git", ["init", "--bare", "--initial-branch=main"], { cwd: remote });
  git(["remote", "add", "origin", remote], repo);
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(remote, { recursive: true, force: true });
});

describe("pushBranch", () => {
  it("pushes a local branch to the remote", async () => {
    await pushBranch(simpleGit(repo), {
      branchName: "main",
      remotes: ["origin"],
      forceMode: "normal"
    });

    const localHash = cp
      .execFileSync("git", ["rev-parse", "main"], { cwd: repo })
      .toString()
      .trim();
    const remoteHash = bareGit(["rev-parse", "main"], remote).trim();
    expect(remoteHash).toBe(localHash);
  });

  it("force-pushes a non-fast-forward update when force is true", async () => {
    // Rewrite local history so the push is no longer a fast-forward.
    fs.writeFileSync(path.join(repo, "amended.txt"), "amend");
    cp.execFileSync("git", ["add", "."], { cwd: repo });
    cp.execFileSync("git", ["commit", "--amend", "-m", "amended base"], { cwd: repo });
    const amendedHash = cp
      .execFileSync("git", ["rev-parse", "main"], { cwd: repo })
      .toString()
      .trim();

    // A normal push is rejected (non-fast-forward); a force push succeeds.
    await expect(
      pushBranch(simpleGit(repo), { branchName: "main", remotes: ["origin"], forceMode: "normal" })
    ).rejects.toThrow();
    await pushBranch(simpleGit(repo), {
      branchName: "main",
      remotes: ["origin"],
      forceMode: "force"
    });

    const remoteHash = bareGit(["rev-parse", "main"], remote).trim();
    expect(remoteHash).toBe(amendedHash);
  });

  it("throws when the remote does not exist", async () => {
    await expect(
      pushBranch(simpleGit(repo), {
        branchName: "main",
        remotes: ["no-such-remote"],
        forceMode: "normal"
      })
    ).rejects.toThrow();
  });
});
