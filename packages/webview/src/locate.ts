import { planFindLoad } from "./find";

/** What locating a commit in the graph does next (#310). */
export type LocateStep =
  /** The commit is drawn: select it and bring it into view. */
  | { kind: "reveal" }
  /** The graph's history leaves it out, so no amount of loading draws it. */
  | { kind: "notInGraph" }
  /** Widen the loaded commit window to `maxCommits` and look again. */
  | { kind: "load"; maxCommits: number };

/**
 * The next step of a locate, from whether the commit is drawn and where it sits
 * in the graph's `git log` (null: nowhere). The window is sized the way Find
 * sizes it for a match past the loaded window ({@link planFindLoad}), on the
 * same `git log` ruler; and like Find's it only ever widens. A depth that says
 * the window reaches already, with the commit still not drawn, means history
 * moved since it was measured — so the window is loaded once more as it is,
 * and whatever lands is the answer.
 */
export function planLocate(input: {
  loaded: boolean;
  logDepth: number | null;
  maxCommits: number;
}): LocateStep {
  if (input.loaded) return { kind: "reveal" };
  if (input.logDepth === null) return { kind: "notInGraph" };
  const plan = planFindLoad(input.maxCommits, { loaded: false, logDepth: input.logDepth });
  return { kind: "load", maxCommits: plan?.maxCommits ?? input.maxCommits };
}
