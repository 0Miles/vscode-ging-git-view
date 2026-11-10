import { isCommitHash } from "@ging/core/backend/utils/string";
import type { ResponseBranchFilterCleared } from "@ging/shared/types";

import { isRecord } from "./blameLineChange";

/** A blamed line's commit, as the hover's "locate in the graph" link hands it
 *  to its command: the full SHA, in the repository the line is blamed in. */
export type CommitLocation = { repo: string; sha: string };

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
 * Run Show All for the graph's `clearBranchFilter`, then acknowledge it. Any
 * filter Show All changes is posted while it runs (the filter store fires
 * synchronously), so the acknowledgement always comes after it; a locate
 * waiting on Show All (#310) reads one with no empty filter ahead of it as
 * "Show All moved nothing". Acknowledged however Show All ends — a failed one
 * moved nothing either, and without the acknowledgement that locate would
 * linger for some later Show All to revive. A failure still propagates.
 */
export async function acknowledgeShowAll(
  showAll: () => PromiseLike<unknown>,
  post: (msg: ResponseBranchFilterCleared) => void
): Promise<void> {
  try {
    await showAll();
  } finally {
    post({ command: "branchFilterCleared" });
  }
}
