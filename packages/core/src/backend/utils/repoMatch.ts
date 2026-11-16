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

/**
 * Where inline blame blames `filePath`: the known repository containing it
 * (the deepest, so a submodule or worktree file gets its own repository) and
 * the file's path inside it. Null outside every known repository, or for a
 * repository root itself. Same "/" separator contract as `repoContainingPath`.
 */
export function blameLocation(
  filePath: string,
  knownRepoPaths: string[]
): { repo: string; filePath: string } | null {
  const repo = repoContainingPath(filePath, knownRepoPaths);
  if (repo === null) return null;
  const root = repo.replace(/\/$/, "");
  if (filePath.length <= root.length + 1) return null;
  return { repo, filePath: filePath.slice(root.length + 1) };
}

/**
 * Resolve a path to the one spelling the OS gives its directory, or null if
 * it can't be resolved. Injectable for testing.
 *
 * The OS is asked first (`realpathSync.native`): only it expands a Windows 8.3
 * short name (`C:/Users/RUNNER~1`) and restores the letter case on disk, both
 * of which git does too when it reports a repository's path (#413). It fails
 * on some network drives and RAM disks where Node's own implementation works
 * — the reason Node does not use it by default — so that one is the fallback;
 * it follows links only.
 *
 * The fallback is decided per call, so two paths compared could in theory be
 * resolved by different implementations. That is accepted: the native one
 * fails by volume, so two spellings of one directory fail together, and a
 * mixed pair can only miss a match (what happened before), never invent one.
 */
function defaultRealpath(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    try {
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  }
}

/**
 * Map a repository path (e.g. one supplied by the VS Code Source Control View,
 * which may go through a symbolic link) to the matching already-known repo,
 * comparing real paths so every spelling of the same repository matches: a
 * link to it, and on Windows a short name or another letter case. Returns the
 * known repo path, or null when none corresponds.
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
