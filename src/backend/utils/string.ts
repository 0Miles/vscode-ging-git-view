export function abbrevCommit(commitHash: string) {
  return commitHash.substring(0, 8);
}

/** A full SHA-1 or SHA-256 commit hash, as git writes them. */
export function isCommitHash(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

export function escapeRefName(str: string) {
  return str.replace(/'/g, "'");
}
