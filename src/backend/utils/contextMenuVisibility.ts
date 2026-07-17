import type { ContextMenuActionsVisibility } from "@/types";

/** Every context-menu action is visible by default. */
export const DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY: ContextMenuActionsVisibility = {
  commit: {
    addTag: true,
    createBranch: true,
    checkout: true,
    cherrypick: true,
    revert: true,
    merge: true,
    reset: true,
    rebase: true,
    drop: true,
    copyHash: true,
    copySubject: true
  },
  branch: {
    checkout: true,
    rename: true,
    push: true,
    createArchive: true,
    delete: true,
    merge: true,
    rebase: true,
    copyName: true
  },
  remoteBranch: {
    checkout: true,
    merge: true,
    pull: true,
    fetch: true,
    delete: true,
    copyName: true
  },
  tag: { viewDetails: true, delete: true, push: true, createArchive: true, copyName: true },
  stash: { apply: true, pop: true, drop: true, copyName: true },
  uncommittedChanges: { openSourceControlView: true, reset: true, clean: true },
  commitDetailsViewFile: {
    viewDiff: true,
    viewFileAtThisRevision: true,
    viewDiffWithWorkingFile: true,
    openFile: true,
    resetFileToThisRevision: true,
    copyFilePath: true
  }
};

type DeepPartialVisibility = {
  [C in keyof ContextMenuActionsVisibility]?: Partial<ContextMenuActionsVisibility[C]>;
};

/**
 * Merge a user's (partial) `contextMenuActionsVisibility` setting over the
 * all-visible defaults. Only boolean overrides are honoured; any missing
 * category or action keeps its default of visible.
 */
export function mergeContextMenuActionsVisibility(
  userConfig: DeepPartialVisibility | undefined | null
): ContextMenuActionsVisibility {
  const result = {} as ContextMenuActionsVisibility;
  for (const category of Object.keys(
    DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY
  ) as (keyof ContextMenuActionsVisibility)[]) {
    const defaults = DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY[category];
    const overrides = userConfig?.[category];
    const merged: Record<string, boolean> = { ...defaults };
    if (overrides && typeof overrides === "object") {
      for (const action of Object.keys(defaults)) {
        const value = (overrides as Record<string, unknown>)[action];
        if (typeof value === "boolean") merged[action] = value;
      }
    }
    (result as Record<string, unknown>)[category] = merged;
  }
  return result;
}
