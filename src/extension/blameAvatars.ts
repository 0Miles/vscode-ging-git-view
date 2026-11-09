import type { BlameLine } from "@/backend/queries/blameFile";

export type BlameAvatarDeps = {
  /** Whether avatars may be shown — `ging-git-view.history.fetchAvatars`, with
   *  somewhere to keep them. Asked on every call, so a change applies at once. */
  enabled: () => boolean;
  /** The avatar already cached for `email`, as an image URI; null without one. */
  cached: (email: string) => Promise<string | null>;
  /** Start fetching `email`'s avatar into the cache, without waiting for it. */
  fetch: (email: string, repo: string, commits: string[]) => void;
};

/**
 * The avatar a blame hover shows for a line's author: the cached one, or null.
 * While avatars are off nothing is read or fetched, so nothing leaves the
 * machine. An avatar not cached yet is fetched in the background — once per
 * author for as long as this lives — and shows on a later hover.
 */
export function createBlameAvatars(
  deps: BlameAvatarDeps
): (line: Pick<BlameLine, "authorEmail" | "sha">, repo: string) => Promise<string | null> {
  const requested = new Set<string>();
  return async ({ authorEmail, sha }, repo) => {
    if (authorEmail === "" || !deps.enabled()) return null;
    const cached = await deps.cached(authorEmail);
    if (cached === null && !requested.has(authorEmail)) {
      requested.add(authorEmail);
      deps.fetch(authorEmail, repo, [sha]);
    }
    return cached;
  };
}
