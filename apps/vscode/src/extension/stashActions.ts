import {
  LISTED_STASH_ACTIONS,
  type ListedStashHost,
  type StashListItem
} from "@ging/core/extension/stashList";
import {
  STASH_ACTION_CATALOGUE,
  type StashAction,
  type StashCmvSetting
} from "@ging/shared/backend/utils/stashActionCatalogue";
import type { ContextMenuActionsVisibility } from "@ging/shared/types";

export type { StashAction };

/**
 * The Stash side-view's item actions, so its commands, its `cmv.stash.*`
 * context keys and package.json's hand-written when-clauses cannot drift
 * apart (ADR-0010's `cmvKey`, for stash; `null` = always shown): the shared
 * catalogue's `cmvKey` with what core runs for each. The desktop side view
 * reads the same two (#400). stashMenuConsistency.test.ts holds package.json
 * to this table.
 */
export const STASH_ACTIONS = Object.fromEntries(
  (Object.keys(STASH_ACTION_CATALOGUE) as StashAction[]).map((action) => [
    action,
    { cmvKey: STASH_ACTION_CATALOGUE[action].cmvKey, run: LISTED_STASH_ACTIONS[action] }
  ])
) as {
  [A in StashAction]: {
    cmvKey: (typeof STASH_ACTION_CATALOGUE)[A]["cmvKey"];
    run: (host: ListedStashHost, stash: StashListItem) => Promise<unknown>;
  };
};

/** The command a stash item's menu runs for `action`. */
export const stashActionCommand = (action: StashAction) => `ging-git-view.stash.${action}`;

/** The `ging-git-view.cmv.stash.*` context keys, one per declared `cmvKey`,
 *  valued by the given visibility snapshot. */
export function stashMenuContextKeys(
  cmv: Pick<ContextMenuActionsVisibility, "stash">
): Record<string, boolean> {
  const keys: Record<string, boolean> = {};
  for (const { cmvKey } of Object.values(STASH_ACTIONS)) {
    const key: StashCmvSetting | null = cmvKey;
    if (key !== null) keys[`ging-git-view.cmv.stash.${key}`] = cmv.stash[key];
  }
  return keys;
}
