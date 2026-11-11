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
  StashApplyError,
  stashApplyFacts,
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

    it("applies the agreed stash even when a push lands between the check and the apply", async () => {
      repo = makeRepo();
      fs.writeFileSync(path.join(repo, "f"), "older");
      git(["stash", "push", "-m", "older"], repo);
      const older = rev(repo, "stash@{0}");
      let pushed = "";
      // A push from elsewhere — the terminal, a `pull --autostash` — landing
      // right after the check passed, before `stash apply` spawns.
      const real = simpleGit(repo);
      const racing = {
        raw: async (args: string[]) => {
          const out = await real.raw(args);
          if (args[0] === "rev-parse" && pushed === "") {
            fs.writeFileSync(path.join(repo, "f"), "pushed");
            git(["stash", "push", "-m", "pushed"], repo);
            pushed = rev(repo, "stash@{0}");
          }
          return out;
        }
      } as unknown as Parameters<typeof applyStash>[0];

      await applyStash(racing, {
        selector: "stash@{0}",
        expectedHash: older,
        reinstateIndex: false
      });

      expect(fs.readFileSync(path.join(repo, "f"), "utf8")).toBe("older");
      expect(stack()).toEqual([pushed, older]);
    });

    // Pins the check in front of the apply-by-SHA: `git stash` takes an
    // all-digit argument as a stash number, so without it this hash would
    // apply `stash@{0}`.
    it("refuses an expected hash the selector does not resolve to, touching nothing", async () => {
      const { older, newer } = pushTwo();

      const error = await rejection(
        applyStash(simpleGit(repo), {
          selector: "stash@{0}",
          expectedHash: "0".repeat(40),
          reinstateIndex: false
        })
      );

      expect(error).toBeInstanceOf(StashMovedError);
      expect(stack()).toEqual([newer, older]);
      expect(fs.readFileSync(path.join(repo, "f"), "utf8")).toBe("x");
    });

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

/**
 * #337: how an apply or pop that did not go through is told apart — by the
 * unmerged paths before and after, never by what git printed.
 */
describe("apply and pop that do not go through", () => {
  /** The stack, top first, as `stash@{n} <SHA>`. */
  function stashList(): string[] {
    const out = cp
      .execFileSync("git", ["stash", "list", "--format=%gd %H"], { cwd: repo })
      .toString()
      .trim();
    return out === "" ? [] : out.split("\n");
  }

  const unmerged = () =>
    cp
      .execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: repo })
      .toString()
      .split("\n")
      .filter((line) => line !== "");

  /** `simpleGit(repo)`, logging every command it is asked to run; `after`
   *  runs once, when the first command matching `when` has finished. */
  function recordingGit(hook?: { when: (args: string[]) => boolean; after: () => void }) {
    const real = simpleGit(repo);
    const ran: string[][] = [];
    let hooked = false;
    const client = {
      raw: async (args: string[]) => {
        ran.push(args);
        try {
          return await real.raw(args);
        } finally {
          if (hook !== undefined && !hooked && hook.when(args)) {
            hooked = true;
            hook.after();
          }
        }
      }
    } as unknown as Parameters<typeof applyStash>[0];
    return { client, ran };
  }

  /** A stash of "f" whose change conflicts with a commit made on top of its
   *  base, so applying it leaves "f" unmerged. */
  function conflictingStash(): string {
    repo = makeRepo();
    fs.writeFileSync(path.join(repo, "f"), "stashed");
    git(["stash", "push", "-m", "wip"], repo);
    fs.writeFileSync(path.join(repo, "f"), "committed");
    git(["commit", "-am", "conflicts with the stash"], repo);
    return rev(repo, "stash@{0}");
  }

  const actions = [
    ["apply", applyStash],
    ["pop", popStash]
  ] as const;

  // The ticket's fixture: a `-u` stash, then a merge left in conflict, then
  // the apply. git would refuse it ("needs merge") and leave the merge's
  // unmerged path behind, which, read after the fact, looks just like a
  // conflict the stash caused.
  it.each(actions)(
    "refuses to %s while unmerged paths are already there, running no stash command",
    async (_, action) => {
      repo = makeRepo();
      fs.writeFileSync(path.join(repo, "f"), "stashed");
      fs.writeFileSync(path.join(repo, "untracked.txt"), "u");
      git(["stash", "push", "-u", "-m", "wip"], repo);
      const stash = rev(repo, "stash@{0}");
      git(["checkout", "-b", "other"], repo);
      fs.writeFileSync(path.join(repo, "f"), "other");
      git(["commit", "-am", "other"], repo);
      git(["checkout", "main"], repo);
      fs.writeFileSync(path.join(repo, "f"), "mine");
      git(["commit", "-am", "mine"], repo);
      expect(() => git(["merge", "other"], repo)).toThrow();
      expect(unmerged()).toEqual(["f"]);
      const { client, ran } = recordingGit();

      const error = await rejection(
        action(client, { selector: "stash@{0}", expectedHash: stash, reinstateIndex: false })
      );

      expect(error).toBeInstanceOf(StashApplyError);
      expect((error as StashApplyError).failure).toEqual({ kind: "unmergedBefore" });
      expect(ran.filter((args) => args[0] === "stash")).toEqual([]);
      expect(stashList()).toEqual([`stash@{0} ${stash}`]);
      expect(fs.existsSync(path.join(repo, "untracked.txt"))).toBe(false);
    }
  );

  it.each(actions)(
    "reports a %s that left conflicts, with the stash kept where it sits",
    async (_, action) => {
      const stash = conflictingStash();

      const error = await rejection(
        action(simpleGit(repo), {
          selector: "stash@{0}",
          expectedHash: stash,
          reinstateIndex: false
        })
      );

      expect(error).toBeInstanceOf(StashApplyError);
      expect((error as StashApplyError).failure).toEqual({
        kind: "conflicted",
        keptAs: "stash@{0}"
      });
      expect(unmerged()).toEqual(["f"]);
      expect(stashList()).toEqual([`stash@{0} ${stash}`]);
    }
  );

  it("names where the stash sits after the apply, not the selector agreed to", async () => {
    const stash = conflictingStash();
    // A stash pushed from elsewhere after the check: the agreed stash@{0} is
    // stash@{1} by the time the conflict is reported.
    fs.writeFileSync(path.join(repo, "f"), "pushed");
    const pushed = cp.execFileSync("git", ["stash", "create"], { cwd: repo }).toString().trim();
    git(["checkout", "--", "f"], repo);
    const { client } = recordingGit({
      when: (args) => args[0] === "rev-parse",
      after: () => git(["stash", "store", "-m", "pushed", pushed], repo)
    });

    const error = await rejection(
      applyStash(client, { selector: "stash@{0}", expectedHash: stash, reinstateIndex: false })
    );

    expect((error as StashApplyError).failure).toEqual({ kind: "conflicted", keptAs: "stash@{1}" });
    expect(stashList()).toEqual([`stash@{0} ${pushed}`, `stash@{1} ${stash}`]);
  });

  it("names no position for a stash dropped after the check that still conflicted", async () => {
    const stash = conflictingStash();
    // Dropped from elsewhere after the check: apply runs on the SHA (#365),
    // so it still applies, but the stash is no longer listed anywhere.
    const { client } = recordingGit({
      when: (args) => args[0] === "rev-parse",
      after: () => git(["stash", "drop", "stash@{0}"], repo)
    });

    const error = await rejection(
      applyStash(client, { selector: "stash@{0}", expectedHash: stash, reinstateIndex: false })
    );

    expect((error as StashApplyError).failure).toEqual({ kind: "conflicted", keptAs: null });
    expect(unmerged()).toEqual(["f"]);
    expect(stashList()).toEqual([]);
  });

  it("still reports a conflict when the stash list cannot be read afterwards", async () => {
    const stash = conflictingStash();
    const real = simpleGit(repo);
    const noList = {
      raw: async (args: string[]) => {
        if (args[0] === "stash" && args[1] === "list") throw new Error("cannot read the list");
        return real.raw(args);
      }
    } as unknown as Parameters<typeof applyStash>[0];

    const error = await rejection(
      applyStash(noList, { selector: "stash@{0}", expectedHash: stash, reinstateIndex: false })
    );

    expect((error as StashApplyError).failure).toEqual({ kind: "conflicted", keptAs: null });
    expect(unmerged()).toEqual(["f"]);
  });

  it.each(actions)(
    "reports a %s that failed with nothing unmerged as changing nothing",
    async (_, action) => {
      repo = makeRepo();
      fs.writeFileSync(path.join(repo, "f"), "stashed");
      git(["stash", "push", "-m", "wip"], repo);
      const stash = rev(repo, "stash@{0}");
      // A local change the apply would overwrite: git refuses before merging.
      fs.writeFileSync(path.join(repo, "f"), "dirty");

      const error = await rejection(
        action(simpleGit(repo), {
          selector: "stash@{0}",
          expectedHash: stash,
          reinstateIndex: false
        })
      );

      expect(error).toBeInstanceOf(StashApplyError);
      expect((error as StashApplyError).failure).toEqual({ kind: "unchanged" });
      // git's own words stay on the error, for the report to show.
      expect(String(error)).toMatch(/overwritten/);
      expect(fs.readFileSync(path.join(repo, "f"), "utf8")).toBe("dirty");
      expect(stashList()).toEqual([`stash@{0} ${stash}`]);
    }
  );

  it("reports a moved stash as moved, not as an apply that failed", async () => {
    repo = makeRepo();
    const { older } = pushTwoStashes(repo);

    const error = await rejection(
      applyStash(simpleGit(repo), {
        selector: "stash@{0}",
        expectedHash: older,
        reinstateIndex: false
      })
    );

    expect(error).toBeInstanceOf(StashMovedError);
    expect(stashApplyFacts(error)).toEqual({ movedSelector: "stash@{0}", applyFailure: null });
  });

  it("carries the failure into the facts a response reports", () => {
    expect(stashApplyFacts(null)).toEqual({ movedSelector: null, applyFailure: null });
    expect(
      stashApplyFacts(new StashApplyError({ kind: "conflicted", keptAs: "stash@{2}" }, null))
    ).toEqual({ movedSelector: null, applyFailure: { kind: "conflicted", keptAs: "stash@{2}" } });
    expect(stashApplyFacts(new Error("anything else"))).toEqual({
      movedSelector: null,
      applyFailure: null
    });
  });
});
