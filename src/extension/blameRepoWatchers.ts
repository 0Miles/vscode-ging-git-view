/** A running watcher over one repository's git dir. */
export type RepoWatch = { dispose(): void };

type Entry = {
  /** Undefined while still starting; null when the repository can't be watched. */
  watch: RepoWatch | null | undefined;
  /** Whether some open, blamed file still belongs to the repository. */
  wanted: boolean;
};

/**
 * Which repositories blame watches for commits and checkouts: exactly those
 * with a file open that has been blamed in them. A repository gets one watcher
 * however many of its files are open, and loses it when the last one closes.
 *
 * Starting a watcher takes a git run (to find the git dir), so `watch` is
 * asynchronous; a watcher whose repository stopped being wanted while it
 * started is let go the moment it arrives, and one still starting is never
 * started a second time. A repository `watch` can't watch (null) is not tried
 * again until it has been let go and blamed afresh.
 */
export function createBlameRepoWatchers(deps: {
  /** Watch `repo`'s git dir, calling `onChange` on every change; null when it
   *  can't be watched. */
  watch: (repo: string, onChange: () => void) => Promise<RepoWatch | null>;
  /** Something in `repo`'s branches or HEAD changed. */
  onChange: (repo: string) => void;
  /** `repo` is no longer watched: from now on nothing would tell that a blame
   *  made in it has gone stale. */
  onRelease?: (repo: string) => void;
}) {
  /** Each blamed, still open document (by key) and the repository it was blamed in. */
  const docs = new Map<string, string>();
  const entries = new Map<string, Entry>();

  function start(repo: string) {
    const entry: Entry = { watch: undefined, wanted: true };
    entries.set(repo, entry);
    void deps
      .watch(repo, () => deps.onChange(repo))
      .then(
        (watch) => watch,
        () => null
      )
      .then((watch) => {
        if (entry.wanted) {
          entry.watch = watch;
          return;
        }
        watch?.dispose();
        if (entries.get(repo) === entry) entries.delete(repo);
      });
  }

  function sync() {
    const wanted = new Set(docs.values());
    for (const [repo, entry] of entries) {
      if (wanted.has(repo) || !entry.wanted) continue;
      entry.wanted = false;
      deps.onRelease?.(repo);
      // One still starting is let go once it arrives (see `start`).
      if (entry.watch === undefined) continue;
      entry.watch?.dispose();
      entries.delete(repo);
    }
    for (const repo of wanted) {
      const entry = entries.get(repo);
      if (entry === undefined) start(repo);
      else entry.wanted = true;
    }
  }

  return {
    /** The document `key` is being blamed in `repo`. */
    blaming(key: string, repo: string) {
      if (docs.get(key) === repo) return;
      docs.set(key, repo);
      sync();
    },
    /** Only these documents are still open; forget every other one. */
    keepOnly(openKeys: ReadonlySet<string>) {
      for (const key of docs.keys()) if (!openKeys.has(key)) docs.delete(key);
      sync();
    },
    dispose() {
      docs.clear();
      sync();
    }
  };
}
