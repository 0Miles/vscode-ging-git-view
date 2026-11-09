import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { fetchFromRemotes, fetchRemote, listRemoteNames } from "@/backend/actions/fetch";

import { git, makeRepo, rmrf } from "@tests/backend/helpers";

let repo: string;
let bare: string;
let other: string;

afterEach(() => {
  for (const d of [repo, bare, other]) if (d) rmrf(d);
});

describe("fetchFromRemotes", () => {
  it("updates remote-tracking branches from the remote", async () => {
    repo = makeRepo();
    bare = fs.mkdtempSync(path.join(os.tmpdir(), "neo-bare-"));
    cp.execFileSync("git", ["init", "--bare", "--initial-branch=main"], { cwd: bare });
    git(["remote", "add", "origin", bare], repo);
    git(["push", "origin", "main"], repo);

    // Another clone advances main on the remote.
    other = fs.mkdtempSync(path.join(os.tmpdir(), "neo-other-"));
    cp.execFileSync("git", ["clone", bare, other]);
    cp.execFileSync("git", ["config", "user.email", "o@o.com"], { cwd: other });
    cp.execFileSync("git", ["config", "user.name", "O"], { cwd: other });
    fs.writeFileSync(path.join(other, "x"), "x");
    cp.execFileSync("git", ["add", "."], { cwd: other });
    cp.execFileSync("git", ["commit", "-m", "remote commit"], { cwd: other });
    cp.execFileSync("git", ["push", "origin", "main"], { cwd: other });

    await fetchFromRemotes(simpleGit(repo), { prune: false, pruneTags: false });

    const log = cp
      .execFileSync("git", ["log", "--oneline", "origin/main"], { cwd: repo })
      .toString();
    expect(log).toContain("remote commit");
  });

  // Pruning is on out of the box (#34), so this is the combination nearly every
  // fetch runs: branches get swept, tags are left where they are. `--prune-tags`
  // is one setting away from firing for everyone, and a deleted tag costs more
  // than a deleted tracking ref, so pin that it stays out of the argv.
  it("prunes deleted remote-tracking branches but keeps tags when only prune is set", async () => {
    repo = makeRepo();
    bare = fs.mkdtempSync(path.join(os.tmpdir(), "neo-bare-"));
    cp.execFileSync("git", ["init", "--bare", "--initial-branch=main"], { cwd: bare });
    git(["remote", "add", "origin", bare], repo);
    git(["push", "origin", "main"], repo);
    git(["push", "origin", "main:gone"], repo); // create origin/gone
    git(["tag", "v-gone"], repo);
    git(["push", "origin", "v-gone"], repo);
    git(["fetch", "origin"], repo);
    // Both the branch and the tag now vanish from the remote.
    cp.execFileSync("git", ["push", "origin", "--delete", "gone"], { cwd: repo });
    cp.execFileSync("git", ["push", "origin", "--delete", "v-gone"], { cwd: repo });

    // Without pruning the stale remote-tracking ref lingers; pruning removes it.
    await fetchFromRemotes(simpleGit(repo), { prune: true, pruneTags: false });

    const refs = cp.execFileSync("git", ["branch", "-r"], { cwd: repo }).toString();
    expect(refs).not.toContain("origin/gone");
    const tags = cp.execFileSync("git", ["tag", "-l"], { cwd: repo }).toString();
    expect(tags).toContain("v-gone");
  });

  it("fetches a single named remote and lists remote names", async () => {
    repo = makeRepo();
    bare = fs.mkdtempSync(path.join(os.tmpdir(), "neo-bare-"));
    cp.execFileSync("git", ["init", "--bare", "--initial-branch=main"], { cwd: bare });
    git(["remote", "add", "upstream", bare], repo);
    git(["push", "upstream", "main"], repo);

    other = fs.mkdtempSync(path.join(os.tmpdir(), "neo-other-"));
    cp.execFileSync("git", ["clone", bare, other]);
    cp.execFileSync("git", ["config", "user.email", "o@o.com"], { cwd: other });
    cp.execFileSync("git", ["config", "user.name", "O"], { cwd: other });
    fs.writeFileSync(path.join(other, "x"), "x");
    cp.execFileSync("git", ["add", "."], { cwd: other });
    cp.execFileSync("git", ["commit", "-m", "remote commit"], { cwd: other });
    cp.execFileSync("git", ["push", "origin", "main"], { cwd: other }); // `other`'s remote is origin

    expect(await listRemoteNames(simpleGit(repo))).toContain("upstream");

    await fetchRemote(simpleGit(repo), { remote: "upstream", prune: false, pruneTags: false });

    const log = cp
      .execFileSync("git", ["log", "--oneline", "upstream/main"], { cwd: repo })
      .toString();
    expect(log).toContain("remote commit");
  });
});
