import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { abortOperation, continueOperation } from "@/backend/actions/operation";
import { detectOperation } from "@/backend/queries/operationState";

import { git, makeRepo } from "@tests/backend/helpers";

const repos: string[] = [];
afterEach(() => {
  for (const dir of repos.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// Mirror the extension's gitClient: GIT_EDITOR=true (so --continue never opens
// an editor) needs unsafe.allowUnsafeEditor.
const client = (repo: string) =>
  simpleGit({ baseDir: repo, unsafe: { allowUnsafeEditor: true } }).env("GIT_EDITOR", "true");

const conflictGit = (args: string[], cwd: string): void => {
  try {
    cp.execFileSync("git", args, { cwd, stdio: "pipe" });
  } catch {
    /* expected conflict */
  }
};

// main and feature both change f's only line, so rebasing one onto the other
// conflicts and pauses (leaving .git/rebase-merge).
function makeRebaseConflict(): string {
  const repo = makeRepo();
  repos.push(repo);
  fs.writeFileSync(path.join(repo, "f"), "base\n");
  git(["commit", "-am", "base"], repo);
  git(["checkout", "-b", "feature"], repo);
  fs.writeFileSync(path.join(repo, "f"), "feature\n");
  git(["commit", "-am", "feature"], repo);
  git(["checkout", "main"], repo);
  fs.writeFileSync(path.join(repo, "f"), "main\n");
  git(["commit", "-am", "main"], repo);
  git(["checkout", "feature"], repo);
  conflictGit(["rebase", "main"], repo);
  return repo;
}

describe("rebase operation actions (real git)", () => {
  it("abortOperation aborts an in-progress rebase", async () => {
    const repo = makeRebaseConflict();
    expect(await detectOperation(simpleGit(repo))).toBe("rebase");
    await abortOperation(client(repo));
    expect(await detectOperation(simpleGit(repo))).toBeNull(); // rebase-merge gone
    expect(fs.existsSync(path.join(repo, ".git", "rebase-merge"))).toBe(false);
    // Back on feature with its content restored.
    expect(fs.readFileSync(path.join(repo, "f"), "utf8")).toBe("feature\n");
  });

  it("continueOperation finishes a rebase once conflicts are resolved", async () => {
    const repo = makeRebaseConflict();
    fs.writeFileSync(path.join(repo, "f"), "resolved\n");
    git(["add", "f"], repo);
    await continueOperation(client(repo));
    expect(await detectOperation(simpleGit(repo))).toBeNull(); // rebase completed
  });
});
