import { describe, expect, it } from "vitest";

import type { RepoSource } from "@ging/core/host/ports";
import type { GitRepoSet, GitRepoState } from "@ging/shared/types";

/** What the `RepoSource` contract needs from an implementation under test. */
export type RepoSourceSubject = {
  source: RepoSource;
  /** The path of the known repository set up as `name`. */
  path(name: string): string;
  /** Make `name` no longer a repository, the way deleting it would. */
  remove(name: string): void;
  /** Every set the source broadcast to what shows it, oldest first. */
  broadcasts(): GitRepoSet[];
};

/** Known repositories by name, each with its state; a subject sets them up as
 *  real repositories wherever it keeps them. */
export type KnownRepos = Record<string, GitRepoState>;

/** The `RepoSource` contract (`@ging/core/host/ports`); see storage.ts for how
 *  the contract suites are run. `make` may be async: a host's subject may need
 *  real repositories. */
export function describeRepoSourceContract(
  name: string,
  make: (known: KnownRepos) => RepoSourceSubject | Promise<RepoSourceSubject>
): void {
  const plain: GitRepoState = { columnWidths: null };

  describe(`${name} honours the RepoSource contract`, () => {
    it("answers the known repositories, each with its state", async () => {
      const s = await make({ a: plain, b: { columnWidths: [10, 20] } });
      expect(s.source.getRepos()).toEqual({
        [s.path("a")]: plain,
        [s.path("b")]: { columnWidths: [10, 20] }
      });
    });

    it("writes a repository's state", async () => {
      const s = await make({ a: plain });
      s.source.setRepoState(s.path("a"), { columnWidths: [5], customName: "Alpha" });
      expect(s.source.getRepos()[s.path("a")]).toEqual({ columnWidths: [5], customName: "Alpha" });
    });

    it("merges a patch into the state as it is at the write, and broadcasts the set", async () => {
      const s = await make({ a: { columnWidths: [1], customName: "Alpha" }, b: plain });
      const a = s.path("a");
      s.source.setRepoState(a, { columnWidths: [2], customName: "Alpha" });
      s.source.updateRepoState(a, { hiddenRemotes: ["upstream"] });

      const merged = { columnWidths: [2], customName: "Alpha", hiddenRemotes: ["upstream"] };
      expect(s.source.getRepos()[a]).toEqual(merged);
      expect(s.broadcasts().at(-1)).toEqual({ [a]: merged, [s.path("b")]: plain });
    });

    it("leaves a repository it does not know alone when patched, and says nothing", async () => {
      const s = await make({ a: plain });
      const before = s.source.getRepos();
      s.source.updateRepoState(`${s.path("a")}-unknown`, { customName: "Ghost" });
      expect(s.source.getRepos()).toEqual(before);
      expect(s.broadcasts()).toEqual([]);
    });

    it("drops a repository and broadcasts the set without it", async () => {
      const s = await make({ a: plain, b: plain });
      s.source.dropRepo(s.path("a"));
      expect(s.source.getRepos()).toEqual({ [s.path("b")]: plain });
      expect(s.broadcasts().at(-1)).toEqual({ [s.path("b")]: plain });
    });

    it("drops the repositories that are gone, broadcasts the set, and says it did", async () => {
      const s = await make({ a: plain, b: plain, c: plain });
      s.remove("b");
      await expect(s.source.checkReposExist()).resolves.toBe(true);
      const left = { [s.path("a")]: plain, [s.path("c")]: plain };
      expect(s.source.getRepos()).toEqual(left);
      expect(s.broadcasts().length).toBeGreaterThan(0);
      expect(s.broadcasts().at(-1)).toEqual(left);
    });

    it("changes nothing and says so when every repository is still there", async () => {
      const s = await make({ a: plain, b: plain });
      await expect(s.source.checkReposExist()).resolves.toBe(false);
      expect(Object.keys(s.source.getRepos()).toSorted()).toEqual(
        [s.path("a"), s.path("b")].toSorted()
      );
      expect(s.broadcasts()).toEqual([]);
    });

    it("boots on a known repository, and on none once there are none", async () => {
      const s = await make({ a: plain, b: plain });
      const known = () => Object.keys(s.source.getRepos());
      expect(known()).toContain(s.source.getBootRepo());

      s.source.dropRepo(s.path("a"));
      expect(s.source.getBootRepo()).toBe(s.path("b"));
      s.source.dropRepo(s.path("b"));
      expect(s.source.getBootRepo()).toBeNull();
    });
  });
}
