import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTag } from "@/backend/actions/tag";

import { bareGit, makeRepo } from "@tests/backend/helpers";

let repo: string;
let commitHash: string;

beforeAll(() => {
  repo = makeRepo();
  commitHash = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("deleteTag", () => {
  it("deletes an existing tag", async () => {
    cp.execFileSync("git", ["tag", "v1.0", commitHash], { cwd: repo });

    await deleteTag(simpleGit(repo), { tagName: "v1.0", deleteOnRemote: null });

    const tags = cp.execFileSync("git", ["tag"], { cwd: repo }).toString().trim();
    expect(tags).not.toContain("v1.0");
  });

  it("throws when the tag does not exist", async () => {
    await expect(
      deleteTag(simpleGit(repo), { tagName: "nonexistent", deleteOnRemote: null })
    ).rejects.toThrow();
  });

  it("also deletes the tag on the remote when deleteOnRemote is set", async () => {
    const r = makeRepo();
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "neo-remote-"));
    try {
      cp.execFileSync("git", ["init", "--bare", "--initial-branch=main"], { cwd: remote });
      cp.execFileSync("git", ["remote", "add", "origin", remote], { cwd: r });
      const h = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: r }).toString().trim();
      cp.execFileSync("git", ["tag", "v2.0", h], { cwd: r });
      cp.execFileSync("git", ["push", "origin", "v2.0"], { cwd: r });
      expect(bareGit(["tag"], remote)).toContain("v2.0");

      await deleteTag(simpleGit(r), { tagName: "v2.0", deleteOnRemote: "origin" });

      expect(cp.execFileSync("git", ["tag"], { cwd: r }).toString()).not.toContain("v2.0");
      expect(bareGit(["tag"], remote)).not.toContain("v2.0");
    } finally {
      fs.rmSync(r, { recursive: true, force: true });
      fs.rmSync(remote, { recursive: true, force: true });
    }
  });
});
