import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { loadRemotes } from "@/backend/queries/loadRemotes";

import { git, makeRepo, rmrf } from "@tests/backend/helpers";

let repo: string;
let bare: string;

afterEach(() => {
  if (repo) rmrf(repo);
  if (bare) rmrf(bare);
});

function addRemote(name: string) {
  bare = fs.mkdtempSync(path.join(os.tmpdir(), `neo-${name}-`));
  cp.execFileSync("git", ["init", "--bare"], { cwd: bare });
  git(["remote", "add", name, bare], repo);
}

describe("loadRemotes", () => {
  it("returns the configured remotes", async () => {
    repo = makeRepo();
    addRemote("origin");
    const result = await loadRemotes(simpleGit(repo));
    expect(result.remotes).toContain("origin");
  });

  it("reports pushDefault as null when remote.pushDefault is unset", async () => {
    repo = makeRepo();
    addRemote("origin");
    const result = await loadRemotes(simpleGit(repo));
    expect(result.pushDefault).toBeNull();
  });

  it("reports the configured remote.pushDefault", async () => {
    repo = makeRepo();
    addRemote("upstream");
    git(["config", "remote.pushDefault", "upstream"], repo);
    const result = await loadRemotes(simpleGit(repo));
    expect(result.pushDefault).toBe("upstream");
  });
});
