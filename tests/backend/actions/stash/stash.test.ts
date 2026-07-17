import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { applyStash, dropStash, popStash } from "@/backend/actions/stash";

import { git, makeRepo } from "@tests/backend/helpers";

let repo: string;

afterEach(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

function stashListLength(): number {
  const out = cp.execFileSync("git", ["stash", "list"], { cwd: repo }).toString().trim();
  return out === "" ? 0 : out.split("\n").length;
}

describe("stash actions", () => {
  it("applies a stash, leaving it in the list and restoring the change", async () => {
    repo = makeRepo();
    fs.writeFileSync(path.join(repo, "f"), "changed");
    git(["stash", "push", "-m", "wip"], repo);
    expect(fs.readFileSync(path.join(repo, "f"), "utf8")).toBe("x"); // change stashed away

    await applyStash(simpleGit(repo), { selector: "stash@{0}", reinstateIndex: false });

    expect(fs.readFileSync(path.join(repo, "f"), "utf8")).toBe("changed");
    expect(stashListLength()).toBe(1); // apply keeps the stash
  });

  it("pops a stash, removing it from the list", async () => {
    repo = makeRepo();
    fs.writeFileSync(path.join(repo, "f"), "changed");
    git(["stash", "push", "-m", "wip"], repo);

    await popStash(simpleGit(repo), { selector: "stash@{0}", reinstateIndex: false });

    expect(fs.readFileSync(path.join(repo, "f"), "utf8")).toBe("changed");
    expect(stashListLength()).toBe(0); // pop removes the stash
  });

  it("drops a stash without touching the working tree", async () => {
    repo = makeRepo();
    fs.writeFileSync(path.join(repo, "f"), "changed");
    git(["stash", "push", "-m", "wip"], repo);

    await dropStash(simpleGit(repo), { selector: "stash@{0}" });

    expect(stashListLength()).toBe(0);
    expect(fs.readFileSync(path.join(repo, "f"), "utf8")).toBe("x"); // change not restored
  });

  it("throws for a non-existent stash", async () => {
    repo = makeRepo();
    await expect(dropStash(simpleGit(repo), { selector: "stash@{9}" })).rejects.toThrow();
  });
});
