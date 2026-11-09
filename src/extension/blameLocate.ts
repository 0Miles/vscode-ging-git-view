import { isCommitHash } from "@/backend/utils/string";

import type { CommitLocation } from "./blameHover";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The commit a hover's "locate in the graph" link handed its command, or null
 * for anything else. A command link's arguments come from a URI anyone could
 * write, so both parts are checked: a repository among `knownRepos`, and a full
 * commit hash.
 */
export function commitLocationArgs(
  arg: unknown,
  knownRepos: readonly string[]
): CommitLocation | null {
  if (!isRecord(arg)) return null;
  const { repo, sha } = arg;
  if (typeof repo !== "string" || !knownRepos.includes(repo)) return null;
  if (!isCommitHash(sha)) return null;
  return { repo, sha };
}

/**
 * Whether a repository's branch filter may keep a commit off the graph, so
 * locating it clears the filter through Show All first (#310). `stored` is the
 * filter recorded for the repository, undefined when none is yet: its first
 * load would then apply the configured default filter, which may well hide it.
 * An explicit empty filter shows every branch already.
 */
export function filterMayHideCommit(stored: readonly string[] | undefined): boolean {
  return stored === undefined || stored.length > 0;
}
