/**
 * Pure (vscode-free) classification of "inactive" branches for the Branches
 * side-view, plus a compact relative-age label. A branch is inactive when its
 * last commit is older than the threshold and it isn't exempt — the checked-out
 * head, part of the active filter selection, or matched by an "always show"
 * pattern. Kept free of any `vscode` import so it runs in the fast backend test
 * project; the hiding/dimming lives in `branchesView.ts`.
 */

import { REMOTE_PREFIX } from "./branchTree";

const SECONDS_PER_DAY = 86_400;

/** Names to test against the "always show" patterns: the ref itself and, for a
 *  remote-tracking branch, the value with the `remotes/` prefix stripped
 *  (`origin/main`) and with the remote stripped too (`main`). So a pattern like
 *  `main` exempts `main`, `origin/main` and `remotes/origin/main` alike. */
function exemptCandidates(branch: string): string[] {
  if (!branch.startsWith(REMOTE_PREFIX)) return [branch];
  const withoutRemotes = branch.slice(REMOTE_PREFIX.length); // origin/main
  const slash = withoutRemotes.indexOf("/");
  const bare = slash === -1 ? withoutRemotes : withoutRemotes.slice(slash + 1); // main
  return [branch, withoutRemotes, bare];
}

/** Match `name` against a glob `pattern` supporting `*` (any run, incl. empty)
 *  and `?` (one char). Anchored full-string, case-sensitive (branch names are).
 *  All other regex metacharacters are matched literally. */
export function branchGlobMatches(name: string, pattern: string): boolean {
  // Escape regex metachars except the glob wildcards `*` and `?`...
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  // ...then translate the wildcards. A run of `*` collapses to one `.*` so a
  // pathological pattern (`***…`) can't trigger catastrophic backtracking.
  const body = escaped.replace(/\*+/g, ".*").replace(/\?/g, ".");
  return new RegExp("^" + body + "$").test(name);
}

/** Whether any "always show" pattern matches the branch (across its display
 *  variants — see {@link exemptCandidates}). */
export function isAlwaysShown(branch: string, patterns: readonly string[]): boolean {
  const candidates = exemptCandidates(branch);
  return patterns.some((p) => candidates.some((c) => branchGlobMatches(c, p)));
}

export type ClassifyInactiveInput = {
  branches: readonly string[];
  /** The checked-out branch (never inactive), or null when detached. */
  head: string | null;
  /** ref → last commit time (unix seconds). A branch with no entry is treated
   *  as active (we never hide a branch whose age we can't determine). */
  dates: Readonly<Record<string, number>>;
  /** Current time in unix seconds (injected so this stays pure & testable). */
  nowSec: number;
  /** Inactivity cutoff in days; `<= 0` disables the feature (nothing inactive). */
  thresholdDays: number;
  /** "Always show" name/glob patterns that exempt a branch. */
  exemptPatterns: readonly string[];
  /** Refs in the active filter selection (always shown). */
  selected: readonly string[];
};

/**
 * The set of branch refs classified as inactive (older than the threshold and
 * not exempt). Returns an empty set when the feature is disabled
 * (`thresholdDays <= 0`).
 */
export function classifyInactive(input: ClassifyInactiveInput): Set<string> {
  const { branches, head, dates, nowSec, thresholdDays, exemptPatterns, selected } = input;
  const inactive = new Set<string>();
  if (thresholdDays <= 0) return inactive;
  const cutoff = nowSec - thresholdDays * SECONDS_PER_DAY;
  const selectedSet = new Set(selected);
  for (const branch of branches) {
    if (branch === head) continue;
    if (selectedSet.has(branch)) continue;
    if (isAlwaysShown(branch, exemptPatterns)) continue;
    const date = dates[branch];
    if (date === undefined) continue; // unknown age → keep visible
    if (date < cutoff) inactive.add(branch);
  }
  return inactive;
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
