import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { describe, expect, it, onTestFinished } from "vitest";

import { createDesktopWatcher } from "@ging/desktop/ports/watcher";

import { describeWatcherContract } from "@ging/core/tests/contracts/watcher";
import { makeTempDir, rmrf, toRepoPath } from "@ging/core/tests/helpers";

// The real watcher on real folders, with its two delays shortened so the
// suite does not wait out the production ones.
const DEBOUNCE_MS = 50;
const RESUME_GRACE_MS = 300;
/** Long enough for the file system's events to have arrived, and for whatever
 *  they started to have finished. */
const SETTLED_MS = RESUME_GRACE_MS + DEBOUNCE_MS + 300;

function subject() {
  let refreshes = 0;
  const errors: string[] = [];
  const watcher = createDesktopWatcher(() => refreshes++, {
    debounceMs: DEBOUNCE_MS,
    resumeGraceMs: RESUME_GRACE_MS,
    onError: (message) => errors.push(message)
  });
  const folders = new Map<string, string>();
  onTestFinished(() => {
    watcher.stop();
    folders.forEach(rmrf);
  });
  let written = 0;
  return {
    watcher,
    errors,
    repo: (name: string) => {
      if (!folders.has(name)) folders.set(name, toRepoPath(makeTempDir(`ging-watch-${name}-`)));
      return folders.get(name)!;
    },
    /** Write `relativePath` in `repo`, a while after whatever came before it:
     *  something outside GING does not act the instant the watch starts. */
    write: async (repo: string, relativePath: string) => {
      await wait(100);
      const file = path.join(repo, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, String(++written));
    },
    settle: () => wait(SETTLED_MS),
    refreshes: () => refreshes
  };
}

describeWatcherContract("the desktop Watcher", () => {
  const s = subject();
  return { ...s, change: (repo) => s.write(repo, "f") };
});

describe("the desktop Watcher", () => {
  it("refreshes once for a burst of changes", async () => {
    const s = subject();
    const repo = s.repo("a");
    s.watcher.start(repo);
    await s.write(repo, "a");
    fs.writeFileSync(path.join(repo, "b"), "b");
    fs.writeFileSync(path.join(repo, "c"), "c");
    await s.settle();
    expect(s.refreshes()).toBe(1);
  });

  it("ignores what git writes that changes nothing the graph shows", async () => {
    const s = subject();
    const repo = s.repo("a");
    fs.mkdirSync(path.join(repo, ".git", "objects", "ab"), { recursive: true });
    s.watcher.start(repo);
    await s.write(repo, ".git/objects/ab/cdef");
    await s.settle();
    expect(s.refreshes()).toBe(0);

    await s.write(repo, ".git/HEAD");
    await s.settle();
    expect(s.refreshes()).toBe(1);
  });

  it("refreshes nothing once stopped, not even for a change already pending", async () => {
    const s = subject();
    const repo = s.repo("a");
    s.watcher.start(repo);
    await s.write(repo, "f");
    await wait(20);
    s.watcher.stop();
    await s.settle();
    expect(s.refreshes()).toBe(0);
  });

  it("says so, and watches nothing, when the repository cannot be watched", async () => {
    const s = subject();
    s.watcher.start(`${s.repo("a")}/no-such-folder`);
    expect(s.errors).toEqual([expect.stringContaining("no-such-folder")]);
  });
});
