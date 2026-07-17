import * as cp from "node:child_process";
import * as fs from "node:fs";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import {
  addRemote,
  getRemoteUrl,
  removeRemote,
  renameRemote,
  setRemoteUrl
} from "@/backend/actions/remote";

import { makeRepo } from "@tests/backend/helpers";

let repo: string;

afterEach(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

function remoteList(): string {
  return cp.execFileSync("git", ["remote"], { cwd: repo }).toString().trim();
}

describe("remote management actions", () => {
  it("adds a remote with a URL", async () => {
    repo = makeRepo();
    await addRemote(simpleGit(repo), { name: "origin", url: "https://example.com/repo.git" });
    expect(remoteList()).toBe("origin");
    expect(await getRemoteUrl(simpleGit(repo), "origin")).toBe("https://example.com/repo.git");
  });

  it("changes a remote's URL", async () => {
    repo = makeRepo();
    await addRemote(simpleGit(repo), { name: "origin", url: "https://example.com/a.git" });
    await setRemoteUrl(simpleGit(repo), { name: "origin", url: "https://example.com/b.git" });
    expect(await getRemoteUrl(simpleGit(repo), "origin")).toBe("https://example.com/b.git");
  });

  it("renames a remote", async () => {
    repo = makeRepo();
    await addRemote(simpleGit(repo), { name: "origin", url: "https://example.com/a.git" });
    await renameRemote(simpleGit(repo), { oldName: "origin", newName: "upstream" });
    expect(remoteList()).toBe("upstream");
  });

  it("removes a remote", async () => {
    repo = makeRepo();
    await addRemote(simpleGit(repo), { name: "origin", url: "https://example.com/a.git" });
    await removeRemote(simpleGit(repo), { name: "origin" });
    expect(remoteList()).toBe("");
  });

  it("returns an empty URL for an unknown remote", async () => {
    repo = makeRepo();
    expect(await getRemoteUrl(simpleGit(repo), "nope")).toBe("");
  });

  it("throws when adding a remote that already exists", async () => {
    repo = makeRepo();
    await addRemote(simpleGit(repo), { name: "origin", url: "https://example.com/a.git" });
    await expect(
      addRemote(simpleGit(repo), { name: "origin", url: "https://example.com/b.git" })
    ).rejects.toThrow();
  });
});
