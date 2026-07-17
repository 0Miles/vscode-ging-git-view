import * as cp from "node:child_process";
import * as fs from "node:fs";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkoutBranch } from "@/backend/actions/branch";

import { git, makeRepo } from "@tests/backend/helpers";

let repo: string;

function currentBranch(cwd: string): string {
  return cp.execFileSync("git", ["branch", "--show-current"], { cwd }).toString().trim();
}

function rev(cwd: string, ref: string): string {
  return cp.execFileSync("git", ["rev-parse", ref], { cwd }).toString().trim();
}

beforeAll(() => {
  repo = makeRepo();
  git(["branch", "other"], repo);
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("checkoutBranch", () => {
  it("checks out an existing local branch", async () => {
    await checkoutBranch(simpleGit(repo), {
      branchName: "other",
      remoteBranch: null,
      force: false
    });
    expect(currentBranch(repo)).toBe("other");
  });

  it("checks back out to main", async () => {
    await checkoutBranch(simpleGit(repo), {
      branchName: "main",
      remoteBranch: null,
      force: false
    });
    expect(currentBranch(repo)).toBe("main");
  });

  it("creates and checks out a new branch from a start point", async () => {
    await checkoutBranch(simpleGit(repo), {
      branchName: "from-main",
      remoteBranch: "main",
      force: false
    });
    expect(currentBranch(repo)).toBe("from-main");

    git(["checkout", "main"], repo);
    git(["branch", "-d", "from-main"], repo);
  });

  it("throws when checking out a nonexistent branch", async () => {
    await expect(
      checkoutBranch(simpleGit(repo), {
        branchName: "nonexistent",
        remoteBranch: null,
        force: false
      })
    ).rejects.toThrow();
  });

  it("throws when the new branch name already exists", async () => {
    await expect(
      checkoutBranch(simpleGit(repo), {
        branchName: "other",
        remoteBranch: "main",
        force: false
      })
    ).rejects.toThrow();
  });

  it("force-resets an existing divergent local branch to its start point", async () => {
    // Create a "feature" branch with a local-only commit so it diverges from main.
    git(["checkout", "-b", "feature"], repo);
    fs.writeFileSync(`${repo}/feature-only`, "x");
    git(["add", "."], repo);
    git(["commit", "-m", "feature-only"], repo);
    git(["checkout", "main"], repo);

    const mainTip = rev(repo, "main");
    expect(rev(repo, "feature")).not.toBe(mainTip);

    // A plain checkout would throw because "feature" already exists; force uses
    // `checkout -B`, resetting it to the start point and checking it out.
    await checkoutBranch(simpleGit(repo), {
      branchName: "feature",
      remoteBranch: "main",
      force: true
    });

    expect(currentBranch(repo)).toBe("feature");
    expect(rev(repo, "feature")).toBe(mainTip);

    git(["checkout", "main"], repo);
    git(["branch", "-D", "feature"], repo);
  });
});
