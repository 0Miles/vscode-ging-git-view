export function abbrevCommit(commitHash: string) {
  return commitHash.substring(0, 8);
}

/** A full SHA-1 or SHA-256 commit hash, as git writes them. */
export function isCommitHash(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

/**
 * Whether git would read `revision`, put before the `--`, as an option: it
 * starts with `-` (`--output=…` writes a file). Such a revision is refused,
 * never run, rather than guarded with `--end-of-options`, which git only knows
 * from 2.24, so an older git still reads every revision it read before.
 */
export function readsAsOption(revision: string): boolean {
  return revision.startsWith("-");
}

export function escapeRefName(str: string) {
  return str.replace(/'/g, "'");
}
