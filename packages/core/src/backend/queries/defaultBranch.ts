import type { SimpleGit } from "simple-git";

import {
  parseRefnames,
  PRIMARY_BRANCHES,
  REMOTE_PREFIX,
  splitRemoteRef
} from "@/backend/utils/branchRef";

/** The remote names appearing in a ref list, `origin` first when present. */
function remotesIn(refs: readonly string[]): string[] {
  const seen: string[] = [];
  for (const ref of refs) {
    const split = splitRemoteRef(ref);
    if (split === null || seen.includes(split.remote)) continue;
    seen.push(split.remote);
  }
  return seen.includes("origin") ? ["origin", ...seen.filter((r) => r !== "origin")] : seen;
}

/** {@link resolveDefaultBranch} against the repo's own ref list — the entry
 *  point for callers that don't already hold one. Deliberately scans both
 *  namespaces regardless of what the view is showing (see the note on
 *  `allRefs` below), and reports null on a failed read, which disables every
 *  default-branch-derived feature. */
export async function detectDefaultBranch(git: SimpleGit): Promise<string | null> {
  try {
    const raw = await git.raw([
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads",
      "refs/remotes"
    ]);
    return await resolveDefaultBranch(git, parseRefnames(raw));
  } catch {
    return null;
  }
}

/**
 * The repo's default branch — the sole basis for merged-branch classification —
 * as a ref in branch-list format (`main`, or `remotes/origin/main`), or null
 * when it can't be determined. Callers disable merged classification entirely
 * on null rather than guessing: the marking promises "safe to delete", and the
 * wrong default branch would break that.
 *
 * Resolution order: `<remote>/HEAD` (origin first), then a primary branch on a
 * remote, then a local primary branch.
 *
 * `allRefs` must be the repo's **complete** ref list, not the subset the view
 * happens to be showing. Which branch is the default is a fact about the repo;
 * deriving it from the displayed list would make "show remote branches" silently
 * turn merged classification off in any repo whose default branch lives only
 * on the remote.
 */
export async function resolveDefaultBranch(
  git: SimpleGit,
  allRefs: readonly string[]
): Promise<string | null> {
  const available = new Set(allRefs);
  const remotes = remotesIn(allRefs);

  // Asked of every remote at once, then consumed in priority order: the answers
  // are independent, and all but the first are usually thrown away.
  const heads = await Promise.all(
    remotes.map(async (remote) => {
      try {
        const raw = await git.raw(["symbolic-ref", "--short", "refs/remotes/" + remote + "/HEAD"]);
        return raw.split("\n")[0].trim();
      } catch {
        return ""; // this remote has no HEAD configured
      }
    })
  );
  for (const target of heads) {
    if (target === "") continue;
    const ref = REMOTE_PREFIX + target;
    if (available.has(ref)) return ref;
  }

  for (const remote of remotes) {
    for (const name of PRIMARY_BRANCHES) {
      const ref = REMOTE_PREFIX + remote + "/" + name;
      if (available.has(ref)) return ref;
    }
  }

  for (const name of PRIMARY_BRANCHES) {
    if (available.has(name)) return name;
  }

  return null;
}
