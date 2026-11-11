import {
  applyOrPopListedStash,
  copyStashName,
  dropListedStash,
  type ListedStashHost,
  renameListedStash,
  type StashListItem
} from "@ging/core/extension/stashList";
import type { ContextMenuActionsVisibility } from "@ging/shared/types";

type StashCmvSetting = keyof ContextMenuActionsVisibility["stash"];

/**
 * The Stash side-view's item actions, declared once so its commands, its
 * `cmv.stash.*` context keys and package.json's hand-written when-clauses
 * cannot drift apart (ADR-0010's `cmvKey`, for stash; `null` = always shown).
 * stashMenuConsistency.test.ts holds package.json to this table.
 */
export const STASH_ACTIONS = {
  apply: { cmvKey: "apply", run: (host, stash) => applyOrPopListedStash(host, stash, "apply") },
  pop: { cmvKey: "pop", run: (host, stash) => applyOrPopListedStash(host, stash, "pop") },
  drop: { cmvKey: "drop", run: dropListedStash },
  // No setting exists for rename, and #333 adds none.
  rename: { cmvKey: null, run: renameListedStash },
  copyName: { cmvKey: "copyName", run: copyStashName }
} as const satisfies Record<
  string,
  {
    cmvKey: StashCmvSetting | null;
    run: (host: ListedStashHost, stash: StashListItem) => Promise<unknown>;
  }
>;

export type StashAction = keyof typeof STASH_ACTIONS;

/** The command a stash item's menu runs for `action`. */
export const stashActionCommand = (action: StashAction) => `ging-git-view.stash.${action}`;

/** The `ging-git-view.cmv.stash.*` context keys, one per declared `cmvKey`,
 *  valued by the given visibility snapshot. */
export function stashMenuContextKeys(
  cmv: Pick<ContextMenuActionsVisibility, "stash">
): Record<string, boolean> {
  const keys: Record<string, boolean> = {};
  for (const { cmvKey } of Object.values(STASH_ACTIONS)) {
    if (cmvKey !== null) keys[`ging-git-view.cmv.stash.${cmvKey}`] = cmv.stash[cmvKey];
  }
  return keys;
}
