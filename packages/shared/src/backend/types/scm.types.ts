export type ScmStashEntry = {
  /** The stash commit's SHA: what names the stash, since its `ref` moves
   *  whenever a stash above it is pushed or dropped. */
  hash: string;
  /** The selector, e.g. `stash@{0}`. */
  ref: string;
  index: number;
  message: string;
  date: number | null;
};

export type WorktreeEntry = {
  /** Absolute path to the worktree's working directory. */
  path: string;
  /** Short branch name (without `refs/heads/`), or null when detached or bare. */
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
};
