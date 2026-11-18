import type { ContextMenuActionsVisibility } from "@ging/shared/types";

/** A `contextMenuActionsVisibility.stash.*` setting. */
export type StashCmvSetting = keyof ContextMenuActionsVisibility["stash"];

/**
 * The Stash side-view's item actions, in the order its menu lists them, each
 * with the `contextMenuActionsVisibility.stash.*` setting that hides it
 * (`null` = always shown: no setting exists for rename, and #333 adds none)
 * and the menu group it sits in (package.json's `1_apply`, `2_modify`,
 * `5_copy`; a divider between two groups).
 *
 * The stash counterpart of ADR-0010's catalogue, declared once for both hosts:
 * VS Code builds its commands and `cmv.stash.*` context keys from it
 * (stashMenuConsistency.test.ts holds package.json to it), the desktop page
 * builds its menu from it (#400), and core runs each (`LISTED_STASH_ACTIONS`).
 */
export const STASH_ACTION_CATALOGUE = {
  apply: { cmvKey: "apply", group: "apply" },
  pop: { cmvKey: "pop", group: "apply" },
  rename: { cmvKey: null, group: "modify" },
  drop: { cmvKey: "drop", group: "modify" },
  copyName: { cmvKey: "copyName", group: "copy" }
} as const satisfies Record<
  string,
  { cmvKey: StashCmvSetting | null; group: "apply" | "modify" | "copy" }
>;

export type StashAction = keyof typeof STASH_ACTION_CATALOGUE;

/** Every stash action, in the menu's order. */
export const STASH_ACTIONS_IN_ORDER = Object.keys(STASH_ACTION_CATALOGUE) as StashAction[];

/** Whether `value` names a stash action: a page is not to be taken at its word. */
export const isStashAction = (value: unknown): value is StashAction =>
  typeof value === "string" && Object.hasOwn(STASH_ACTION_CATALOGUE, value);

/** Whether the settings show `action` on a stash's menu. */
export function stashActionShown(
  action: StashAction,
  cmv: Pick<ContextMenuActionsVisibility, "stash">
): boolean {
  const key: StashCmvSetting | null = STASH_ACTION_CATALOGUE[action].cmvKey;
  return key === null || cmv.stash[key];
}
