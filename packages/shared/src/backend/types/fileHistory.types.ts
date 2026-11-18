/* A file's history (#408), as core reads it (`loadFileHistory`) and a host's
 * screen shows it. */

/** How the commit changed the file: added, modified, deleted, or brought it
 *  under this path from `oldPath` by a rename or a copy. A merge's is `M`. */
export type FileHistoryChange = "A" | "M" | "D" | "R" | "C";

export type FileHistoryEntry = {
  hash: string;
  /** In order: the first is the one a diff of the commit is against. */
  parents: string[];
  author: string;
  authorEmail: string;
  /** Author date, in seconds since the epoch. */
  date: number;
  subject: string;
  change: FileHistoryChange;
  /** The file's path at this commit. */
  path: string;
  /** Its path in the commit's first parent: `path`, but for a rename or a
   *  copy, where it is the path it came from. */
  oldPath: string;
  /** A submodule's path: the commits its gitlink moved between, `null` on a
   *  side without one. Its "contents" are no file of this repository's. */
  submodule: { from: string | null; to: string | null } | null;
};
