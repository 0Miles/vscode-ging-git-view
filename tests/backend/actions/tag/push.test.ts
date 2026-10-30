import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pushTag } from "@/backend/actions/tag";
import { formatGitError } from "@/backend/utils/gitError";

import { bareGit, makeRepo, rmrf } from "@tests/backend/helpers";

let repo: string;
let bare: string;

beforeAll(() => {
  repo = makeRepo();

  bare = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-test-bare-"));
  cp.execFileSync("git", ["init", "--bare", bare]);
  cp.execFileSync("git", ["remote", "add", "origin", bare], { cwd: repo });
  cp.execFileSync("git", ["push", "origin", "main"], { cwd: repo });

  cp.execFileSync("git", ["tag", "v1.0"], { cwd: repo });
});

afterAll(() => {
  rmrf(repo);
  rmrf(bare);
});

describe("pushTag", () => {
  it("pushes an existing tag to origin", async () => {
    await pushTag(simpleGit(repo), { tagName: "v1.0", remotes: ["origin"] });

    const tags = bareGit(["tag", "-l"], bare).trim();
    expect(tags).toBe("v1.0");
  });

  it("throws when the tag does not exist locally", async () => {
    await expect(
      pushTag(simpleGit(repo), { tagName: "v99.0-nonexistent", remotes: ["origin"] })
    ).rejects.toThrow();
  });
});

// Each remote is pushed and heard from on its own, as `pushBranch` does since
// #264: stopping at the first refusal named one remote and answered while the
// others were still pushing.
async function rejection(push: Promise<void>): Promise<unknown> {
  try {
    await push;
  } catch (e: unknown) {
    return e;
  }
  throw new Error("expected the push to be rejected");
}

describe("pushTag to several remotes", () => {
  it("still pushes to every other remote, and reports the one refusal as it is", async () => {
    cp.execFileSync("git", ["tag", "v2.0"], { cwd: repo });

    const error = await rejection(
      pushTag(simpleGit(repo), { tagName: "v2.0", remotes: ["no-such-remote", "origin"] })
    );

    expect(bareGit(["tag", "-l", "v2.0"], bare).trim()).toBe("v2.0");
    expect(formatGitError(error)).not.toMatch(/^no-such-remote: /);
  });

  it("reports every remote that refused, each under its own name", async () => {
    cp.execFileSync("git", ["tag", "v3.0"], { cwd: repo });

    const error = await rejection(
      pushTag(simpleGit(repo), { tagName: "v3.0", remotes: ["gone-a", "gone-b"] })
    );

    expect(formatGitError(error).split("\n")).toEqual([
      expect.stringMatching(/^gone-a: /),
      expect.stringMatching(/^gone-b: /)
    ]);
  });
});
