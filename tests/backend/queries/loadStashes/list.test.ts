import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { loadStashes } from "@/backend/queries/loadStashes";

import { git, makeRepo } from "@tests/backend/helpers";

let repo: string;

afterEach(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

describe("loadStashes", () => {
  it("returns an empty list when there are no stashes", async () => {
    repo = makeRepo();
    expect(await loadStashes(simpleGit(repo))).toEqual([]);
  });

  it("lists stashes with their base commit, selector, message and date", async () => {
    repo = makeRepo();
    const base = (await simpleGit(repo).revparse(["HEAD"])).trim();
    // Make a tracked change and stash it.
    fs.writeFileSync(path.join(repo, "f"), "changed");
    git(["stash", "push", "-m", "WIP: my change"], repo);

    const stashes = await loadStashes(simpleGit(repo));
    expect(stashes.length).toBe(1);
    expect(stashes[0].selector).toBe("stash@{0}");
    expect(stashes[0].baseHash).toBe(base);
    expect(stashes[0].hash).toMatch(/^[0-9a-f]{40}$/);
    expect(stashes[0].message).toContain("my change");
    expect(typeof stashes[0].date).toBe("number");
  });

  it("lists multiple stashes newest-first", async () => {
    repo = makeRepo();
    fs.writeFileSync(path.join(repo, "f"), "a");
    git(["stash", "push", "-m", "first"], repo);
    fs.writeFileSync(path.join(repo, "f"), "b");
    git(["stash", "push", "-m", "second"], repo);

    const stashes = await loadStashes(simpleGit(repo));
    expect(stashes.map((s) => s.selector)).toEqual(["stash@{0}", "stash@{1}"]);
    expect(stashes[0].message).toContain("second");
  });
});
