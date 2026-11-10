import { describe, expect, it } from "vitest";

import { createBlameRepoWatchers } from "@ging/core/extension/blameRepoWatchers";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A stand-in for the file-system watchers: records which repositories are
 *  being watched and what was reported, and lets a test fire a change in one. */
function fakeWatching() {
  const live = new Map<string, () => void>();
  const started: string[] = [];
  const changed: string[] = [];
  const released: string[] = [];
  const watchers = createBlameRepoWatchers({
    watch: (repo, onChange) => {
      started.push(repo);
      live.set(repo, onChange);
      return Promise.resolve({ dispose: () => live.delete(repo) });
    },
    onChange: (repo) => changed.push(repo),
    onRelease: (repo) => released.push(repo)
  });
  return {
    watchers,
    started,
    changed,
    released,
    watched: () => [...live.keys()].toSorted(),
    fire: (repo: string) => live.get(repo)?.()
  };
}

/** Watchers that start only when the test says, succeeding or failing, on a
 *  clock the test sets. */
function controlledWatching() {
  const clock = { now: 0 };
  const attempts: { repo: string; finish: (ok: boolean) => Promise<void> }[] = [];
  const disposed: string[] = [];
  const changed: string[] = [];
  const released: string[] = [];
  const watchers = createBlameRepoWatchers({
    watch: (repo) =>
      new Promise((resolve) => {
        attempts.push({
          repo,
          finish: async (ok) => {
            resolve(ok ? { dispose: () => disposed.push(repo) } : null);
            await settle();
          }
        });
      }),
    onChange: (repo) => changed.push(repo),
    onRelease: (repo) => released.push(repo),
    now: () => clock.now
  });
  return { watchers, clock, attempts, disposed, changed, released };
}

describe("createBlameRepoWatchers", () => {
  it("watches a repository once a file in it is blamed", async () => {
    const t = fakeWatching();
    t.watchers.blaming("file:///app/a.ts", "/app");
    await settle();
    expect(t.watched()).toEqual(["/app"]);
  });

  it("keeps one watcher per repository, however many of its files are blamed or re-blamed", async () => {
    const t = fakeWatching();
    t.watchers.blaming("file:///app/a.ts", "/app");
    t.watchers.blaming("file:///app/b.ts", "/app");
    t.watchers.blaming("file:///app/a.ts", "/app");
    t.watchers.blaming("file:///lib/c.ts", "/lib");
    await settle();
    expect(t.started.toSorted()).toEqual(["/app", "/lib"]);
  });

  it("reports a change in a watched repository as a change of that repository", async () => {
    const t = fakeWatching();
    t.watchers.blaming("file:///app/a.ts", "/app");
    t.watchers.blaming("file:///lib/c.ts", "/lib");
    await settle();
    t.changed.length = 0;
    t.fire("/lib");
    expect(t.changed).toEqual(["/lib"]);
  });

  // The first blame ran before anything watched the repository, so a commit
  // made while the watcher started would otherwise never be seen.
  it("reports a change once a watcher is up, for whatever happened while it started", async () => {
    const t = controlledWatching();
    t.watchers.blaming("file:///app/a.ts", "/app");
    expect(t.changed).toEqual([]);
    await t.attempts[0].finish(true);
    expect(t.changed).toEqual(["/app"]);
  });

  it("keeps watching while any blamed file of the repository is open, and lets go after the last", async () => {
    const t = fakeWatching();
    t.watchers.blaming("file:///app/a.ts", "/app");
    t.watchers.blaming("file:///app/b.ts", "/app");
    t.watchers.blaming("file:///lib/c.ts", "/lib");
    await settle();

    t.watchers.keepOnly(new Set(["file:///app/b.ts", "file:///lib/c.ts"]));
    expect(t.watched()).toEqual(["/app", "/lib"]);

    t.watchers.keepOnly(new Set(["file:///lib/c.ts"]));
    expect(t.watched()).toEqual(["/lib"]);
  });

  // Nothing tells a blame of that repository is stale any more, so whoever
  // keeps blames must hear about it.
  it("reports each repository it lets go of", async () => {
    const t = fakeWatching();
    t.watchers.blaming("file:///app/a.ts", "/app");
    t.watchers.blaming("file:///lib/c.ts", "/lib");
    await settle();
    t.watchers.keepOnly(new Set(["file:///lib/c.ts"]));
    expect(t.released).toEqual(["/app"]);
  });

  it("watches the repository again when one of its files is blamed after it was let go", async () => {
    const t = fakeWatching();
    t.watchers.blaming("file:///app/a.ts", "/app");
    await settle();
    t.watchers.keepOnly(new Set());
    t.watchers.blaming("file:///app/a.ts", "/app");
    await settle();
    expect(t.watched()).toEqual(["/app"]);
  });

  // A submodule discovered after its file was opened takes the file over.
  it("moves a file's watcher along when the file is blamed in another repository", async () => {
    const t = fakeWatching();
    t.watchers.blaming("file:///app/sub/b.ts", "/app");
    await settle();
    t.watchers.blaming("file:///app/sub/b.ts", "/app/sub");
    await settle();
    expect(t.watched()).toEqual(["/app/sub"]);
  });

  it("lets go of every watcher when disposed", async () => {
    const t = fakeWatching();
    t.watchers.blaming("file:///app/a.ts", "/app");
    t.watchers.blaming("file:///lib/c.ts", "/lib");
    await settle();
    t.watchers.dispose();
    expect(t.watched()).toEqual([]);
  });

  // Finding the git dir takes a git run, so a watcher can still be starting
  // when its last file closes.
  describe("a watcher still starting", () => {
    it("is let go as soon as it has started, once its repository is no longer blamed", async () => {
      const t = controlledWatching();
      t.watchers.blaming("file:///app/a.ts", "/app");
      t.watchers.keepOnly(new Set());
      await t.attempts[0].finish(true);
      expect(t.disposed).toEqual(["/app"]);
    });

    it("is not started twice when its repository is blamed again meanwhile", async () => {
      const t = controlledWatching();
      t.watchers.blaming("file:///app/a.ts", "/app");
      t.watchers.keepOnly(new Set());
      t.watchers.blaming("file:///app/a.ts", "/app");
      await t.attempts[0].finish(true);
      t.watchers.keepOnly(new Set());
      expect(t.attempts.map((a) => a.repo)).toEqual(["/app"]);
      expect(t.disposed).toEqual(["/app"]);
    });

    it("is let go when everything is disposed before it has started", async () => {
      const t = controlledWatching();
      t.watchers.blaming("file:///app/a.ts", "/app");
      t.watchers.dispose();
      await t.attempts[0].finish(true);
      expect(t.disposed).toEqual(["/app"]);
    });
  });

  // e.g. finding the git dir ran out of time on a busy machine.
  describe("a repository that couldn't be watched", () => {
    // Its blames would otherwise be trusted with nothing to tell they went stale.
    it("is reported as let go while its files are still blamed", async () => {
      const t = controlledWatching();
      t.watchers.blaming("file:///app/a.ts", "/app");
      await t.attempts[0].finish(false);
      expect(t.released).toEqual(["/app"]);
    });

    it("is reported as let go when watching it throws", async () => {
      const released: string[] = [];
      const watchers = createBlameRepoWatchers({
        watch: () => Promise.reject(new Error("no git")),
        onChange: () => {},
        onRelease: (repo) => released.push(repo)
      });
      watchers.blaming("file:///app/a.ts", "/app");
      await settle();
      expect(released).toEqual(["/app"]);
    });

    // Every cursor move blames again: without a pause each one would spawn git.
    it("is tried again only 30 s after it failed, one attempt at a time", async () => {
      const t = controlledWatching();
      t.watchers.blaming("file:///app/a.ts", "/app");
      t.watchers.blaming("file:///app/b.ts", "/app");
      expect(t.attempts).toHaveLength(1);

      t.clock.now = 1_000;
      await t.attempts[0].finish(false);
      t.clock.now = 30_999;
      t.watchers.blaming("file:///app/a.ts", "/app");
      expect(t.attempts).toHaveLength(1);

      t.clock.now = 31_000;
      t.watchers.blaming("file:///app/a.ts", "/app");
      expect(t.attempts).toHaveLength(2);
      await t.attempts[1].finish(true);
      expect(t.changed).toEqual(["/app"]);
    });

    it("is tried straight away when blamed afresh after it was let go", async () => {
      const t = controlledWatching();
      t.watchers.blaming("file:///app/a.ts", "/app");
      await t.attempts[0].finish(false);
      t.watchers.keepOnly(new Set());
      t.watchers.blaming("file:///app/a.ts", "/app");
      expect(t.attempts).toHaveLength(2);
    });
  });
});
