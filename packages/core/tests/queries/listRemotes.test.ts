import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { listRemotes } from "@ging/core/backend/queries/listRemotes";

import { git, makeRepo, rmrf } from "@ging/core/tests/helpers";

let repo: string;

afterEach(() => {
  if (repo) rmrf(repo);
});

describe("listRemotes", () => {
  it("lists no remotes for a repo that has none", async () => {
    repo = makeRepo();
    expect(await listRemotes(simpleGit(repo))).toEqual([]);
  });

  it("gives a remote its fetch URL as its push URL when it has no other", async () => {
    repo = makeRepo();
    git(["remote", "add", "origin", "https://example.com/a.git"], repo);
    git(["remote", "add", "upstream", "https://example.com/b.git"], repo);
    expect(await listRemotes(simpleGit(repo))).toEqual([
      {
        name: "origin",
        fetchUrl: "https://example.com/a.git",
        pushUrl: "https://example.com/a.git"
      },
      {
        name: "upstream",
        fetchUrl: "https://example.com/b.git",
        pushUrl: "https://example.com/b.git"
      }
    ]);
  });

  it("tells a push URL apart from the fetch URL", async () => {
    repo = makeRepo();
    git(["remote", "add", "origin", "https://example.com/a.git"], repo);
    git(["remote", "set-url", "--push", "origin", "git@example.com:a.git"], repo);
    expect(await listRemotes(simpleGit(repo))).toEqual([
      { name: "origin", fetchUrl: "https://example.com/a.git", pushUrl: "git@example.com:a.git" }
    ]);
  });

  it("rejects when git cannot read the repo", async () => {
    repo = makeRepo();
    const client = simpleGit(repo);
    rmrf(repo);
    await expect(listRemotes(client)).rejects.toThrow();
  });
});
