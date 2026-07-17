import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY,
  mergeContextMenuActionsVisibility
} from "@/backend/utils/contextMenuVisibility";

describe("mergeContextMenuActionsVisibility", () => {
  it("returns all-visible defaults when no user config is given", () => {
    expect(mergeContextMenuActionsVisibility(undefined)).toEqual(
      DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY
    );
    expect(mergeContextMenuActionsVisibility({})).toEqual(DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY);
  });

  it("applies boolean overrides, leaving other actions visible", () => {
    const merged = mergeContextMenuActionsVisibility({
      commitDetailsViewFile: { openFile: false, copyFilePath: false }
    });
    expect(merged.commitDetailsViewFile.openFile).toBe(false);
    expect(merged.commitDetailsViewFile.copyFilePath).toBe(false);
    // Untouched actions in the same category stay visible.
    expect(merged.commitDetailsViewFile.viewDiff).toBe(true);
    // Other categories are unaffected.
    expect(merged.commit.drop).toBe(true);
    expect(merged.branch.delete).toBe(true);
  });

  it("ignores non-boolean and unknown keys", () => {
    const merged = mergeContextMenuActionsVisibility({
      commit: { drop: "nope" as unknown as boolean, bogus: false } as never
    });
    expect(merged.commit.drop).toBe(true); // non-boolean ignored
    expect((merged.commit as Record<string, unknown>).bogus).toBeUndefined(); // unknown key not added
  });

  it("does not mutate the defaults object", () => {
    const merged = mergeContextMenuActionsVisibility({ stash: { drop: false } });
    expect(merged.stash.drop).toBe(false);
    expect(DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY.stash.drop).toBe(true);
  });
});
