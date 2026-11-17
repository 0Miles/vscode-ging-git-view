import * as fs from "node:fs";

import { describe, expect, it, onTestFinished } from "vitest";

import { ExtensionState } from "@ging/core/extensionState";
import type { StateStore } from "@ging/core/host/ports";
import { createDesktopRepoSource } from "@ging/desktop/ports/repoSource";
import { openDesktopStorage } from "@ging/desktop/ports/storage";
import { createRecentRepos, RECENT_REPOS_SHOWN } from "@ging/desktop/recentRepos";

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
  const session = (options: Pick<Parameters<typeof createRecentRepos>[0], "isUsable"> = {}) => {
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
    /** Told each time a look at the folders found one otherwise. */
    let changed: () => void = Function.prototype as () => void;
    const recent = createRecentRepos({
      store: storage.workspace,
      repoSource,
      ...options,
      onChange: () => changed()
    });
    onTestFinished(() => recent.dispose());
    /** Open `repo` as the main process does: known first, then first. */
    const open = (repo: string) => {
      repoSource.addRepo(repo);
      recent.opened(repo);
    };
    /** Look at the folders, and wait until a look finds one otherwise. */
    const checked = () => {
      const told = new Promise<void>((resolve) => {
        changed = resolve;
      });
      recent.check();
      return told;
    };
    const order = () => storage.workspace.get<unknown>("desktopRecentRepos", null);
    return { repoSource, recent, open, checked, order };
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

    const next = session();
    await next.checked();
    expect(next.recent.list()).toEqual([
      { path: kept, name: "kept", missing: false },
      { path: gone, name: "gone", missing: true }
    ]);
  });

  it("says what the last look at the disk found, never looking while it lists", async () => {
    const { folder, session } = setUp();
    const [a, b] = [folder("a"), folder("b")];
    const asked: string[] = [];
    const answers = new Map<string, (usable: boolean) => void>();
    const { recent, open } = session({
      isUsable: (dir) => {
        asked.push(dir);
        return new Promise((resolve) => answers.set(dir, resolve));
      }
    });
    open(a);
    open(b);

    recent.list();
    expect(asked).toEqual([]);

    recent.check();
    // A folder that does not answer — a network share gone away — is looked
    // at once, however often the list is checked again, and holds up no other.
    recent.check();
    expect(asked.toSorted()).toEqual([a, b].toSorted());
    answers.get(a)!(false);
    await expect.poll(() => recent.list().map(({ missing }) => missing)).toEqual([false, true]);
    recent.check();
    expect(asked.filter((dir) => dir === b)).toHaveLength(1);
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

  it("forgets the order of a repository the known set dropped, whatever dropped it", () => {
    const { folder, session } = setUp();
    const [a, b] = [folder("a"), folder("b")];
    const { repoSource, open, order } = session();
    open(a);
    open(b);

    // As a Tab's graph drops its own repository once it is none (#454).
    repoSource.dropRepo(a);

    expect(order()).toEqual([b]);
  });

  it(`shows the ${RECENT_REPOS_SHOWN} opened last, and keeps the rest known`, () => {
    const { folder, session } = setUp();
    const all = Array.from({ length: RECENT_REPOS_SHOWN + 5 }, (_, i) => folder(`r${i}`));
    const { repoSource, recent, open, order } = session();
    all.forEach(open);

    const newestFirst = all.toReversed();
    expect(paths(recent.list())).toEqual(newestFirst.slice(0, RECENT_REPOS_SHOWN));
    expect(order()).toEqual(newestFirst.slice(0, RECENT_REPOS_SHOWN));
    expect(Object.keys(repoSource.getRepos())).toHaveLength(all.length);
    // Opened again, one past the cap comes back first.
    open(all[0]);
    expect(paths(recent.list())[0]).toBe(all[0]);
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
