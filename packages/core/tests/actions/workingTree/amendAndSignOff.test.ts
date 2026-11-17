import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { CommitRefusedError, commitChanges } from "@ging/core/backend/actions/workingTree";

import { git, makeRepo, makeTempDir, rejection, rmrf } from "@ging/core/tests/helpers";

// Amend and sign-off from the working tree panel (#407), on real git: what an
// amend takes in, when GING declines one before git runs, and the trailer
// `--signoff` writes.

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

/** This process's environment with `extra`, for a simple-git client: without
 *  the askpass, editor and config variables it refuses to run with (setup.ts's
 *  line-end pins are in each test repository's config too), nor an identity
 *  of the environment's own. */
function envWith(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/ASKPASS|EDITOR|^GIT_CONFIG_|^GIT_(AUTHOR|COMMITTER)_|^EMAIL$/.test(name)) {
      delete env[name];
    }
  }
  return { ...env, ...extra };
}
const head = (dir: string) => out(dir, "rev-parse", "HEAD").trim();
const message = (dir: string) => out(dir, "log", "-1", "--format=%B").trimEnd();
const short = (dir: string) => out(dir, "status", "--short", "--untracked-files=all").trimEnd();

/** The refusal `op` was declined with. */
async function refusal(op: Promise<unknown>) {
  const e = await rejection(op);
  expect(e).toBeInstanceOf(CommitRefusedError);
  return (e as CommitRefusedError).refusal;
}

/** `r` with a second commit, "Second", changing f; answers its parent. */
function secondCommit(r: string): string {
  const parent = head(r);
  fs.writeFileSync(path.join(r, "f"), "second");
  git(["commit", "-qam", "Second"], r);
  return parent;
}

describe("commitChanges with amend", () => {
  it("folds what is staged into HEAD, keeping its parent and its author", async () => {
    const r = repo();
    const parent = secondCommit(r);
    const author = out(r, "log", "-1", "--format=%an <%ae> %at").trim();
    fs.writeFileSync(path.join(r, "g"), "forgotten");
    fs.writeFileSync(path.join(r, "left"), "not staged");
    git(["add", "g"], r);

    await commitChanges(simpleGit(r), { message: "Second, whole", amend: true });

    expect(out(r, "rev-list", "--count", "HEAD").trim()).toBe("2");
    expect(out(r, "rev-parse", "HEAD~1").trim()).toBe(parent);
    expect(message(r)).toBe("Second, whole");
    expect(out(r, "show", "--name-only", "--format=", "HEAD").trim().split("\n")).toEqual([
      "f",
      "g"
    ]);
    expect(out(r, "log", "-1", "--format=%an <%ae> %at").trim()).toBe(author);
    expect(short(r)).toBe("?? left");
  });

  it("changes the message alone when nothing is staged", async () => {
    const r = repo();
    secondCommit(r);
    const tree = out(r, "rev-parse", "HEAD^{tree}").trim();

    await commitChanges(simpleGit(r), { message: "Second, better said", amend: true });

    expect(message(r)).toBe("Second, better said");
    expect(out(r, "rev-parse", "HEAD^{tree}").trim()).toBe(tree);
  });

  it("is made even when it makes the very same commit", async () => {
    const r = repo();
    const sameSecond = envWith({
      GIT_AUTHOR_DATE: "1700000000 +0000",
      GIT_COMMITTER_DATE: "1700000000 +0000"
    });
    fs.writeFileSync(path.join(r, "f"), "second");
    cp.execFileSync("git", ["commit", "-qam", "Second"], { cwd: r, env: sameSecond });
    const before = head(r);

    // The same message, tree and dates: HEAD does not move, yet git did
    // amend, as HEAD's reflog says.
    await commitChanges(simpleGit(r).env(sameSecond), { message: "Second", amend: true });

    expect(head(r)).toBe(before);
    expect(out(r, "reflog", "-1", "--format=%gs").trim()).toBe("commit (amend): Second");
  });

  it("is refused on a branch with no commit yet", async () => {
    const r = makeTempDir("ngg-test-");
    cleanUp.push(r);
    git(["init", "-q", "--template=", "-b", "main"], r);
    git(["config", "user.email", "t@t.com"], r);
    git(["config", "user.name", "T"], r);
    fs.writeFileSync(path.join(r, "a"), "a");
    git(["add", "a"], r);

    expect(await refusal(commitChanges(simpleGit(r), { message: "a", amend: true }))).toEqual({
      kind: "cannotAmend",
      reason: "unborn"
    });
    expect(short(r)).toBe("A  a");
  });

  describe("with an operation stopped on a conflict", () => {
    /** `main` and `feature` each changing shared.txt's one line. */
    function diverged(): string {
      const r = repo();
      fs.writeFileSync(path.join(r, "shared.txt"), "base\n");
      git(["add", "."], r);
      git(["commit", "-m", "base"], r);
      git(["checkout", "-q", "-b", "feature"], r);
      fs.writeFileSync(path.join(r, "shared.txt"), "feature\n");
      git(["commit", "-qam", "feature"], r);
      git(["checkout", "-q", "main"], r);
      fs.writeFileSync(path.join(r, "shared.txt"), "main\n");
      git(["commit", "-qam", "main change"], r);
      return r;
    }
    const stopsOnConflict = (args: string[], cwd: string) =>
      expect(cp.spawnSync("git", args, { cwd }).status).not.toBe(0);
    const gitDir = (r: string) => path.join(r, ".git");

    it.each([
      {
        reason: "merge" as const,
        start: (r: string) => stopsOnConflict(["merge", "feature"], r),
        marker: "MERGE_HEAD"
      },
      {
        reason: "rebase" as const,
        start: (r: string) => {
          git(["checkout", "-q", "feature"], r);
          stopsOnConflict(["rebase", "main"], r);
        },
        marker: "rebase-merge"
      },
      {
        reason: "cherrypick" as const,
        start: (r: string) => stopsOnConflict(["cherry-pick", "feature"], r),
        marker: "CHERRY_PICK_HEAD"
      }
    ])("is refused during a $reason, leaving HEAD and the $reason as they were", async (op) => {
      const r = diverged();
      op.start(r);
      const before = head(r);
      const unmerged = out(r, "ls-files", "-u");

      expect(
        await refusal(commitChanges(simpleGit(r), { message: "folded in", amend: true }))
      ).toEqual({ kind: "cannotAmend", reason: op.reason });

      expect(head(r)).toBe(before);
      expect(fs.existsSync(path.join(gitDir(r), op.marker))).toBe(true);
      expect(out(r, "ls-files", "-u")).toBe(unmerged);
    });
  });

  describe("of a commit already pushed", () => {
    /** `r` with a bare clone of it as `origin`, fetched: HEAD is on origin/main. */
    function pushed(): string {
      const r = repo();
      secondCommit(r);
      const bare = makeTempDir("ngg-test-bare-");
      cleanUp.push(bare);
      git(["clone", "-q", "--bare", r, bare], r);
      git(["remote", "add", "origin", bare], r);
      git(["fetch", "-q", "origin"], r);
      return r;
    }

    it("is refused, naming the remote branches, and changes nothing", async () => {
      const r = pushed();
      const before = head(r);
      fs.writeFileSync(path.join(r, "g"), "staged");
      git(["add", "g"], r);

      expect(
        await refusal(commitChanges(simpleGit(r), { message: "Rewritten", amend: true }))
      ).toEqual({ kind: "pushed", remoteBranches: ["origin/main"] });

      expect(head(r)).toBe(before);
      expect(short(r)).toBe("A  g");
    });

    it("is made once told to rewrite it", async () => {
      const r = pushed();
      const remote = out(r, "rev-parse", "origin/main").trim();

      await commitChanges(simpleGit(r), {
        message: "Rewritten",
        amend: true,
        rewritePushed: true
      });

      expect(message(r)).toBe("Rewritten");
      expect(head(r)).not.toBe(remote);
      // The remote-tracking branch is left where it was: only a push moves it.
      expect(out(r, "rev-parse", "origin/main").trim()).toBe(remote);
    });

    it("is not asked about when HEAD has moved past what was pushed", async () => {
      const r = pushed();
      fs.writeFileSync(path.join(r, "f"), "local only");
      git(["commit", "-qam", "Local only"], r);

      await commitChanges(simpleGit(r), { message: "Local, reworded", amend: true });

      expect(message(r)).toBe("Local, reworded");
    });
  });
});

describe("commitChanges with sign-off", () => {
  const trailers = (r: string) =>
    out(r, "log", "-1", "--format=%(trailers:key=Signed-off-by,valueonly)").trim().split("\n");

  it("signs a new commit off as the committer", async () => {
    const r = repo();
    fs.writeFileSync(path.join(r, "f"), "signed off");
    git(["add", "f"], r);

    await commitChanges(simpleGit(r), { message: "Signed off", signOff: true });

    expect(message(r)).toBe("Signed off\n\nSigned-off-by: T <t@t.com>");
  });

  it("adds no second trailer however many times the commit is amended signed off", async () => {
    const r = repo();
    secondCommit(r);

    await commitChanges(simpleGit(r), { message: "Second", amend: true, signOff: true });
    // As the panel would send it again: HEAD's message, trailer and all.
    await commitChanges(simpleGit(r), { message: message(r), amend: true, signOff: true });

    expect(trailers(r)).toEqual(["T <t@t.com>"]);
  });

  it("signs an amend with -S when signCommits is true", async () => {
    const r = repo();
    secondCommit(r);
    const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-key-"));
    cleanUp.push(keyDir);
    const keyPath = path.join(keyDir, "id");
    cp.execFileSync("ssh-keygen", ["-t", "ed25519", "-f", keyPath, "-N", "", "-q", "-C", "t"]);
    git(["config", "gpg.format", "ssh"], r);
    git(["config", "user.signingkey", keyPath + ".pub"], r);

    await commitChanges(simpleGit(r), { message: "Second, signed", amend: true }, true);

    expect(out(r, "cat-file", "commit", "HEAD")).toContain("-----BEGIN SSH SIGNATURE-----");
  });
});

describe("commitChanges without a known committer", () => {
  /** git with nobody's identity: no global or system config to find one in,
   *  none in the repository, and no guessing one from the machine. */
  function nobody(): { r: string; client: ReturnType<typeof simpleGit> } {
    const r = makeTempDir("ngg-test-");
    const home = makeTempDir("ngg-test-home-");
    cleanUp.push(r, home);
    git(["init", "-q", "--template=", "-b", "main"], r);
    git(["config", "user.useConfigOnly", "true"], r);
    git(["config", "commit.gpgsign", "false"], r);
    fs.writeFileSync(path.join(r, "a"), "a");
    git(["add", "a"], r);
    // Both places git reads a global config from, inside `home`; simple-git
    // will not hand git a GIT_CONFIG_GLOBAL, so they are named by HOME.
    fs.writeFileSync(path.join(home, ".gitconfig"), "");
    const client = simpleGit(r).env(
      envWith({
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        GIT_CONFIG_NOSYSTEM: "1"
      })
    );
    return { r, client };
  }

  it("is refused before git runs, for a commit or a sign-off, and makes none", async () => {
    const { r, client } = nobody();

    const refusals = await Promise.all(
      [{ message: "Anonymous" }, { message: "Anonymous", signOff: true }].map((input) =>
        rejection(commitChanges(client, input))
      )
    );
    for (const e of refusals) {
      expect(e).toBeInstanceOf(CommitRefusedError);
      expect((e as CommitRefusedError).refusal).toEqual({ kind: "identityUnknown" });
      // What git said, kept for the log: it was asked, and did not know.
      expect((e as Error).message).toMatch(/auto-detection is disabled/);
    }

    expect(
      cp.spawnSync("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: r }).status
    ).not.toBe(0);
    expect(short(r)).toBe("A  a");
  });
});
