/**
 * The Stash side-view's item actions, each with the
 * `contextMenuActionsVisibility.stash` setting that hides it — ADR-0010's
 * `cmvKey` declaration, for stash. The side-view registers one
 * `ging-git-view.stash.<action>` command per entry, extension.ts projects the
 * `ging-git-view.cmv.stash.*` context keys from it (`stashMenuContextKeys`),
 * and package.json's hand-written `stash.*` when-clauses must agree —
 * apps/vscode/tests/backend/utils/stashMenuConsistency.test.ts reads the real
 * package.json and goes red on any divergence.
 *
 * Only `cmvKey` is declared. The branch catalogue's other facts are about
 * delegating to the graph and batching, and neither applies: every stash
 * action here runs in the host (ADR-0029) on one stash.
 */

import type { ContextMenuActionsVisibility } from "@ging/shared/types";

type StashCmvSetting = keyof ContextMenuActionsVisibility["stash"];

export const STASH_ACTION_CATALOGUE = {
  drop: { cmvKey: "drop" },
  // `cmvKey: null` — rename has no visibility setting and is always shown, in
  // the graph's stash menu too; #333 adds none.
  rename: { cmvKey: null },
  copyName: { cmvKey: "copyName" }
} as const satisfies Record<string, { cmvKey: StashCmvSetting | null }>;

export type StashAction = keyof typeof STASH_ACTION_CATALOGUE;

export const STASH_ACTIONS = Object.keys(STASH_ACTION_CATALOGUE) as StashAction[];

/** The command a stash item's menu runs for `action`. */
export const stashActionCommand = (action: StashAction) => `ging-git-view.stash.${action}`;

/**
 * The Stash side-view's `ging-git-view.cmv.stash.*` when-clause context keys,
 * one per declared `cmvKey`, valued by the given visibility snapshot — the
 * stash counterpart of `branchMenuContextKeys`.
 */
export function stashMenuContextKeys(
  cmv: Pick<ContextMenuActionsVisibility, "stash">
): Record<string, boolean> {
  const keys: Record<string, boolean> = {};
  for (const action of STASH_ACTIONS) {
    const cmvKey: StashCmvSetting | null = STASH_ACTION_CATALOGUE[action].cmvKey;
    if (cmvKey !== null) keys[`ging-git-view.cmv.stash.${cmvKey}`] = cmv.stash[cmvKey];
  }
  return keys;
}
