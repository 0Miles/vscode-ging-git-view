import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { fetchFromRemotes, fetchRemote, listRemoteNames } from "@/backend/actions/fetch";

import { git, makeRepo } from "@tests/backend/helpers";

let repo: string;
let bare: string;
let other: string;

afterEach(() => {
  for (const d of [repo, bare, other]) if (d) fs.rmSync(d, { recursive: true, force: true });
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

  it("prunes deleted remote-tracking branches when prune is set", async () => {
    repo = makeRepo();
    bare = fs.mkdtempSync(path.join(os.tmpdir(), "neo-bare-"));
    cp.execFileSync("git", ["init", "--bare", "--initial-branch=main"], { cwd: bare });
    git(["remote", "add", "origin", bare], repo);
    git(["push", "origin", "main"], repo);
    git(["push", "origin", "main:gone"], repo); // create origin/gone
    git(["fetch", "origin"], repo);
    cp.execFileSync("git", ["push", "origin", "--delete", "gone"], { cwd: repo });

    // Without pruning the stale remote-tracking ref lingers; pruning removes it.
    await fetchFromRemotes(simpleGit(repo), { prune: true, pruneTags: false });

    const refs = cp.execFileSync("git", ["branch", "-r"], { cwd: repo }).toString();
    expect(refs).not.toContain("origin/gone");
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
