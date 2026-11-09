/** A running watcher over one repository's git dir. */
export type RepoWatch = { dispose(): void };

/** How long a repository that couldn't be watched waits before another try. */
export const WATCH_RETRY_MS = 30_000;

type Entry =
  /** Waiting for `watch`; `wanted` is false once no blamed file needs it. */
  | { state: "starting"; wanted: boolean }
  | { state: "running"; watch: RepoWatch }
  /** `watch` gave nothing at `at` (epoch ms). */
  | { state: "failed"; at: number };

/**
 * Which repositories blame watches for commits and checkouts: exactly those
 * with a file open that has been blamed in them. A repository gets one watcher
 * however many of its files are open, and loses it when the last one closes.
 *
 * - Starting a watcher takes a git run (to find the git dir), so `watch` is
 *   asynchronous. One whose repository stopped being wanted while it started
 *   is let go the moment it arrives, and one still starting is never started
 *   a second time.
 * - Once up, it reports a change straight away: the repository's first blames
 *   ran before anything watched it, and a commit may have landed meanwhile.
 * - A repository `watch` can't watch (null or a rejection — say finding its
 *   git dir timed out) is reported let go, since nothing would tell its blames
 *   went stale, and tried again on a blame `WATCH_RETRY_MS` later at the
 *   earliest: every cursor move blames, and each try spawns git.
 */
export function createBlameRepoWatchers(deps: {
  /** Watch `repo`'s git dir, calling `onChange` on every change; null when it
   *  can't be watched. */
  watch: (repo: string, onChange: () => void) => Promise<RepoWatch | null>;
  /** Something in `repo`'s branches or HEAD may have changed. */
  onChange: (repo: string) => void;
  /** `repo` is no longer watched: from now on nothing would tell that a blame
   *  made in it has gone stale. */
  onRelease: (repo: string) => void;
  /** The clock, in epoch ms. */
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  /** Each blamed, still open document (by key) and the repository it was blamed in. */
  const blamedDocs = new Map<string, string>();
  const entries = new Map<string, Entry>();

  function start(repo: string) {
    const entry: Entry = { state: "starting", wanted: true };
    entries.set(repo, entry);
    void deps
      .watch(repo, () => deps.onChange(repo))
      .then(
        (watch) => watch,
        () => null
      )
      .then((watch) => {
        if (!entry.wanted) {
          watch?.dispose();
          if (entries.get(repo) === entry) entries.delete(repo);
          return;
        }
        if (watch === null) {
          entries.set(repo, { state: "failed", at: now() });
          deps.onRelease(repo);
          return;
        }
        entries.set(repo, { state: "running", watch });
        deps.onChange(repo);
      });
  }

  function sync() {
    const wanted = new Set(blamedDocs.values());
    for (const [repo, entry] of entries) {
      if (wanted.has(repo)) continue;
      switch (entry.state) {
        case "starting":
          // Let go once it arrives (see `start`).
          if (!entry.wanted) break;
          entry.wanted = false;
          deps.onRelease(repo);
          break;
        case "running":
          entry.watch.dispose();
          entries.delete(repo);
          deps.onRelease(repo);
          break;
        case "failed":
          // Reported let go when it failed.
          entries.delete(repo);
          break;
      }
    }
    for (const repo of wanted) {
      const entry = entries.get(repo);
      if (entry === undefined) start(repo);
      else if (entry.state === "starting") entry.wanted = true;
      else if (entry.state === "failed" && now() - entry.at >= WATCH_RETRY_MS) start(repo);
    }
  }

  return {
    /** The document `key` is being blamed in `repo`. */
    blaming(key: string, repo: string) {
      blamedDocs.set(key, repo);
      sync();
    },
    /** Only these documents are still open; forget every other one. */
    keepOnly(openKeys: ReadonlySet<string>) {
      for (const key of blamedDocs.keys()) if (!openKeys.has(key)) blamedDocs.delete(key);
      sync();
    },
    dispose() {
      blamedDocs.clear();
      sync();
    }
  };
}
