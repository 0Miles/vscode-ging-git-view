import type { GitRunOptions } from "@ging/core/backend/gitRun";
import {
  type BlamedCommit,
  blameCommitChange,
  blameLineExcerpt,
  type CommitChange,
  type HunkExcerpt,
  hunkAt
} from "@ging/core/backend/queries/blameCommitChange";
import type { BlameLine } from "@ging/core/backend/queries/blameFile";

import type { BlameHoverDetails } from "./blameHover";
import { createLatestLoads } from "./latestLoads";

/** How many commits' changes the hovers keep. */
const CHANGE_CACHE_SIZE = 100;
/** How many excerpts of hunks too big to keep whole the hovers keep. */
const EXCERPT_CACHE_SIZE = 200;

/** A hover lookup: a blamed line's commit, in a repository. */
type HoverLookup = { commit: BlamedCommit; repo: string };
const lookupKey = ({ commit, repo }: HoverLookup) =>
  JSON.stringify([
    repo,
    commit.sha,
    commit.filename,
    commit.previous?.sha,
    commit.previous?.filename
  ]);

export type BlameHoverLookups = {
  /** What the hover of committed `line`, blamed in `repo`, shows beyond its
   *  blame: the commit's message and the hunk holding the line, and the
   *  author's avatar. Each part is null when it can't be had. */
  details(line: BlameLine, repo: string): Promise<BlameHoverDetails>;
  /** Abort what is being looked up: no hover is waiting for it any more. */
  cancel(): void;
};

/**
 * The lookups behind a blame hover, as both hosts draw one — VS Code's inline
 * blame (`blameController`) and the desktop app's blame view (#409). Each
 * commit's change is kept (bounded), as it never changes; only the latest
 * lookup runs git, the one before it aborted (see `createLatestLoads`). A hunk
 * too big for its change to keep is looked up again, for the one line.
 */
export function createBlameHoverLookups(deps: {
  /** Where and how a lookup's git runs in `repo`; its deadline starts now. */
  gitIn: (repo: string) => GitRunOptions;
  /** The author's avatar as an image URI; none when not given. */
  avatarOf?: (line: BlameLine, repo: string) => Promise<string | null>;
}): BlameHoverLookups {
  /** Each commit's change to a file. */
  const changes = createLatestLoads<HoverLookup, CommitChange>({
    key: lookupKey,
    load: ({ commit: { sha, filename, previous }, repo }, signal) =>
      blameCommitChange({ ...deps.gitIn(repo), signal, sha, filename, previous }),
    size: CHANGE_CACHE_SIZE
  });
  /** The excerpt for one line of a hunk too big for its change to keep. */
  const excerpts = createLatestLoads<HoverLookup & { line: number }, HunkExcerpt>({
    key: (lookup) => `${lookupKey(lookup)}:${lookup.line}`,
    load: ({ commit: { sha, filename, previous }, repo, line }, signal) =>
      blameLineExcerpt({ ...deps.gitIn(repo), signal, sha, filename, previous, line }),
    size: EXCERPT_CACHE_SIZE
  });
  const avatarOf = deps.avatarOf ?? (async () => null);

  return {
    async details(line, repo) {
      const lookup = { commit: line, repo };
      const [change, avatar] = await Promise.all([
        changes.get(lookup),
        avatarOf(line, repo).catch(() => null)
      ]);
      const found = change === null ? null : hunkAt(change, line.originalLine);
      const hunk =
        found === "left out" ? await excerpts.get({ ...lookup, line: line.originalLine }) : found;
      return { message: change?.message ?? null, hunk, avatar };
    },
    cancel() {
      changes.cancel();
      excerpts.cancel();
    }
  };
}
