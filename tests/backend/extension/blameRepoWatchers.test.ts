import { describe, expect, it } from "vitest";

import { createBlameRepoWatchers } from "@/extension/blameRepoWatchers";

/** A stand-in for the file-system watchers: records which repositories are
 *  being watched, and lets a test fire a change in one. */
function fakeWatching() {
  const live = new Map<string, () => void>();
  const started: string[] = [];
  const changed: string[] = [];
  const watchers = createBlameRepoWatchers({
    watch: (repo, onChange) => {
      started.push(repo);
      live.set(repo, onChange);
      return Promise.resolve({ dispose: () => live.delete(repo) });
    },
    onChange: (repo) => changed.push(repo)
  });
  return {
    watchers,
    started,
    changed,
    watched: () => [...live.keys()].toSorted(),
    fire: (repo: string) => live.get(repo)?.(),
    settle: () => new Promise((resolve) => setTimeout(resolve, 0))
  };
}

describe("createBlameRepoWatchers", () => {
  it("watches a repository once a file in it is blamed", async () => {
    const t = fakeWatching();
    t.watchers.blaming("file:///app/a.ts", "/app");
    await t.settle();
    expect(t.watched()).toEqual(["/app"]);
  });

  it("keeps one watcher per repository, however many of its files are blamed or re-blamed", async () => {
    const t = fakeWatching();
    t.watchers.blaming("file:///app/a.ts", "/app");
    t.watchers.blaming("file:///app/b.ts", "/app");
    t.watchers.blaming("file:///app/a.ts", "/app");
    t.watchers.blaming("file:///lib/c.ts", "/lib");
    await t.settle();
    expect(t.started.toSorted()).toEqual(["/app", "/lib"]);
  });

  it("reports a change in a watched repository as a change of that repository", async () => {
    const t = fakeWatching();
    t.watchers.blaming("file:///app/a.ts", "/app");
    t.watchers.blaming("file:///lib/c.ts", "/lib");
    await t.settle();
    t.fire("/lib");
    expect(t.changed).toEqual(["/lib"]);
  });

  it("keeps watching while any blamed file of the repository is open, and lets go after the last", async () => {
    const t = fakeWatching();
    t.watchers.blaming("file:///app/a.ts", "/app");
    t.watchers.blaming("file:///app/b.ts", "/app");
    t.watchers.blaming("file:///lib/c.ts", "/lib");
    await t.settle();

    t.watchers.keepOnly(new Set(["file:///app/b.ts", "file:///lib/c.ts"]));
    expect(t.watched()).toEqual(["/app", "/lib"]);

    t.watchers.keepOnly(new Set(["file:///lib/c.ts"]));
    expect(t.watched()).toEqual(["/lib"]);
  });

  it("watches the repository again when one of its files is blamed after it was let go", async () => {
    const t = fakeWatching();
    t.watchers.blaming("file:///app/a.ts", "/app");
    await t.settle();
    t.watchers.keepOnly(new Set());
    t.watchers.blaming("file:///app/a.ts", "/app");
    await t.settle();
    expect(t.watched()).toEqual(["/app"]);
  });

  // A submodule discovered after its file was opened takes the file over.
  it("moves a file's watcher along when the file is blamed in another repository", async () => {
    const t = fakeWatching();
    t.watchers.blaming("file:///app/sub/b.ts", "/app");
    await t.settle();
    t.watchers.blaming("file:///app/sub/b.ts", "/app/sub");
    await t.settle();
    expect(t.watched()).toEqual(["/app/sub"]);
  });

  // Finding the git dir takes a git run, so a watcher can still be starting
  // when its last file closes.
  describe("a watcher still starting", () => {
    function slowWatching() {
      const pending: { repo: string; resolve: (w: { dispose(): void } | null) => void }[] = [];
      const disposed: string[] = [];
      const watchers = createBlameRepoWatchers({
        watch: (repo) => new Promise((resolve) => pending.push({ repo, resolve })),
        onChange: () => {}
      });
      const finish = async (i: number, ok = true) => {
        const { repo, resolve } = pending[i];
        resolve(ok ? { dispose: () => disposed.push(repo) } : null);
        await new Promise((r) => setTimeout(r, 0));
      };
      return { watchers, pending, disposed, finish };
    }

    it("is let go as soon as it has started, once its repository is no longer blamed", async () => {
      const t = slowWatching();
      t.watchers.blaming("file:///app/a.ts", "/app");
      t.watchers.keepOnly(new Set());
      await t.finish(0);
      expect(t.disposed).toEqual(["/app"]);
    });

    it("is not started twice when its repository is blamed again meanwhile", async () => {
      const t = slowWatching();
      t.watchers.blaming("file:///app/a.ts", "/app");
      t.watchers.keepOnly(new Set());
      t.watchers.blaming("file:///app/a.ts", "/app");
      await t.finish(0);
      t.watchers.keepOnly(new Set());
      expect(t.pending.map((p) => p.repo)).toEqual(["/app"]);
      expect(t.disposed).toEqual(["/app"]);
    });

    it("is let go when everything is disposed before it has started", async () => {
      const t = slowWatching();
      t.watchers.blaming("file:///app/a.ts", "/app");
      t.watchers.dispose();
      await t.finish(0);
      expect(t.disposed).toEqual(["/app"]);
    });
  });

  // e.g. git can't find its git dir: blaming the next file in that repository,
  // or the same one again, must not run git again each time.
  it("does not keep retrying a repository that cannot be watched while it stays blamed", async () => {
    const started: string[] = [];
    const watchers = createBlameRepoWatchers({
      watch: (repo) => {
        started.push(repo);
        return Promise.resolve(null);
      },
      onChange: () => {}
    });
    watchers.blaming("file:///app/a.ts", "/app");
    await new Promise((r) => setTimeout(r, 0));
    watchers.blaming("file:///app/b.ts", "/app");
    watchers.blaming("file:///app/a.ts", "/app");
    expect(started).toEqual(["/app"]);
  });

  // Nothing tells a blame of that repository is stale any more, so whoever
  // keeps blames must hear about it.
  it("reports each repository it lets go of", async () => {
    const released: string[] = [];
    const watchers = createBlameRepoWatchers({
      watch: () => Promise.resolve({ dispose: () => {} }),
      onChange: () => {},
      onRelease: (repo) => released.push(repo)
    });
    watchers.blaming("file:///app/a.ts", "/app");
    watchers.blaming("file:///lib/c.ts", "/lib");
    await new Promise((r) => setTimeout(r, 0));
    watchers.keepOnly(new Set(["file:///lib/c.ts"]));
    expect(released).toEqual(["/app"]);
  });

  it("lets go of every watcher when disposed", async () => {
    const t = fakeWatching();
    t.watchers.blaming("file:///app/a.ts", "/app");
    t.watchers.blaming("file:///lib/c.ts", "/lib");
    await t.settle();
    t.watchers.dispose();
    expect(t.watched()).toEqual([]);
  });
});
