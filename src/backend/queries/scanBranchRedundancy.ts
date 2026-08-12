/**
 * The many-branch counterpart of `branchRedundancy.ts`: which of these branches
 * would contribute nothing if merged into the default branch.
 *
 * Same verdict, same mechanism — `git merge-tree --write-tree` against the
 * default branch, compared with that branch's own tree (ADR-0006) — but only
 * the verdict. None of the evidence the single-branch dialog shows (the
 * cherry-marked commit list, the basis date) is gathered here: this feeds a
 * checklist, and a list of commits per branch would multiply the cost of the one
 * thing that makes the scan expensive.
 *
 * What makes it affordable at all is hoisting: the default branch is detected
 * once and its tree read once for the whole scan, leaving exactly one git call
 * per branch. The single-branch path pays both per call, which across N branches
 * would be N extra spawns before any merge even starts.
 *
 * Nothing here fetches. The caller reports the basis and its age so the user can
 * see how current the answer is (ADR-0015).
 */

import type { SimpleGit } from "simple-git";

import { detectDefaultBranch } from "./defaultBranch";

const eolRegex = /\r\n|\r|\n/g;

export type ScanBranchRedundancyInput = {
  /** The branches to judge, in the order progress should advance. */
  branches: readonly string[];
  /** Polled between branches so the user can stop a long scan. Nothing is
   *  undone — the verdicts already reached are returned. */
  isCancelled?: () => boolean;
  /** Called after each branch is judged, for the dialog's progress. */
  onProgress?: (done: number, total: number) => void;
};

export type ScanBranchRedundancyResult = {
  /** The basis every verdict was measured against; null when it couldn't be
   *  resolved, which leaves `redundant` empty — with nothing to merge into,
   *  there is no question to answer. */
  defaultBranch: string | null;
  /** The branches that would contribute nothing, in input order. */
  redundant: string[];
  /** True when the scan stopped early; the verdicts so far still stand. */
  cancelled: boolean;
};

/** Run a git command, reporting failure as null rather than throwing. */
async function tryRaw(git: SimpleGit, args: string[]): Promise<string | null> {
  try {
    return await git.raw(args);
  } catch {
    return null;
  }
}

export async function scanBranchRedundancy(
  git: SimpleGit,
  input: ScanBranchRedundancyInput
): Promise<ScanBranchRedundancyResult> {
  const none = { redundant: [], cancelled: false };
  const defaultBranch = await detectDefaultBranch(git);
  if (defaultBranch === null) return { defaultBranch: null, ...none };

  // Read once for the whole scan: every branch is compared against this.
  const target = await tryRaw(git, ["rev-parse", defaultBranch + "^{tree}"]);
  if (target === null) return { defaultBranch: null, ...none };
  const targetTree = target.trim();

  const redundant: string[] = [];
  let done = 0;
  for (const branch of input.branches) {
    if (input.isCancelled?.() === true) {
      return { defaultBranch, redundant, cancelled: true };
    }
    // A failure here is "we could not judge this one", never "it is redundant":
    // unrelated histories, a ref that has since gone, and a git older than 2.38
    // all land on this branch of the code, and the safe reading of all three is
    // to leave the branch out of the proposal.
    // Sequential on purpose: each of these is a full in-memory merge, and firing
    // them all at once would spawn a git process per branch while making both
    // the progress count and the cancellation check meaningless.
    // eslint-disable-next-line no-await-in-loop -- see above
    const merged = await tryRaw(git, ["merge-tree", "--write-tree", defaultBranch, branch]);
    if (merged !== null && merged.split(eolRegex)[0].trim() === targetTree) {
      redundant.push(branch);
    }
    input.onProgress?.(++done, input.branches.length);
  }
  return { defaultBranch, redundant, cancelled: false };
}
