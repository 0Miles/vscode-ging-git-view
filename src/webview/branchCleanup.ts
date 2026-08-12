/**
 * The cleanup dialog's rules that are worth stating apart from its markup.
 *
 * The dialog itself lives in `main.ts` beside the other dialogs (it asks the
 * user something, so it belongs in the graph — ADR-0009/ADR-0014); what lives
 * here is the part with a decision behind it.
 */

import type { CleanupCandidate } from "@/types";

/**
 * Which rows open pre-checked: the ones whose content is already on the
 * mainline, i.e. merged **or** redundant.
 *
 * Inactive is deliberately never pre-checked, and that omission is the only
 * mechanism holding ADR-0015 up. Remote candidates are offered on the same terms
 * as local ones, and a remote branch idle for years is very likely a colleague's
 * work; unlike merged and redundant, inactivity makes no claim that the content
 * is safe to lose. Anything that would pre-check it needs to revisit that ADR
 * first.
 *
 * The result keeps the list's order, which is the side-view's tree order.
 */
export function defaultCheckedRefs(candidates: readonly CleanupCandidate[]): string[] {
  return candidates.filter((c) => c.facts.merged || c.facts.redundant).map((c) => c.ref);
}

/** How a group's select-all header should read. */
export type GroupToggleState = "all" | "some" | "none";

/**
 * The state of the Remote / Local header checkbox for one group.
 *
 * Tri-state on purpose: `some` is what lets the header render indeterminate
 * instead of claiming something untrue about the rows under it. An empty group
 * is `none` rather than `all` — `[].every()` is true, which would put a ticked
 * header over nothing.
 */
export function groupToggleState(
  candidates: readonly CleanupCandidate[],
  checked: ReadonlySet<string>,
  isRemote: boolean
): GroupToggleState {
  const group = candidates.filter((c) => c.isRemote === isRemote);
  if (group.length === 0) return "none";
  const ticked = group.filter((c) => checked.has(c.ref)).length;
  if (ticked === 0) return "none";
  return ticked === group.length ? "all" : "some";
}

/**
 * The checked set after the list is replaced — which a deep check or a fetch
 * does, whole (ADR-0014).
 *
 * Rows the user has already been offered keep whatever they decided; only rows
 * appearing for the first time get {@link defaultCheckedRefs}' treatment. Both
 * halves matter: re-running the default over everything would silently re-check
 * a branch the user had deliberately unticked, while defaulting nothing would
 * leave a scan's whole point — the squash-merged branches it just found —
 * sitting unchecked.
 */
export function mergeCheckedRefs(input: {
  candidates: readonly CleanupCandidate[];
  /** Every ref the user has been offered so far, checked or not. */
  shown: ReadonlySet<string>;
  checked: ReadonlySet<string>;
}): string[] {
  const fresh = new Set(
    defaultCheckedRefs(input.candidates.filter((c) => !input.shown.has(c.ref)))
  );
  return input.candidates
    .filter((c) => (input.shown.has(c.ref) ? input.checked.has(c.ref) : fresh.has(c.ref)))
    .map((c) => c.ref);
}
