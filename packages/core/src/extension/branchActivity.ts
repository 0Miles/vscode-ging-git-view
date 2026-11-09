/**
 * Pure (vscode-free) classification of "inactive" branches for the Branches
 * side-view, plus a compact relative-age label. A branch is inactive when its
 * last commit is older than the threshold — that much is a fact about the
 * branch, and it drives the age label even for branches that are never hidden.
 * The hidable subset (see `branchExempt.ts`) is what gets dimmed and removed.
 * Kept free of any `vscode` import so it runs in the fast backend test project;
 * the hiding/dimming lives in `branchesView.ts`.
 */

import {
  type BranchClassification,
  type BranchExemptions,
  emptyClassification,
  withExemptions
} from "./branchExempt";

const SECONDS_PER_DAY = 86_400;

export type ClassifyInactiveInput = {
  branches: readonly string[];
  /** ref → last commit time (unix seconds). A branch with no entry is treated
   *  as active (we never classify a branch whose age we can't determine). */
  dates: Readonly<Record<string, number>>;
  /** Current time in unix seconds (injected so this stays pure & testable). */
  nowSec: number;
  /** Inactivity cutoff in days; `<= 0` disables the feature (nothing matched). */
  thresholdDays: number;
  exemptions: BranchExemptions;
};

/**
 * The branches whose last commit predates the threshold, paired with the subset
 * that may be hidden. Returns an empty classification when the feature is
 * disabled (`thresholdDays <= 0`).
 */
export function classifyInactive(input: ClassifyInactiveInput): BranchClassification {
  const { branches, dates, nowSec, thresholdDays, exemptions } = input;
  if (thresholdDays <= 0) return emptyClassification();
  const cutoff = nowSec - thresholdDays * SECONDS_PER_DAY;
  const matched = new Set<string>();
  for (const branch of branches) {
    const date = dates[branch];
    if (date === undefined) continue; // unknown age → not classified
    if (date < cutoff) matched.add(branch);
  }
  return withExemptions(matched, exemptions);
}

export type RelativeAge = { value: number; unit: "day" | "week" | "month" | "year" };

/**
 * A compact "time since" value for a tree-item description, e.g. `{5, day}`,
 * `{3, week}`. Rounds down to the largest whole unit (approximating months and
 * years — this is a display label, not the inactivity cutoff, which uses the
 * exact threshold in days); clamps negatives to zero days. The unit is
 * rendered through l10n by the view.
 */
export function relativeAge(sec: number, nowSec: number): RelativeAge {
  const days = Math.floor(Math.max(0, nowSec - sec) / SECONDS_PER_DAY);
  if (days < 7) return { value: days, unit: "day" };
  if (days < 30) return { value: Math.floor(days / 7), unit: "week" };
  if (days < 365) return { value: Math.floor(days / 30), unit: "month" };
  return { value: Math.floor(days / 365), unit: "year" };
}
