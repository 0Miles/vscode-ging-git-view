import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { gitClientFactory } from "@/backend/gitClient";
import { loadCommits } from "@/backend/queries/loadCommits";

import { git, makeRepo } from "@tests/backend/helpers";

let repo: string;
let repoWithRemote: string;
let remoteRepo: string;

beforeAll(() => {
  repo = makeRepo();
  fs.writeFileSync(path.join(repo, "f2"), "y");
  git(["add", "."], repo);
  git(["commit", "-m", "second"], repo);

  remoteRepo = makeRepo();
  repoWithRemote = makeRepo();
  git(["remote", "add", "origin", remoteRepo], repoWithRemote);
  git(["fetch", "origin"], repoWithRemote);
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(repoWithRemote, { recursive: true, force: true });
  fs.rmSync(remoteRepo, { recursive: true, force: true });
});

describe("loadCommits", () => {
  it("returns commits with expected fields", async () => {
    const result = await loadCommits(simpleGit(repo), {
      branchNames: [""],
      maxCommits: 300,
      showRemoteBranches: false,
      hard: false,
      dateType: "Author Date",
      showUncommittedChanges: false,
      commitOrder: "date",
      onlyFollowFirstParent: false,
      showUntrackedFiles: true,
      showCommitsOnlyReferencedByTags: true,
      showRemoteHeads: true,
      includeCommitsMentionedByReflogs: false,
      showSignatureStatus: false,
      showStashes: false,
      useMailmap: false,
      hiddenRemotes: []
    });
    expect(result).toEqual({
      commits: expect.any(Array),
      head: expect.any(String),
      moreCommitsAvailable: false,
      hard: false
    });
    expect(result.commits.length).toBeGreaterThan(0);
    expect(result.commits[0]).toEqual({
      hash: expect.any(String),
      parentHashes: expect.any(Array),
      author: expect.any(String),
      email: expect.any(String),
      date: expect.any(Number),
      message: expect.any(String),
      refs: expect.any(Array),
      signatureStatus: ""
    });
  });

  it("attaches HEAD ref to the current commit and sets head correctly", async () => {
    const result = await loadCommits(simpleGit(repo), {
      branchNames: [""],
      maxCommits: 300,
      showRemoteBranches: false,
      hard: false,
      dateType: "Author Date",
      showUncommittedChanges: false,
      commitOrder: "date",
      onlyFollowFirstParent: false,
      showUntrackedFiles: true,
      showCommitsOnlyReferencedByTags: true,
      showRemoteHeads: true,
      includeCommitsMentionedByReflogs: false,
      showSignatureStatus: false,
      showStashes: false,
      useMailmap: false,
      hiddenRemotes: []
    });
    expect(result.head).not.toBeNull();
    const headCommit = result.commits.find((c) => c.hash === result.head);
    expect(headCommit).toBeDefined();
    expect(headCommit!.refs.some((r) => r.type === "head")).toBe(true);
  });

  it("limits to maxCommits and sets moreCommitsAvailable: true", async () => {
    const result = await loadCommits(simpleGit(repo), {
      branchNames: [""],
      maxCommits: 1,
      showRemoteBranches: false,
      hard: false,
      dateType: "Author Date",
      showUncommittedChanges: false,
      commitOrder: "date",
      onlyFollowFirstParent: false,
      showUntrackedFiles: true,
      showCommitsOnlyReferencedByTags: true,
      showRemoteHeads: true,
      includeCommitsMentionedByReflogs: false,
      showSignatureStatus: false,
      showStashes: false,
      useMailmap: false,
      hiddenRemotes: []
    });
    expect(result).toEqual({
      commits: expect.any(Array),
      head: expect.any(String),
      moreCommitsAvailable: true,
      hard: false
    });
    expect(result.commits.length).toBe(1);
  });

  it("moreCommitsAvailable is false when all commits fit", async () => {
    const result = await loadCommits(simpleGit(repo), {
      branchNames: [""],
      maxCommits: 300,
      showRemoteBranches: false,
      hard: false,
      dateType: "Author Date",
      showUncommittedChanges: false,
      commitOrder: "date",
      onlyFollowFirstParent: false,
      showUntrackedFiles: true,
      showCommitsOnlyReferencedByTags: true,
      showRemoteHeads: true,
      includeCommitsMentionedByReflogs: false,
      showSignatureStatus: false,
      showStashes: false,
      useMailmap: false,
      hiddenRemotes: []
    });
    expect(result).toEqual({
      commits: expect.any(Array),
      head: expect.any(String),
      moreCommitsAvailable: false,
      hard: false
    });
  });

  it("filters commits to the given branch", async () => {
    const result = await loadCommits(simpleGit(repo), {
      branchNames: ["main"],
      maxCommits: 300,
      showRemoteBranches: false,
      hard: false,
      dateType: "Author Date",
      showUncommittedChanges: false,
      commitOrder: "date",
      onlyFollowFirstParent: false,
      showUntrackedFiles: true,
      showCommitsOnlyReferencedByTags: true,
      showRemoteHeads: true,
      includeCommitsMentionedByReflogs: false,
      showSignatureStatus: false,
      showStashes: false,
      useMailmap: false,
      hiddenRemotes: []
    });
    expect(result.commits.length).toBeGreaterThan(0);
  });

  it("prepends uncommitted-changes commit when working tree is dirty", async () => {
    const dirtyRepo = makeRepo();
    try {
      // Modify the tracked `f` so there is a non-untracked change to count.
      fs.writeFileSync(path.join(dirtyRepo, "f"), "modified");
      const result = await loadCommits(simpleGit(dirtyRepo), {
        branchNames: [""],
        maxCommits: 300,
        showRemoteBranches: false,
        hard: false,
        dateType: "Author Date",
        showUncommittedChanges: true,
        commitOrder: "date",
        onlyFollowFirstParent: false,
        showUntrackedFiles: true,
        showCommitsOnlyReferencedByTags: true,
        showRemoteHeads: true,
        includeCommitsMentionedByReflogs: false,
        showSignatureStatus: false,
        showStashes: false,
        useMailmap: false,
        hiddenRemotes: []
      });
      expect(result.commits[0]).toEqual({
        hash: "*",
        parentHashes: [result.head],
        author: "*",
        email: "",
        date: expect.any(Number),
        message: expect.stringMatching(/^Uncommitted Changes \(\d+\)$/),
        refs: [],
        signatureStatus: ""
      });
    } finally {
      fs.rmSync(dirtyRepo, { recursive: true, force: true });
    }
  });

  it("never counts untracked files toward uncommitted changes (even with showUntrackedFiles true)", async () => {
    const dirtyRepo = makeRepo();
    try {
      // Only an untracked file is present. The uncommitted-changes count tracks
      // staged + tracked changes only, so no row is added regardless of the
      // showUntrackedFiles setting.
      fs.writeFileSync(path.join(dirtyRepo, "untracked"), "z");
      const result = await loadCommits(simpleGit(dirtyRepo), {
        branchNames: [""],
        maxCommits: 300,
        showRemoteBranches: false,
        hard: false,
        dateType: "Author Date",
        showUncommittedChanges: true,
        commitOrder: "date",
        onlyFollowFirstParent: false,
        showUntrackedFiles: true,
        showCommitsOnlyReferencedByTags: true,
        showRemoteHeads: true,
        includeCommitsMentionedByReflogs: false,
        showSignatureStatus: false,
        showStashes: false,
        useMailmap: false,
        hiddenRemotes: []
      });
      expect(result.commits[0].hash).not.toBe("*");
    } finally {
      fs.rmSync(dirtyRepo, { recursive: true, force: true });
    }
  });

  it("does not prepend uncommitted-changes commit when showUncommittedChanges is false", async () => {
    const dirtyRepo = makeRepo();
    try {
      fs.writeFileSync(path.join(dirtyRepo, "untracked"), "z");
      const result = await loadCommits(simpleGit(dirtyRepo), {
        branchNames: [""],
        maxCommits: 300,
        showRemoteBranches: false,
        hard: false,
        dateType: "Author Date",
        showUncommittedChanges: false,
        commitOrder: "date",
        onlyFollowFirstParent: false,
        showUntrackedFiles: true,
        showCommitsOnlyReferencedByTags: true,
        showRemoteHeads: true,
        includeCommitsMentionedByReflogs: false,
        showSignatureStatus: false,
        showStashes: false,
        useMailmap: false,
        hiddenRemotes: []
      });
      expect(result.commits[0].hash).not.toBe("*");
    } finally {
      fs.rmSync(dirtyRepo, { recursive: true, force: true });
    }
  });

  it("does not include remote refs when showRemoteBranches is false", async () => {
    const result = await loadCommits(simpleGit(repoWithRemote), {
      branchNames: [""],
      maxCommits: 300,
      showRemoteBranches: false,
      hard: false,
      dateType: "Author Date",
      showUncommittedChanges: false,
      commitOrder: "date",
      onlyFollowFirstParent: false,
      showUntrackedFiles: true,
      showCommitsOnlyReferencedByTags: true,
      showRemoteHeads: true,
      includeCommitsMentionedByReflogs: false,
      showSignatureStatus: false,
      showStashes: false,
      useMailmap: false,
      hiddenRemotes: []
    });
    const allRefs = result.commits.flatMap((c) => c.refs);
    expect(allRefs.every((r) => r.type !== "remote")).toBe(true);
  });

  it("uses commit date when dateType is Commit Date", async () => {
    const result = await loadCommits(simpleGit(repo), {
      branchNames: [""],
      maxCommits: 300,
      showRemoteBranches: false,
      hard: false,
      dateType: "Commit Date",
      showUncommittedChanges: false,
      commitOrder: "date",
      onlyFollowFirstParent: false,
      showUntrackedFiles: true,
      showCommitsOnlyReferencedByTags: true,
      showRemoteHeads: true,
      includeCommitsMentionedByReflogs: false,
      showSignatureStatus: false,
      showStashes: false,
      useMailmap: false,
      hiddenRemotes: []
    });
    expect(result.commits.length).toBeGreaterThan(0);
    expect(result.commits[0].date).toBeGreaterThan(0);
  });

  it("passes hard flag through to the result", async () => {
    const result = await loadCommits(simpleGit(repo), {
      branchNames: [""],
      maxCommits: 300,
      showRemoteBranches: false,
      hard: true,
      dateType: "Author Date",
      showUncommittedChanges: false,
      commitOrder: "date",
      onlyFollowFirstParent: false,
      showUntrackedFiles: true,
      showCommitsOnlyReferencedByTags: true,
      showRemoteHeads: true,
      includeCommitsMentionedByReflogs: false,
      showSignatureStatus: false,
      showStashes: false,
      useMailmap: false,
      hiddenRemotes: []
    });
    expect(result).toEqual({
      commits: expect.any(Array),
      head: expect.any(String),
      moreCommitsAvailable: false,
      hard: true
    });
  });

  it("accepts a non-default commit ordering", async () => {
    const result = await loadCommits(simpleGit(repo), {
      branchNames: [""],
      maxCommits: 300,
      showRemoteBranches: false,
      hard: false,
      dateType: "Author Date",
      showUncommittedChanges: false,
      commitOrder: "topo",
      onlyFollowFirstParent: false,
      showUntrackedFiles: true,
      showCommitsOnlyReferencedByTags: true,
      showRemoteHeads: true,
      includeCommitsMentionedByReflogs: false,
      showSignatureStatus: false,
      showStashes: false,
      useMailmap: false,
      hiddenRemotes: []
    });
    expect(result.commits.length).toBeGreaterThan(0);
  });

  it("accepts onlyFollowFirstParent", async () => {
    const result = await loadCommits(simpleGit(repo), {
      branchNames: [""],
      maxCommits: 300,
      showRemoteBranches: false,
      hard: false,
      dateType: "Author Date",
      showUncommittedChanges: false,
      commitOrder: "date",
      onlyFollowFirstParent: true,
      showUntrackedFiles: true,
      showCommitsOnlyReferencedByTags: true,
      showRemoteHeads: true,
      includeCommitsMentionedByReflogs: false,
      showSignatureStatus: false,
      showStashes: false,
      useMailmap: false,
      hiddenRemotes: []
    });
    expect(result.commits.length).toBeGreaterThan(0);
  });

  it("remaps author names via .mailmap when useMailmap is true", async () => {
    const r = makeRepo();
    try {
      git(["config", "user.name", "Real Name"], r);
      git(["config", "user.email", "real@example.com"], r);
      fs.writeFileSync(path.join(r, "m.txt"), "x");
      git(["add", "."], r);
      git(["commit", "-m", "mailmap commit"], r);
      fs.writeFileSync(path.join(r, ".mailmap"), "Proper Name <real@example.com>\n");
      git(["add", "."], r);
      git(["commit", "-m", "add mailmap"], r);

      const input = {
        branchNames: [""],
        maxCommits: 300,
        showRemoteBranches: false,
        hard: false,
        dateType: "Author Date" as const,
        showUncommittedChanges: false,
        commitOrder: "date" as const,
        onlyFollowFirstParent: false,
        showUntrackedFiles: true,
        showCommitsOnlyReferencedByTags: true,
        showRemoteHeads: true,
        includeCommitsMentionedByReflogs: false,
        showSignatureStatus: false,
        showStashes: false,
        hiddenRemotes: []
      };
      const withMailmap = await loadCommits(simpleGit(r), { ...input, useMailmap: true });
      const without = await loadCommits(simpleGit(r), { ...input, useMailmap: false });

      const wm = withMailmap.commits.find((c) => c.message === "mailmap commit");
      const wo = without.commits.find((c) => c.message === "mailmap commit");
      expect(wo!.author).toBe("Real Name");
      expect(wm!.author).toBe("Proper Name");
    } finally {
      fs.rmSync(r, { recursive: true, force: true });
    }
  });

  it("loads a branch that shares its name with a file", async () => {
    const r = makeRepo();
    try {
      git(["checkout", "-b", "release"], r);
      fs.writeFileSync(path.join(r, "release"), "a file named like the branch");
      git(["add", "."], r);
      git(["commit", "-m", "add release file"], r);
      const result = await loadCommits(simpleGit(r), {
        branchNames: ["release"],
        maxCommits: 300,
        showRemoteBranches: false,
        hard: false,
        dateType: "Author Date",
        showUncommittedChanges: false,
        commitOrder: "date",
        onlyFollowFirstParent: false,
        showUntrackedFiles: true,
        showCommitsOnlyReferencedByTags: true,
        showRemoteHeads: true,
        includeCommitsMentionedByReflogs: false,
        showSignatureStatus: false,
        showStashes: false,
        useMailmap: false,
        hiddenRemotes: []
      });
      expect(result.commits.some((c) => c.message === "add release file")).toBe(true);
    } finally {
      fs.rmSync(r, { recursive: true, force: true });
    }
  });

  it("shows commits from every selected branch when several are given", async () => {
    const r = makeRepo(); // root commit on main ("init")
    try {
      // featureA (from root) adds "a-only"; featureB (from root) adds "b-only".
      git(["checkout", "-b", "featureA"], r);
      fs.writeFileSync(path.join(r, "a"), "a");
      git(["add", "."], r);
      git(["commit", "-m", "a-only commit"], r);
      git(["checkout", "main"], r);
      git(["checkout", "-b", "featureB"], r);
      fs.writeFileSync(path.join(r, "b"), "b");
      git(["add", "."], r);
      git(["commit", "-m", "b-only commit"], r);

      const base = {
        maxCommits: 300,
        showRemoteBranches: false,
        hard: false,
        dateType: "Author Date" as const,
        showUncommittedChanges: false,
        commitOrder: "date" as const,
        onlyFollowFirstParent: false,
        showUntrackedFiles: true,
        showCommitsOnlyReferencedByTags: true,
        showRemoteHeads: true,
        includeCommitsMentionedByReflogs: false,
        showSignatureStatus: false,
        showStashes: false,
        useMailmap: false,
        hiddenRemotes: []
      };

      // Selecting both branches shows the tip commits of each.
      const both = await loadCommits(simpleGit(r), {
        branchNames: ["featureA", "featureB"],
        ...base
      });
      const msgs = both.commits.map((c) => c.message);
      expect(msgs).toContain("a-only commit");
      expect(msgs).toContain("b-only commit");

      // Selecting only one branch excludes the other branch's tip.
      const onlyA = await loadCommits(simpleGit(r), { branchNames: ["featureA"], ...base });
      const onlyAMsgs = onlyA.commits.map((c) => c.message);
      expect(onlyAMsgs).toContain("a-only commit");
      expect(onlyAMsgs).not.toContain("b-only commit");
    } finally {
      fs.rmSync(r, { recursive: true, force: true });
    }
  });

  it("includes a detached HEAD commit not reachable from any branch", async () => {
    const r = makeRepo();
    try {
      git(["checkout", "-b", "temp"], r);
      fs.writeFileSync(path.join(r, "detached.txt"), "x");
      git(["add", "."], r);
      git(["commit", "-m", "detached-only commit"], r);
      const h = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: r }).toString().trim();
      git(["checkout", h], r); // detach HEAD onto the commit
      git(["branch", "-D", "temp"], r); // now reachable only via HEAD

      const result = await loadCommits(simpleGit(r), {
        branchNames: [""],
        maxCommits: 300,
        showRemoteBranches: false,
        hard: false,
        dateType: "Author Date",
        showUncommittedChanges: false,
        commitOrder: "date",
        onlyFollowFirstParent: false,
        showUntrackedFiles: true,
        showCommitsOnlyReferencedByTags: true,
        showRemoteHeads: true,
        includeCommitsMentionedByReflogs: false,
        showSignatureStatus: false,
        showStashes: false,
        useMailmap: false,
        hiddenRemotes: []
      });
      expect(result.commits.some((c) => c.message === "detached-only commit")).toBe(true);
    } finally {
      fs.rmSync(r, { recursive: true, force: true });
    }
  });

  it("includes/excludes tag-only commits per showCommitsOnlyReferencedByTags", async () => {
    const r = makeRepo();
    try {
      // Create a commit, tag it, then move the branch back so the tagged commit
      // is reachable only via the tag (not from any branch or HEAD).
      const base = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: r }).toString().trim();
      fs.writeFileSync(path.join(r, "tagged.txt"), "x");
      git(["add", "."], r);
      git(["commit", "-m", "tag-only commit"], r);
      git(["tag", "v-orphan"], r);
      git(["reset", "--hard", base], r);

      const baseInput = {
        branchNames: [""],
        maxCommits: 300,
        showRemoteBranches: false,
        hard: false,
        dateType: "Author Date" as const,
        showUncommittedChanges: false,
        commitOrder: "date" as const,
        onlyFollowFirstParent: false,
        showUntrackedFiles: true,
        showRemoteHeads: true,
        includeCommitsMentionedByReflogs: false,
        showSignatureStatus: false,
        showStashes: false,
        useMailmap: false,
        hiddenRemotes: []
      };

      const shown = await loadCommits(simpleGit(r), {
        ...baseInput,
        showCommitsOnlyReferencedByTags: true
      });
      expect(shown.commits.some((c) => c.message === "tag-only commit")).toBe(true);

      const hidden = await loadCommits(simpleGit(r), {
        ...baseInput,
        showCommitsOnlyReferencedByTags: false
      });
      expect(hidden.commits.some((c) => c.message === "tag-only commit")).toBe(false);
    } finally {
      fs.rmSync(r, { recursive: true, force: true });
    }
  });

  it("parses commits even when the user enables log.showSignature", async () => {
    const r = makeRepo();
    const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-sshkey-"));
    const keyPath = path.join(keyDir, "id");
    try {
      // An SSH-signed commit + log.showSignature=true makes plain `git log`
      // prepend signature-verification lines that would corrupt parsing; the
      // gitClient forces log.showSignature=false so parsing stays intact.
      cp.execFileSync("ssh-keygen", ["-t", "ed25519", "-f", keyPath, "-N", "", "-q", "-C", "t"]);
      git(["config", "gpg.format", "ssh"], r);
      git(["config", "user.signingkey", keyPath + ".pub"], r);
      git(["config", "commit.gpgsign", "true"], r);
      git(["config", "log.showSignature", "true"], r);
      fs.writeFileSync(path.join(r, "signed.txt"), "x");
      git(["add", "."], r);
      git(["commit", "-m", "signed commit"], r);

      const client = gitClientFactory(r, "git");
      const result = await loadCommits(client.getInstance(), {
        branchNames: [""],
        maxCommits: 300,
        showRemoteBranches: false,
        hard: false,
        dateType: "Author Date",
        showUncommittedChanges: false,
        commitOrder: "date",
        onlyFollowFirstParent: false,
        showUntrackedFiles: true,
        showCommitsOnlyReferencedByTags: true,
        showRemoteHeads: true,
        includeCommitsMentionedByReflogs: false,
        showSignatureStatus: false,
        showStashes: false,
        useMailmap: false,
        hiddenRemotes: []
      });
      expect(result.commits.some((c) => c.message === "signed commit")).toBe(true);
    } finally {
      fs.rmSync(r, { recursive: true, force: true });
      fs.rmSync(keyDir, { recursive: true, force: true });
    }
  });

  it("hides the remote HEAD ref when showRemoteHeads is false", async () => {
    const local = makeRepo();
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-bare-"));
    try {
      cp.execFileSync("git", ["init", "--bare", "--initial-branch=main"], { cwd: bare });
      git(["remote", "add", "origin", bare], local);
      git(["push", "origin", "main"], local);
      git(["fetch", "origin"], local);
      // Establish origin/HEAD -> origin/main so a "<remote>/HEAD" ref exists.
      git(["remote", "set-head", "origin", "main"], local);

      const base = {
        branchNames: [""],
        maxCommits: 300,
        showRemoteBranches: true,
        hard: false,
        dateType: "Author Date" as const,
        showUncommittedChanges: false,
        commitOrder: "date" as const,
        onlyFollowFirstParent: false,
        showUntrackedFiles: true,
        showCommitsOnlyReferencedByTags: true,
        includeCommitsMentionedByReflogs: false,
        showSignatureStatus: false,
        showStashes: false,
        useMailmap: false,
        hiddenRemotes: []
      };
      const shown = await loadCommits(simpleGit(local), { ...base, showRemoteHeads: true });
      expect(
        shown.commits.some((c) =>
          c.refs.some((ref) => ref.type === "remote" && ref.name.endsWith("/HEAD"))
        )
      ).toBe(true);

      const hidden = await loadCommits(simpleGit(local), { ...base, showRemoteHeads: false });
      expect(
        hidden.commits.some((c) =>
          c.refs.some((ref) => ref.type === "remote" && ref.name.endsWith("/HEAD"))
        )
      ).toBe(false);
      // The actual remote branch ref is still present.
      expect(hidden.commits.some((c) => c.refs.some((ref) => ref.name === "origin/main"))).toBe(
        true
      );
    } finally {
      fs.rmSync(local, { recursive: true, force: true });
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it("includes reflog-only commits per includeCommitsMentionedByReflogs", async () => {
    const r = makeRepo();
    try {
      // Commit then hard-reset away from it, so it is reachable only via reflog.
      const base = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: r }).toString().trim();
      fs.writeFileSync(path.join(r, "orphan.txt"), "x");
      git(["add", "."], r);
      git(["commit", "-m", "reflog-only commit"], r);
      git(["reset", "--hard", base], r);

      const baseInput = {
        branchNames: [""],
        maxCommits: 300,
        showRemoteBranches: false,
        hard: false,
        dateType: "Author Date" as const,
        showUncommittedChanges: false,
        commitOrder: "date" as const,
        onlyFollowFirstParent: false,
        showUntrackedFiles: true,
        showCommitsOnlyReferencedByTags: true,
        showRemoteHeads: true,
        showSignatureStatus: false,
        showStashes: false,
        useMailmap: false,
        hiddenRemotes: []
      };

      const without = await loadCommits(simpleGit(r), {
        ...baseInput,
        includeCommitsMentionedByReflogs: false
      });
      expect(without.commits.some((c) => c.message === "reflog-only commit")).toBe(false);

      const withReflog = await loadCommits(simpleGit(r), {
        ...baseInput,
        includeCommitsMentionedByReflogs: true
      });
      expect(withReflog.commits.some((c) => c.message === "reflog-only commit")).toBe(true);
    } finally {
      fs.rmSync(r, { recursive: true, force: true });
    }
  });

  it("filters to branches matching a glob: pattern", async () => {
    const r = makeRepo();
    try {
      // initial commit is on main; add a main-only commit, and a feature branch
      // forked from the initial commit (so the main-only commit isn't shared).
      const base = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: r }).toString().trim();
      fs.writeFileSync(path.join(r, "main.txt"), "m");
      git(["add", "."], r);
      git(["commit", "-m", "main-only commit"], r);
      git(["checkout", "-b", "feature/x", base], r);
      fs.writeFileSync(path.join(r, "feat.txt"), "f");
      git(["add", "."], r);
      git(["commit", "-m", "feature-x commit"], r);
      git(["checkout", "main"], r);

      const result = await loadCommits(simpleGit(r), {
        branchNames: ["glob:feature/*"],
        maxCommits: 300,
        showRemoteBranches: false,
        hard: false,
        dateType: "Author Date",
        showUncommittedChanges: false,
        commitOrder: "date",
        onlyFollowFirstParent: false,
        showUntrackedFiles: true,
        showCommitsOnlyReferencedByTags: true,
        showRemoteHeads: true,
        includeCommitsMentionedByReflogs: false,
        showSignatureStatus: false,
        showStashes: false,
        useMailmap: false,
        hiddenRemotes: []
      });
      expect(result.commits.some((c) => c.message === "feature-x commit")).toBe(true);
      expect(result.commits.some((c) => c.message === "main-only commit")).toBe(false);
    } finally {
      fs.rmSync(r, { recursive: true, force: true });
    }
  });

  it("reports a signature status only when showSignatureStatus is set", async () => {
    const r = makeRepo();
    const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-sigkey-"));
    const keyPath = path.join(keyDir, "id");
    try {
      cp.execFileSync("ssh-keygen", ["-t", "ed25519", "-f", keyPath, "-N", "", "-q", "-C", "t"]);
      git(["config", "gpg.format", "ssh"], r);
      git(["config", "user.signingkey", keyPath + ".pub"], r);
      git(["config", "commit.gpgsign", "true"], r);
      // An allowed-signers entry lets git actually verify the signature (-> "G").
      const pub = fs.readFileSync(keyPath + ".pub", "utf8").trim();
      const allowedSigners = path.join(keyDir, "allowed_signers");
      fs.writeFileSync(allowedSigners, `t@t.com ${pub}\n`);
      git(["config", "gpg.ssh.allowedSignersFile", allowedSigners], r);
      fs.writeFileSync(path.join(r, "signed.txt"), "x");
      git(["add", "."], r);
      git(["commit", "-m", "signed commit"], r);

      const baseInput = {
        branchNames: [""],
        maxCommits: 300,
        showRemoteBranches: false,
        hard: false,
        dateType: "Author Date" as const,
        showUncommittedChanges: false,
        commitOrder: "date" as const,
        onlyFollowFirstParent: false,
        showUntrackedFiles: true,
        showCommitsOnlyReferencedByTags: true,
        showRemoteHeads: true,
        includeCommitsMentionedByReflogs: false,
        showStashes: false,
        useMailmap: false,
        hiddenRemotes: []
      };

      const off = await loadCommits(simpleGit(r), { ...baseInput, showSignatureStatus: false });
      expect(off.commits.find((c) => c.message === "signed commit")?.signatureStatus).toBe("");

      const on = await loadCommits(simpleGit(r), { ...baseInput, showSignatureStatus: true });
      const signed = on.commits.find((c) => c.message === "signed commit");
      // With the signer trusted, git reports a good signature ("G").
      expect(signed?.signatureStatus).toBe("G");
    } finally {
      fs.rmSync(r, { recursive: true, force: true });
      fs.rmSync(keyDir, { recursive: true, force: true });
    }
  });

  it("includes stashes as nodes with a stash ref only when showStashes is set", async () => {
    const r = makeRepo();
    try {
      fs.writeFileSync(path.join(r, "f"), "changed");
      git(["stash", "push", "-m", "WIP work"], r);
      const stashHash = cp
        .execFileSync("git", ["rev-parse", "stash@{0}"], { cwd: r })
        .toString()
        .trim();

      const baseInput = {
        branchNames: [""],
        maxCommits: 300,
        showRemoteBranches: false,
        hard: false,
        dateType: "Author Date" as const,
        showUncommittedChanges: false,
        commitOrder: "date" as const,
        onlyFollowFirstParent: false,
        showUntrackedFiles: true,
        showCommitsOnlyReferencedByTags: true,
        showRemoteHeads: true,
        includeCommitsMentionedByReflogs: false,
        showSignatureStatus: false,
        useMailmap: false,
        hiddenRemotes: []
      };

      const without = await loadCommits(simpleGit(r), { ...baseInput, showStashes: false });
      expect(without.commits.some((c) => c.hash === stashHash)).toBe(false);

      const withStashes = await loadCommits(simpleGit(r), { ...baseInput, showStashes: true });
      const stashNode = withStashes.commits.find((c) => c.hash === stashHash);
      expect(stashNode).toBeDefined();
      expect(stashNode!.refs.some((ref) => ref.type === "stash")).toBe(true);
    } finally {
      fs.rmSync(r, { recursive: true, force: true });
    }
  });

  it("keeps a stash above its base commit even when their dates disagree (no graph freeze)", async () => {
    // Regression: the stash date is always its committer date (%ct), but commits
    // use the author date (%at) under dateType "Author Date". A base commit with
    // a far-future author date therefore sorts *after* the (now-dated) stash, so
    // a naive date-based insertion drops the stash below its own base. That makes
    // the stash's only parent point upward in the list, which the graph layout
    // (parents are assumed below their children) can't walk — it spins forever
    // and freezes the webview. loadCommits must clamp the stash above its base.
    const r = makeRepo();
    try {
      // Base commit with a far-future *author* date (committer date too, so it is
      // still HEAD); the stash created on it gets a normal, much earlier %ct.
      fs.writeFileSync(path.join(r, "a.txt"), "a");
      cp.execFileSync("git", ["add", "."], { cwd: r });
      cp.execFileSync("git", ["commit", "-m", "future-dated base"], {
        cwd: r,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2099-01-01T00:00:00",
          GIT_COMMITTER_DATE: "2099-01-01T00:00:00"
        }
      });
      const baseHash = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: r }).toString().trim();
      fs.writeFileSync(path.join(r, "a.txt"), "a-modified");
      cp.execFileSync("git", ["stash", "push", "-m", "WIP work"], { cwd: r });
      const stashHash = cp
        .execFileSync("git", ["rev-parse", "stash@{0}"], { cwd: r })
        .toString()
        .trim();

      const result = await loadCommits(simpleGit(r), {
        branchNames: [""],
        maxCommits: 300,
        showRemoteBranches: false,
        hard: false,
        dateType: "Author Date",
        showUncommittedChanges: false,
        commitOrder: "date",
        onlyFollowFirstParent: false,
        showUntrackedFiles: true,
        showCommitsOnlyReferencedByTags: true,
        showRemoteHeads: true,
        includeCommitsMentionedByReflogs: false,
        showSignatureStatus: false,
        showStashes: true,
        useMailmap: false,
        hiddenRemotes: []
      });

      const stashIdx = result.commits.findIndex((c) => c.hash === stashHash);
      const baseIdx = result.commits.findIndex((c) => c.hash === baseHash);
      expect(stashIdx).toBeGreaterThanOrEqual(0);
      expect(baseIdx).toBeGreaterThanOrEqual(0);
      // The stash must sit above (a lower index than) its base, and list it as parent.
      expect(stashIdx).toBeLessThan(baseIdx);
      expect(result.commits[stashIdx].parentHashes).toContain(baseHash);
    } finally {
      fs.rmSync(r, { recursive: true, force: true });
    }
  });

  it("hides the branches of remotes listed in hiddenRemotes", async () => {
    const r = makeRepo();
    try {
      // Simulate two remotes via remote-tracking refs, each with a unique commit.
      git(["update-ref", "refs/remotes/origin/main", "HEAD"], r);
      git(["checkout", "-b", "feat"], r);
      fs.writeFileSync(path.join(r, "u"), "u");
      git(["add", "."], r);
      git(["commit", "-m", "upstream only commit"], r);
      const upstreamHash = cp
        .execFileSync("git", ["rev-parse", "HEAD"], { cwd: r })
        .toString()
        .trim();
      git(["update-ref", "refs/remotes/upstream/feat", "HEAD"], r);
      git(["checkout", "main"], r);
      git(["branch", "-D", "feat"], r);

      const input = {
        branchNames: [""],
        maxCommits: 300,
        showRemoteBranches: true,
        hard: false,
        dateType: "Author Date" as const,
        showUncommittedChanges: false,
        commitOrder: "date" as const,
        onlyFollowFirstParent: false,
        showUntrackedFiles: true,
        showCommitsOnlyReferencedByTags: true,
        showRemoteHeads: true,
        includeCommitsMentionedByReflogs: false,
        showSignatureStatus: false,
        showStashes: false,
        useMailmap: false,
        hiddenRemotes: []
      };

      const all = await loadCommits(simpleGit(r), input);
      expect(all.commits.some((c) => c.hash === upstreamHash)).toBe(true);

      const hidden = await loadCommits(simpleGit(r), { ...input, hiddenRemotes: ["upstream"] });
      // The upstream-only commit and its ref label are excluded.
      expect(hidden.commits.some((c) => c.hash === upstreamHash)).toBe(false);
      const labels = hidden.commits.flatMap((c) => c.refs.map((ref) => ref.name));
      expect(labels).not.toContain("upstream/feat");
      expect(labels).toContain("origin/main"); // other remote still shown
    } finally {
      fs.rmSync(r, { recursive: true, force: true });
    }
  });
});
