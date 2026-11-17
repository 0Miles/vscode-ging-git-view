import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { commitChanges, stageFiles, unstageFiles } from "@ging/core/backend/actions/workingTree";

import { git, makeRepo, makeTempDir, rmrf } from "@ging/core/tests/helpers";

const cleanUp: string[] = [];
afterEach(() => {
  cleanUp.splice(0).forEach(rmrf);
});

function repo(): string {
  const dir = makeRepo();
  cleanUp.push(dir);
  return dir;
}

const out = (dir: string, ...args: string[]) =>
  cp.execFileSync("git", args, { cwd: dir }).toString();
/** `git status --short`, one line per file. */
const short = (dir: string) => out(dir, "status", "--short", "--untracked-files=all").trimEnd();

describe("stageFiles", () => {
  it("stages a changed, a new and a deleted file whole, and nothing else", async () => {
    const r = repo();
    fs.writeFileSync(path.join(r, "g"), "g");
    git(["add", "g"], r);
    git(["commit", "-qm", "g"], r);
    fs.writeFileSync(path.join(r, "f"), "changed");
    fs.writeFileSync(path.join(r, "new"), "new");
    fs.rmSync(path.join(r, "g"));
    fs.writeFileSync(path.join(r, "left"), "left alone");

    await stageFiles(simpleGit(r), ["f", "new", "g"]);

    expect(short(r)).toBe(["M  f", "D  g", "A  new", "?? left"].join("\n"));
  });

  it("stages more files than a Windows command line holds", async () => {
    const r = repo();
    // Some 70,000 characters of paths: past the 32,767 of a Windows command
    // line, which is why they go through a pathspec file. Few files, long
    // names: writing files is what costs here.
    const dir = "a-folder-whose-name-is-long-enough-to-count";
    const names = Array.from(
      { length: 700 },
      (_, i) => `${dir}/a-file-whose-name-is-long-enough-to-count-as-well-${i}.txt`
    );
    expect(names.join(" ").length).toBeGreaterThan(65_000);
    fs.mkdirSync(path.join(r, dir));
    for (const name of names) fs.writeFileSync(path.join(r, name), "x");

    await stageFiles(simpleGit(r), names);

    expect(out(r, "diff", "--cached", "--name-only").trim().split("\n")).toHaveLength(700);
  });

  it("stages nothing for no paths", async () => {
    const r = repo();
    fs.writeFileSync(path.join(r, "f"), "changed");

    await stageFiles(simpleGit(r), []);

    expect(short(r)).toBe(" M f");
  });

  it("takes a path as written, not as a pattern", async () => {
    const r = repo();
    fs.writeFileSync(path.join(r, "a.txt"), "a");
    // A name `*` is legal outside Windows only; a bracket matches there too.
    fs.writeFileSync(path.join(r, "[ab].txt"), "literal");
    fs.writeFileSync(path.join(r, "b.txt"), "b");

    await stageFiles(simpleGit(r), ["[ab].txt"]);

    expect(short(r)).toBe(["A  [ab].txt", "?? a.txt", "?? b.txt"].join("\n"));
  });
});

describe("unstageFiles", () => {
  it("takes a file out of the index and leaves the working tree as it was", async () => {
    const r = repo();
    fs.writeFileSync(path.join(r, "f"), "changed");
    fs.writeFileSync(path.join(r, "new"), "new");
    git(["add", "."], r);

    await unstageFiles(simpleGit(r), ["f"]);

    expect(short(r)).toBe([" M f", "A  new"].join("\n"));
    expect(fs.readFileSync(path.join(r, "f"), "utf8")).toBe("changed");
  });

  it("unstages a staged rename by both its paths", async () => {
    const r = repo();
    git(["mv", "f", "moved"], r);

    await unstageFiles(simpleGit(r), ["moved", "f"]);

    expect(short(r)).toBe([" D f", "?? moved"].join("\n"));
  });

  it("unstages every file named", async () => {
    const r = repo();
    fs.writeFileSync(path.join(r, "f"), "changed");
    fs.writeFileSync(path.join(r, "new"), "new");
    git(["add", "."], r);

    await unstageFiles(simpleGit(r), ["f", "new"]);

    expect(short(r)).toBe([" M f", "?? new"].join("\n"));
  });

  it("unstages on a branch with no commit yet", async () => {
    const r = makeTempDir("ngg-test-");
    cleanUp.push(r);
    git(["init", "-q", "--template=", "-b", "main"], r);
    fs.writeFileSync(path.join(r, "a"), "a");
    fs.writeFileSync(path.join(r, "b"), "b");
    git(["add", "."], r);

    await unstageFiles(simpleGit(r), ["a"]);
    expect(short(r)).toBe(["A  b", "?? a"].join("\n"));

    await unstageFiles(simpleGit(r), ["b"]);
    expect(short(r)).toBe(["?? a", "?? b"].join("\n"));
  });
});

describe("during a merge stopped on a conflict", () => {
  /** A merge of `side` into main that conflicts on f and brings g cleanly,
   *  with a change of the user's own to h besides. */
  function conflictedMerge(): string {
    const r = repo();
    fs.writeFileSync(path.join(r, "h"), "h");
    git(["add", "h"], r);
    git(["commit", "-qm", "h"], r);
    git(["checkout", "-q", "-b", "side"], r);
    fs.writeFileSync(path.join(r, "f"), "side");
    fs.writeFileSync(path.join(r, "g"), "from side");
    git(["add", "."], r);
    git(["commit", "-qm", "side"], r);
    git(["checkout", "-q", "main"], r);
    fs.writeFileSync(path.join(r, "f"), "main");
    git(["commit", "-qam", "main"], r);
    expect(cp.spawnSync("git", ["merge", "side"], { cwd: r }).status).not.toBe(0);
    fs.writeFileSync(path.join(r, "h"), "the user's own change");
    return r;
  }
  const mergeHead = (r: string) => fs.existsSync(path.join(r, ".git", "MERGE_HEAD"));
  const unmerged = (r: string) => out(r, "ls-files", "-u").trim();

  it("Stage All and Unstage All, conflicted file named too, leave the merge and its conflict as they were", async () => {
    const r = conflictedMerge();
    const conflictBefore = unmerged(r);
    expect(conflictBefore).not.toBe("");

    // Everything the panel would name, the conflicted file included: it must
    // not reach `add`, which would mark it resolved.
    await stageFiles(simpleGit(r), ["h", "f"]);
    expect(mergeHead(r)).toBe(true);
    expect(unmerged(r)).toBe(conflictBefore);
    expect(short(r)).toBe(["UU f", "A  g", "M  h"].join("\n"));

    // Nor `reset`, which with no path would drop MERGE_HEAD — the merge itself.
    await unstageFiles(simpleGit(r), ["g", "h", "f"]);
    expect(mergeHead(r)).toBe(true);
    expect(unmerged(r)).toBe(conflictBefore);
    expect(short(r)).toBe(["UU f", " M h", "?? g"].join("\n"));
  });
});

describe("commitChanges", () => {
  it("is refused by a failing pre-commit hook, with what the hook said, and makes no commit", async () => {
    const r = repo();
    const head = out(r, "rev-parse", "HEAD");
    const hooks = path.join(r, ".git", "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(
      path.join(hooks, "pre-commit"),
      "#!/bin/sh\necho 'lint says no: f is not formatted' >&2\nexit 1\n",
      { mode: 0o755 }
    );
    fs.writeFileSync(path.join(r, "f"), "unformatted");
    git(["add", "f"], r);

    await expect(commitChanges(simpleGit(r), { message: "Hooked" })).rejects.toThrow(
      /lint says no: f is not formatted/
    );
    expect(out(r, "rev-parse", "HEAD")).toBe(head);
    // Still staged, for the next try.
    expect(short(r)).toBe("M  f");
  });

  it("commits what is staged, and only that, with the message as written", async () => {
    const r = repo();
    fs.writeFileSync(path.join(r, "f"), "committed");
    fs.writeFileSync(path.join(r, "left"), "not staged");
    git(["add", "f"], r);
    const message = "Subject line\n\nA body, over\ntwo lines.";

    await commitChanges(simpleGit(r), { message });

    expect(out(r, "log", "-1", "--format=%B").trimEnd()).toBe(message);
    expect(out(r, "show", "--name-only", "--format=", "HEAD").trim()).toBe("f");
    expect(short(r)).toBe("?? left");
  });

  it("is refused with nothing staged, and makes no commit", async () => {
    const r = repo();
    const head = out(r, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(r, "f"), "not staged");

    // Said by git on stdout alone, which simple-git does not take for a failure.
    await expect(commitChanges(simpleGit(r), { message: "nothing" })).rejects.toThrow(
      /no changes added to commit/
    );
    expect(out(r, "rev-parse", "HEAD")).toBe(head);
  });

  it("makes a branch's first commit", async () => {
    const r = makeTempDir("ngg-test-");
    cleanUp.push(r);
    git(["init", "-q", "--template=", "-b", "main"], r);
    git(["config", "user.email", "t@t.com"], r);
    git(["config", "user.name", "T"], r);
    git(["config", "commit.gpgsign", "false"], r);
    fs.writeFileSync(path.join(r, "a"), "a");
    await stageFiles(simpleGit(r), ["a"]);

    await commitChanges(simpleGit(r), { message: "First" });

    expect(out(r, "log", "--format=%s").trim()).toBe("First");
  });

  it("lands in a clone of a bare repository, one commit ahead of it", async () => {
    const seed = repo();
    const bare = makeTempDir("ngg-test-bare-");
    const clone = makeTempDir("ngg-test-clone-");
    cleanUp.push(bare, clone);
    git(["clone", "-q", "--bare", seed, bare], seed);
    git(["clone", "-q", bare, clone], seed);
    fs.appendFileSync(
      path.join(clone, ".git", "config"),
      "[user]\n\temail = t@t.com\n\tname = T\n[commit]\n\tgpgsign = false\n"
    );
    fs.writeFileSync(path.join(clone, "f"), "from the clone");
    await stageFiles(simpleGit(clone), ["f"]);

    await commitChanges(simpleGit(clone), { message: "From the clone" });

    expect(out(clone, "rev-list", "--count", "origin/main..HEAD").trim()).toBe("1");
  });

  describe("signing", () => {
    /** A repository set up to sign with a fresh SSH key, kept outside it. */
    function signingRepo(): string {
      const r = repo();
      const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-key-"));
      cleanUp.push(keyDir);
      const keyPath = path.join(keyDir, "id");
      cp.execFileSync("ssh-keygen", ["-t", "ed25519", "-f", keyPath, "-N", "", "-q", "-C", "t"]);
      git(["config", "gpg.format", "ssh"], r);
      git(["config", "user.signingkey", keyPath + ".pub"], r);
      fs.writeFileSync(path.join(r, "f"), "signed or not");
      git(["add", "f"], r);
      return r;
    }
    const signed = (r: string) =>
      out(r, "cat-file", "commit", "HEAD").includes("-----BEGIN SSH SIGNATURE-----");

    it("signs with -S when signCommits is true", async () => {
      const r = signingRepo();

      await commitChanges(simpleGit(r), { message: "signed" }, true);

      expect(signed(r)).toBe(true);
    });

    it("adds no flag when signCommits is false: git's commit.gpgsign decides", async () => {
      const r = signingRepo();

      // gpgsign = false from the test repository's config: not signed.
      await commitChanges(simpleGit(r), { message: "unsigned" }, false);
      expect(signed(r)).toBe(false);

      // gpgsign = true: signed, so no --no-gpg-sign overrode it.
      git(["config", "commit.gpgsign", "true"], r);
      fs.writeFileSync(path.join(r, "f"), "again");
      git(["add", "f"], r);
      await commitChanges(simpleGit(r), { message: "signed by config" }, false);
      expect(signed(r)).toBe(true);
    });
  });
});
