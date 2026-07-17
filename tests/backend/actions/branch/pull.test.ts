import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pullBranch } from "@/backend/actions/branch";

import { git, makeRepo } from "@tests/backend/helpers";

let repo: string;
let remote: string;
let other: string;

beforeAll(() => {
  repo = makeRepo();
  remote = fs.mkdtempSync(path.join(os.tmpdir(), "neo-remote-"));
  cp.execFileSync("git", ["init", "--bare", "--initial-branch=main"], { cwd: remote });
  git(["remote", "add", "origin", remote], repo);
  git(["push", "origin", "main"], repo);

  // A second clone advances main on the remote so there's something to pull.
  other = fs.mkdtempSync(path.join(os.tmpdir(), "neo-other-"));
  cp.execFileSync("git", ["clone", remote, other]);
  cp.execFileSync("git", ["config", "user.email", "other@example.com"], { cwd: other });
  cp.execFileSync("git", ["config", "user.name", "Other"], { cwd: other });
  fs.writeFileSync(path.join(other, "upstream.txt"), "upstream");
  cp.execFileSync("git", ["add", "."], { cwd: other });
  cp.execFileSync("git", ["commit", "-m", "upstream commit"], { cwd: other });
  cp.execFileSync("git", ["push", "origin", "main"], { cwd: other });
});

afterAll(() => {
  for (const dir of [repo, remote, other]) fs.rmSync(dir, { recursive: true, force: true });
});

describe("pullBranch", () => {
  it("pulls remote commits into the current branch", async () => {
    await pullBranch(simpleGit(repo), { remote: "origin", branchName: "main" });

    const log = cp.execFileSync("git", ["log", "--oneline"], { cwd: repo }).toString();
    expect(log).toContain("upstream commit");
    expect(fs.existsSync(path.join(repo, "upstream.txt"))).toBe(true);
  });

  it("throws when the remote does not exist", async () => {
    await expect(
      pullBranch(simpleGit(repo), { remote: "no-such-remote", branchName: "main" })
    ).rejects.toThrow();
  });
});
