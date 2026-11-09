import * as fs from "node:fs";

/**
 * Find the repository (from `repoPaths`, each a forward-slash repo root) that
 * contains `filePath`, choosing the deepest match when repos are nested. Both
 * inputs must use "/" separators. Returns null when no repo contains the file.
 */
export function repoContainingPath(filePath: string, repoPaths: string[]): string | null {
  let best: string | null = null;
  for (const repo of repoPaths) {
    if (filePath === repo || filePath.startsWith(repo.replace(/\/$/, "") + "/")) {
      if (best === null || repo.length > best.length) best = repo;
    }
  }
  return best;
}

/** Resolve a path to its real path (symlinks followed), or null if it can't be
 *  resolved. Injectable for testing. */
function defaultRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Map a repository path (e.g. one supplied by the VS Code Source Control View,
 * which may go through a symbolic link) to the matching already-known repo,
 * comparing real paths so symlinked and canonical forms of the same repository
 * match. Returns the known repo path, or null when none corresponds.
 */
export function resolveToKnownRepo(
  repoPath: string,
  knownRepoPaths: string[],
  realpath: (p: string) => string | null = defaultRealpath
): string | null {
  if (knownRepoPaths.includes(repoPath)) return repoPath; // exact match — no resolution needed
  const target = realpath(repoPath);
  if (target === null) return null;
  for (const known of knownRepoPaths) {
    if (realpath(known) === target) return known;
  }
  return null;
}
