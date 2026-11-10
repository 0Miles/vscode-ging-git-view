import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { renameStash, StashMovedError } from "@ging/core/backend/actions/stash";
import { loadStashes } from "@ging/core/backend/queries/loadStashes";

import { git, makeRepo, pushTwoStashes, rejection, rev, rmrf } from "@ging/core/tests/helpers";

const repos: string[] = [];
afterEach(() => {
  for (const dir of repos.splice(0)) rmrf(dir);
});

describe("renameStash (real git)", () => {
  it("changes the displayed message (commit subject) and keeps the stash applicable", async () => {
    const repo = makeRepo(); // committed file "f" = "x"
    repos.push(repo);
    fs.writeFileSync(path.join(repo, "f"), "changed");
    fs.writeFileSync(path.join(repo, "extra.txt"), "untracked");
    git(["stash", "push", "-u", "-m", "original"], repo);

    await renameStash(simpleGit(repo), {
      selector: "stash@{0}",
      expectedHash: rev(repo, "stash@{0}"),
      message: "renamed-stash"
    });

    // loadStashes reads the commit subject (%s) — the field shown in the graph.
    const stashes = await loadStashes(simpleGit(repo));
    expect(stashes).toHaveLength(1);
    expect(stashes[0].message).toBe("renamed-stash");

    // The rebuilt commit keeps the stash structure, so it still applies the
    // tracked change and the untracked file.
    git(["stash", "apply", "stash@{0}"], repo);
    expect(fs.readFileSync(path.join(repo, "f"), "utf8")).toBe("changed");
    expect(fs.existsSync(path.join(repo, "extra.txt"))).toBe(true);
  });

  it("refuses to rename the stash that inherited the number, leaving the stack as it was", async () => {
    const repo = makeRepo();
    repos.push(repo);
    const { older } = pushTwoStashes(repo);

    const error = await rejection(
      renameStash(simpleGit(repo), {
        selector: "stash@{0}",
        expectedHash: older,
        message: "renamed-stash"
      })
    );

    expect(error).toBeInstanceOf(StashMovedError);
    const stashes = await loadStashes(simpleGit(repo));
    expect(stashes.map((s) => s.message)).toEqual(["On main: newer", "On main: older"]);
  });
});
