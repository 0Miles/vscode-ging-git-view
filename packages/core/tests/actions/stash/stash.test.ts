import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyStash,
  dropStash,
  popStash,
  StashMovedError,
  stashSelectorResolvesTo
} from "@ging/core/backend/actions/stash";

import { git, makeRepo, pushTwoStashes, rejection, rev, rmrf } from "@ging/core/tests/helpers";

let repo: string;

afterEach(() => {
  if (repo) rmrf(repo);
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

    await applyStash(simpleGit(repo), {
      selector: "stash@{0}",
      expectedHash: rev(repo, "stash@{0}"),
      reinstateIndex: false
    });

    expect(fs.readFileSync(path.join(repo, "f"), "utf8")).toBe("changed");
    expect(stashListLength()).toBe(1); // apply keeps the stash
  });

  it("pops a stash, removing it from the list", async () => {
    repo = makeRepo();
    fs.writeFileSync(path.join(repo, "f"), "changed");
    git(["stash", "push", "-m", "wip"], repo);

    await popStash(simpleGit(repo), {
      selector: "stash@{0}",
      expectedHash: rev(repo, "stash@{0}"),
      reinstateIndex: false
    });

    expect(fs.readFileSync(path.join(repo, "f"), "utf8")).toBe("changed");
    expect(stashListLength()).toBe(0); // pop removes the stash
  });

  it("drops a stash without touching the working tree", async () => {
    repo = makeRepo();
    fs.writeFileSync(path.join(repo, "f"), "changed");
    git(["stash", "push", "-m", "wip"], repo);

    await dropStash(simpleGit(repo), {
      selector: "stash@{0}",
      expectedHash: rev(repo, "stash@{0}")
    });

    expect(stashListLength()).toBe(0);
    expect(fs.readFileSync(path.join(repo, "f"), "utf8")).toBe("x"); // change not restored
  });

  describe("when the stack has moved since the selector was read", () => {
    function pushTwo() {
      repo = makeRepo();
      return pushTwoStashes(repo);
    }

    /** The stack, top first, as commit SHAs. */
    function stack(): string[] {
      const out = cp
        .execFileSync("git", ["stash", "list", "--format=%H"], { cwd: repo })
        .toString()
        .trim();
      return out === "" ? [] : out.split("\n");
    }

    it("refuses to drop the stash that inherited the number, leaving both", async () => {
      const { older, newer } = pushTwo();

      const error = await rejection(
        dropStash(simpleGit(repo), { selector: "stash@{0}", expectedHash: older })
      );

      expect(error).toBeInstanceOf(StashMovedError);
      expect(stack()).toEqual([newer, older]);
    });

    // A pop that landed would apply someone else's work over the user's, then
    // drop it; an apply would do the first half.
    it.each([
      ["apply", applyStash],
      ["pop", popStash]
    ] as const)(
      "refuses to %s the stash that inherited the number, touching nothing",
      async (_, action) => {
        const { older, newer } = pushTwo();

        const error = await rejection(
          action(simpleGit(repo), {
            selector: "stash@{0}",
            expectedHash: older,
            reinstateIndex: false
          })
        );

        expect(error).toBeInstanceOf(StashMovedError);
        expect(stack()).toEqual([newer, older]);
        expect(fs.readFileSync(path.join(repo, "f"), "utf8")).toBe("x"); // nothing applied
      }
    );

    it("acts on the stash when the hash still matches its new number", async () => {
      const { older, newer } = pushTwo();

      await dropStash(simpleGit(repo), { selector: "stash@{1}", expectedHash: older });

      expect(stack()).toEqual([newer]);
    });
  });

  it("refuses a selector past the end of the stack as a stash that moved", async () => {
    repo = makeRepo();
    // The stash this was about was dropped elsewhere, and the stack shrank
    // under its number: the selector resolves to nothing at all.
    const error = await rejection(
      dropStash(simpleGit(repo), { selector: "stash@{9}", expectedHash: rev(repo, "HEAD") })
    );
    expect(error).toBeInstanceOf(StashMovedError);
  });

  it("reports a git failure as git's, not as a stash that moved", async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ging-not-a-repo-"));

    const error = await rejection(
      dropStash(simpleGit(repo), { selector: "stash@{0}", expectedHash: "0".repeat(40) })
    );

    expect(error).not.toBeInstanceOf(StashMovedError);
    expect(String(error)).toMatch(/not a git repository/);
  });
});

describe("stashSelectorResolvesTo", () => {
  it("holds while the selector still names the stash", async () => {
    repo = makeRepo();
    const { newer } = pushTwoStashes(repo);
    expect(await stashSelectorResolvesTo(simpleGit(repo), "stash@{0}", newer)).toBe(true);
  });

  it("fails once a newer push moved the stash, without throwing", async () => {
    repo = makeRepo();
    const { older } = pushTwoStashes(repo);
    expect(await stashSelectorResolvesTo(simpleGit(repo), "stash@{0}", older)).toBe(false);
  });

  it("fails once the selector names nothing", async () => {
    repo = makeRepo();
    const { older } = pushTwoStashes(repo);
    expect(await stashSelectorResolvesTo(simpleGit(repo), "stash@{2}", older)).toBe(false);
  });
});
