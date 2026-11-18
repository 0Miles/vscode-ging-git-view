import * as fs from "node:fs";
import * as path from "node:path";

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

/**
 * The repository paths in `repoPaths` that are not yet known under any
 * spelling (see `resolveToKnownRepo`), in order. Of two spellings of one new
 * repository only the first is kept. A path that cannot be resolved counts as
 * new unless it is known exactly as spelled.
 */
export function reposNotYetKnown(
  repoPaths: string[],
  knownRepoPaths: string[],
  realpath: (p: string) => string | null = defaultRealpath
): string[] {
  const known = [...knownRepoPaths];
  const fresh: string[] = [];
  for (const repoPath of repoPaths) {
    if (resolveToKnownRepo(repoPath, known, realpath) !== null) continue;
    fresh.push(repoPath);
    known.push(repoPath);
  }
  return fresh;
}

export type RepoLocation = { repo: string; filePath: string };

/** Finds the known repository holding a file: see `createRepoLocator`. */
export type RepoLocator = (filePath: string, knownRepoPaths: string[]) => RepoLocation | null;

/** How many missed files a locator remembers per set of known repositories. */
const LOCATED_FILES_KEPT = 256;

/** `p` with "/" separators and no trailing one. */
function slashed(p: string): string {
  return (path.sep === "\\" ? p.replace(/\\/g, "/") : p).replace(/\/+$/, "");
}

/**
 * The real path of `filePath` ("/" separators), or null. A file that does not
 * exist is resolved through its nearest existing folder, keeping the rest of
 * the path as given.
 */
function realFilePath(filePath: string, realpath: (p: string) => string | null): string | null {
  let head = filePath.replace(/\/+$/, "");
  let tail = "";
  for (;;) {
    const real = realpath(head);
    if (real !== null) return slashed(real) + tail;
    const cut = head.lastIndexOf("/");
    // Stop at the root: "" on POSIX, a bare drive ("C:") on Windows, which
    // would resolve to that drive's current folder rather than its root.
    if (cut <= 0 || /^[A-Za-z]:$/.test(head.slice(0, cut))) return null;
    tail = head.slice(cut) + tail;
    head = head.slice(0, cut);
  }
}

/**
 * A `blameLocation` that also matches a file spelled differently from the
 * known repository holding it: through a link, and on Windows by a short name
 * or another letter case (#435). It answers with the repository as it is known
 * and the file's path inside it as git spells it.
 *
 * A file whose path starts with a known repository is answered from the
 * strings alone, as `blameLocation` does. Only a file that matches none is
 * resolved on disk, and since the cursor moves within one file far more often
 * than it changes files, the answer is remembered until the known repositories
 * change; their real paths are remembered for as long as the locator lives.
 */
export function createRepoLocator(
  realpath: (p: string) => string | null = defaultRealpath
): RepoLocator {
  const realRepoPaths = new Map<string, string>();
  const located = new Map<string, RepoLocation | null>();
  let locatedFor: string | null = null;

  const realRepoPath = (repo: string): string | null => {
    const cached = realRepoPaths.get(repo);
    if (cached !== undefined) return cached;
    const real = realpath(repo);
    if (real === null) return null; // not remembered: it may exist later
    const spelled = slashed(real);
    realRepoPaths.set(repo, spelled);
    return spelled;
  };

  const locateOnDisk = (filePath: string, knownRepoPaths: string[]): RepoLocation | null => {
    const real = realFilePath(filePath, realpath);
    if (real === null) return null;
    let best: { repo: string; root: string } | null = null;
    for (const repo of knownRepoPaths) {
      const root = realRepoPath(repo);
      if (root === null || !real.startsWith(root + "/")) continue;
      if (best === null || root.length > best.root.length) best = { repo, root };
    }
    return best === null ? null : { repo: best.repo, filePath: real.slice(best.root.length + 1) };
  };

  return (filePath, knownRepoPaths) => {
    if (repoContainingPath(filePath, knownRepoPaths) !== null) {
      return blameLocation(filePath, knownRepoPaths);
    }
    const knownKey = knownRepoPaths.join("\0");
    if (knownKey !== locatedFor) {
      located.clear();
      locatedFor = knownKey;
    }
    const cached = located.get(filePath);
    if (cached !== undefined) return cached;
    const location = locateOnDisk(filePath, knownRepoPaths);
    if (located.size >= LOCATED_FILES_KEPT) located.delete(located.keys().next().value as string);
    located.set(filePath, location);
    return location;
  };
}

/** The locator inline blame and "open to the repo of the active editor" share. */
export const locateInKnownRepos: RepoLocator = createRepoLocator();
