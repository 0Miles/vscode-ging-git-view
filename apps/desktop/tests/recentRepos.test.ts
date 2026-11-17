import * as fs from "node:fs";

import { describe, expect, it, onTestFinished } from "vitest";

import { ExtensionState } from "@ging/core/extensionState";
import type { StateStore } from "@ging/core/host/ports";
import { createDesktopRepoSource } from "@ging/desktop/ports/repoSource";
import { openDesktopStorage } from "@ging/desktop/ports/storage";
import { createRecentRepos } from "@ging/desktop/recentRepos";

import { makeTempDir, rmrf } from "@ging/core/tests/helpers";

// The recently opened list (#394): the desktop host's known repositories, in
// the order they were last opened, over the real storage and repo source, each
// session a restart of the app on the same user data folder.

function setUp() {
  const userData = makeTempDir("ging-recent-");
  const folders: string[] = [userData];
  onTestFinished(() => folders.forEach(rmrf));
  /** A folder that is there, spelled as git spells a repository's top. */
  const folder = (name: string) => {
    const dir = `${makeTempDir("ging-recent-repo-").replace(/\\/g, "/")}/${name}`;
    fs.mkdirSync(dir);
    folders.push(dir);
    return dir;
  };
  /** Every write this test made, so the next session reads them back. */
  const writes: PromiseLike<void>[] = [];
  const settled = () => Promise.all(writes);
  const session = () => {
    const opened = openDesktopStorage(userData);
    const tracked = (store: StateStore): StateStore => ({
      get: (key, fallback) => store.get(key, fallback),
      update: (key, value) => {
        const write = store.update(key, value);
        writes.push(write);
        return write;
      }
    });
    const storage = {
      ...opened,
      workspace: tracked(opened.workspace),
      global: tracked(opened.global)
    };
    const repoSource = createDesktopRepoSource(new ExtensionState(storage), {
      gitPath: () => "git"
    });
    const recent = createRecentRepos({ store: storage.workspace, repoSource });
    /** Open `repo` as the main process does: known first, then first. */
    const open = (repo: string) => {
      repoSource.addRepo(repo);
      recent.opened(repo);
    };
    return { repoSource, recent, open };
  };
  return { folder, session, settled };
}

const paths = (list: { path: string }[]) => list.map((entry) => entry.path);

describe("the recently opened list", () => {
  it("lists the known repositories, the one opened last first, and keeps the order across a restart", async () => {
    const { folder, session, settled } = setUp();
    const [a, b, c] = [folder("a"), folder("b"), folder("c")];
    const first = session();
    first.open(a);
    first.open(b);
    first.open(c);
    first.open(a);

    expect(paths(first.recent.list())).toEqual([a, c, b]);
    await settled();
    expect(paths(session().recent.list())).toEqual([a, c, b]);
  });

  it("names each by its custom name, or its folder's", () => {
    const { folder, session } = setUp();
    const [a, b] = [folder("alpha"), folder("beta")];
    const { repoSource, recent, open } = session();
    open(a);
    open(b);
    repoSource.updateRepoState(b, { customName: "Beta Project" });

    expect(recent.list().map(({ name }) => name)).toEqual(["Beta Project", "alpha"]);
  });

  it("lists a repository whose folder has gone, saying so, rather than dropping it", async () => {
    const { folder, session, settled } = setUp();
    const [kept, gone] = [folder("kept"), folder("gone")];
    const first = session();
    first.open(gone);
    first.open(kept);
    fs.rmSync(gone, { recursive: true });
    await settled();

    expect(session().recent.list()).toEqual([
      { path: kept, name: "kept", missing: false },
      { path: gone, name: "gone", missing: true }
    ]);
  });

  it("lists a known repository never opened since the order began last, in path order", () => {
    const { folder, session } = setUp();
    const [a, b, c] = [folder("a"), folder("b"), folder("c")];
    const { repoSource, recent, open } = session();
    // Known without an order: as an earlier version of the app left them.
    repoSource.addRepo(b);
    repoSource.addRepo(a);
    open(c);

    expect(paths(recent.list())).toEqual([c, ...[a, b].toSorted()]);
  });

  it("takes a repository off the list for good when forgotten", async () => {
    const { folder, session, settled } = setUp();
    const [a, b] = [folder("a"), folder("b")];
    const first = session();
    first.open(a);
    first.open(b);
    first.recent.forget(a);

    expect(paths(first.recent.list())).toEqual([b]);
    expect(Object.keys(first.repoSource.getRepos())).toEqual([b]);
    await settled();
    const next = session();
    expect(paths(next.recent.list())).toEqual([b]);
    // Opened again later, it comes back first.
    next.open(a);
    expect(paths(next.recent.list())).toEqual([a, b]);
  });

  it("reads an order it does not recognise as none", () => {
    const { folder, session } = setUp();
    const [a, b] = [folder("a"), folder("b")];
    const { repoSource } = session();
    repoSource.addRepo(b);
    repoSource.addRepo(a);
    // A later version's, say: not a list of paths.
    const store = {
      get: <T>() => ({ order: [b, a] }) as T,
      update: () => Promise.resolve()
    };

    expect(paths(createRecentRepos({ store, repoSource }).list())).toEqual([a, b].toSorted());
  });
});
