export type ScmStashEntry = {
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
