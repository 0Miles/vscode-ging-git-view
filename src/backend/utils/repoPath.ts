import * as fs from "node:fs";

/**
 * Whether a repo path can still be handed to `gitClientFactory`.
 *
 * simple-git validates `baseDir` synchronously at construction, so a path
 * whose directory is gone — or that was never a directory — makes the
 * constructor throw. Its own guard (`folderExists`) swallows only `ENOENT` and
 * re-throws everything else, which is why this one is deliberately wider:
 * anything we cannot stat is unusable, because handing it over would raise an
 * error whose shape we cannot enumerate. Measured, the members of that
 * re-throw branch vary by platform — a path running through a file answers
 * `ENOTDIR` on POSIX but `ENOENT` on Windows — so a whitelist of error codes
 * would be wrong somewhere by construction. Detection cannot be complete;
 * refusing on any failure can.
 *
 * `isDirectory`, not "exists": simple-git checks for a FOLDER, and a path
 * naming a file passes `fs.stat` but still throws at construction.
 */
export function isUsableRepoPath(repoPath: string): boolean {
  try {
    return fs.statSync(repoPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The Current repository a persisted path still names, or null when it names
 * nothing usable any more.
 *
 * The value is deliberately *not* deleted from storage when this returns null.
 * No probe can tell "the directory was deleted" from "the drive is not mounted
 * right now": both answer `ENOENT`, and every UNC failure answers `UNKNOWN`.
 * Keeping the string costs nothing and lets an unplugged disk come back on its
 * own; deleting it would silently cost the user their selection.
 */
export function resolveCurrentRepo(
  persisted: string | null,
  isUsable: (p: string) => boolean = isUsableRepoPath
): string | null {
  if (persisted === null || persisted === "") return null;
  return isUsable(persisted) ? persisted : null;
}

/**
 * Which repo the graph should boot on: the Current repository when it resolved,
 * otherwise the first known repository whose directory is still there.
 *
 * This is the host's call, not the webview's — the webview receives the repo
 * set but cannot check any of it against the file system. `find` stops at the
 * first hit, so the ordinary cost is one stat.
 */
export function pickBootRepo(
  currentRepo: string | null,
  knownRepoPaths: string[],
  isUsable: (p: string) => boolean = isUsableRepoPath
): string | null {
  if (currentRepo !== null) return currentRepo;
  return knownRepoPaths.find((p) => isUsable(p)) ?? null;
}
