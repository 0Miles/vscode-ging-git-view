import type { BlameLine } from "@/backend/queries/blameFile";

/** Which file the avatar cache holds for an author, and when it was saved. */
export type CachedAvatarFile = { file: string; savedAt: number };

export type BlameAvatarDeps = {
  /** Whether avatars may be shown — `ging-git-view.history.fetchAvatars`, with
   *  somewhere to keep them. Asked on every call, so a change applies at once. */
  enabled: () => boolean;
  /** The avatar file cached for `email`; null without one. */
  cached: (email: string) => CachedAvatarFile | null;
  /** A cached avatar file as an image URI; null when it can't be read. */
  read: (file: string) => Promise<string | null>;
  /** Start fetching `email`'s avatar into the cache, without waiting for it. */
  fetch: (email: string, repo: string, commits: string[]) => void;
};

/** How many authors' avatars are kept read, the least recently shown dropped
 *  first. */
const AVATARS_KEPT = 200;

/**
 * The avatar a blame hover shows for a line's author: the cached one, or null.
 * While avatars are off nothing is read or fetched, so nothing leaves the
 * machine. A cached file is read once, and again only when the cache holds
 * another file for the author or saved it anew — or the author was dropped to
 * keep `AVATARS_KEPT`. An avatar not cached yet — or
 * whose file can't be read — is fetched in the background, once per author
 * for as long as this lives, and shows on a later hover.
 */
export function createBlameAvatars(
  deps: BlameAvatarDeps
): (line: Pick<BlameLine, "authorEmail" | "sha">, repo: string) => Promise<string | null> {
  const requested = new Set<string>();
  const read = new Map<string, CachedAvatarFile & { uri: string }>();
  return async ({ authorEmail, sha }, repo) => {
    if (authorEmail === "" || !deps.enabled()) return null;
    const cached = deps.cached(authorEmail);
    const known = read.get(authorEmail);
    if (cached !== null && known?.file === cached.file && known.savedAt === cached.savedAt) {
      // Most recently used goes last, so the first is the one to drop.
      read.delete(authorEmail);
      read.set(authorEmail, known);
      return known.uri;
    }
    const uri = cached === null ? null : await deps.read(cached.file);
    read.delete(authorEmail);
    if (cached !== null && uri !== null) {
      read.set(authorEmail, { ...cached, uri });
      if (read.size > AVATARS_KEPT) read.delete(read.keys().next().value!);
    }
    if (uri === null && !requested.has(authorEmail)) {
      requested.add(authorEmail);
      deps.fetch(authorEmail, repo, [sha]);
    }
    return uri;
  };
}
