/**
 * Assembles the cleanup dialog's payload: the candidate rules applied to the
 * shared classification facts, plus the two things the rules alone can't know —
 * how current the basis is, and whether this repo is hiding its remote branches.
 *
 * The payload is built **here, in the extension host**, never in the webview
 * (ADR-0017). Everything it needs already lives beside `branchFacts`
 * (ADR-0013), and computing it here is what lets the caller discover an empty
 * candidate set before summoning the graph panel to say "nothing to clean".
 *
 * Kept free of any `vscode` import, like its neighbours.
 */

import type { SimpleGit } from "simple-git";

import { basisDate } from "@/backend/queries/branchRedundancy";
import { scanBranchRedundancy } from "@/backend/queries/scanBranchRedundancy";
import type { DateType } from "@/backend/types";
import type { BranchCleanupPayload } from "@/types";

import { resolveCleanupCandidates } from "./branchCleanup";
import type { BranchFacts } from "./branchFacts";

export type BranchCleanupDeps = {
  branchFacts: BranchFacts;
  gitClientFor: (repo: string) => SimpleGit;
  /** The repo's "show remote branches" state. A display toggle, and honoured as
   *  one: it is reported in the payload rather than overridden, because it is a
   *  deliberate choice by the user — but never left silent (ADR-0015). */
  resolveShowRemote: (repo: string) => boolean;
  resolveExemptPatterns: () => string[];
  dateType: () => DateType;
};

export type BranchCleanup = ReturnType<typeof createBranchCleanup>;

/** The wire payload plus the refs behind its `scannable` count, which the scan
 *  needs and the webview has no business knowing. */
export type CleanupPayloadWithScannable = {
  payload: BranchCleanupPayload;
  scannable: string[];
};

export function createBranchCleanup(deps: BranchCleanupDeps) {
  async function build(
    repo: string,
    opts?: { hard?: boolean; redundant?: ReadonlySet<string> }
  ): Promise<CleanupPayloadWithScannable> {
    const facts = await deps.branchFacts.facts(repo, { hard: opts?.hard });
    const resolved = resolveCleanupCandidates({
      branches: facts.branches,
      head: facts.head,
      defaultBranch: facts.defaultBranch,
      dates: facts.dates,
      merged: facts.merged,
      inactive: facts.inactive,
      redundant: opts?.redundant,
      patterns: deps.resolveExemptPatterns()
    });
    return {
      payload: {
        candidates: resolved.candidates,
        defaultBranch: resolved.defaultBranch,
        defaultBranchDate:
          resolved.defaultBranch === null
            ? 0
            : await basisDate(deps.gitClientFor(repo), resolved.defaultBranch, deps.dateType()),
        remotesHidden: !deps.resolveShowRemote(repo),
        scannable: resolved.scannable.length
      },
      scannable: resolved.scannable
    };
  }

  return {
    build,

    /**
     * Judge every scannable branch's redundancy, then rebuild the payload with
     * the verdicts folded in.
     *
     * The rebuild is deliberately a whole new payload rather than a patch: the
     * scan can add rows that were in neither fact set (a branch squash merged
     * yesterday is neither merged nor inactive), so the list grows, and sending
     * the grown list whole is what keeps the webview from having to merge two
     * versions of it.
     */
    async scan(
      repo: string,
      hooks: { isCancelled: () => boolean; onProgress: (done: number, total: number) => void }
    ): Promise<{ payload: BranchCleanupPayload; cancelled: boolean }> {
      const before = await build(repo);
      const scanned = await scanBranchRedundancy(deps.gitClientFor(repo), {
        branches: before.scannable,
        isCancelled: hooks.isCancelled,
        onProgress: hooks.onProgress
      });
      const after = await build(repo, { redundant: new Set(scanned.redundant) });
      // The scan reports its own basis, and it can come up empty where the facts
      // did not — a default branch whose tree won't resolve, for instance. Left
      // unsaid, that is indistinguishable from "the scan found nothing", so pass
      // it on as the unanswerable state the dialog already knows how to state.
      const payload =
        scanned.defaultBranch === null
          ? { ...after.payload, defaultBranch: null, scannable: 0 }
          : after.payload;
      return { payload, cancelled: scanned.cancelled };
    }
  };
}
