/** What a cached blame was computed for. */
export type BlameCacheStamp = {
  /** The document's version. */
  version: number;
  /** The known repository the file was blamed in. */
  repo: string;
};

/**
 * One blame per document, kept while the document stays at the same version
 * and belongs to the same repository. The repository is part of the stamp
 * because it can change under an unchanged document: a submodule discovered
 * after its file was opened takes the file over from the parent repository,
 * whose (empty) result must not stand in for the submodule's own.
 */
export function createBlameCache<T>() {
  const entries = new Map<string, { stamp: BlameCacheStamp; value: T }>();
  return {
    get(key: string, stamp: BlameCacheStamp): T | undefined {
      const entry = entries.get(key);
      return entry?.stamp.version === stamp.version && entry.stamp.repo === stamp.repo
        ? entry.value
        : undefined;
    },
    set(key: string, stamp: BlameCacheStamp, value: T) {
      entries.set(key, { stamp, value });
    },
    delete(key: string) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    }
  };
}
