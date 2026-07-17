import * as fs from "node:fs";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { renameStash } from "@/backend/actions/stash";
import { loadStashes } from "@/backend/queries/loadStashes";

import { git, makeRepo } from "@tests/backend/helpers";

const repos: string[] = [];
afterEach(() => {
  for (const dir of repos.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("renameStash (real git)", () => {
  it("changes the displayed message (commit subject) and keeps the stash applicable", async () => {
    const repo = makeRepo(); // committed file "f" = "x"
    repos.push(repo);
    fs.writeFileSync(path.join(repo, "f"), "changed");
    fs.writeFileSync(path.join(repo, "extra.txt"), "untracked");
    git(["stash", "push", "-u", "-m", "original"], repo);

    await renameStash(simpleGit(repo), { selector: "stash@{0}", message: "renamed-stash" });

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
});
