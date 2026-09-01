import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY,
  mergeContextMenuActionsVisibility
} from "@/backend/utils/contextMenuVisibility";

type VisibilitySchema = {
  properties: Record<string, { properties: Record<string, unknown> }>;
};

const packageJson = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8")
) as {
  contributes: {
    configuration: {
      properties: Record<string, { properties?: VisibilitySchema["properties"] }>;
    };
  };
};

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

  it("declares in package.json exactly the actions it merges, category by category", () => {
    // The settings schema is what users read and what VS Code validates
    // against, and it is hand-written — so a key removed from one side and
    // left on the other is invisible until someone finds a switch that does
    // nothing. That is the drift #173 came to clear (`commit.rebaseOnto`
    // outlived the menu entry it gated), so it gets a lock rather than a
    // one-off deletion.
    const schema =
      packageJson.contributes.configuration.properties["ging-git-view.contextMenuActions"];
    const declared = Object.fromEntries(
      Object.entries(schema.properties!).map(([category, spec]) => [
        category,
        Object.keys(spec.properties).toSorted()
      ])
    );
    const merged = Object.fromEntries(
      Object.entries(DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY).map(([category, actions]) => [
        category,
        Object.keys(actions).toSorted()
      ])
    );
    expect(declared).toEqual(merged);
  });

  it("keeps no rebaseOnto switch on the commit menu, whose entry no longer exists", () => {
    // #173 folded the standalone `rebase --onto` entry into the plain rebase
    // one, which `commit.rebase` gates. A surviving switch would promise to
    // hide something nothing reads.
    expect(DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY.commit).not.toHaveProperty("rebaseOnto");
    expect(
      mergeContextMenuActionsVisibility({ commit: { rebaseOnto: false } as never }).commit
    ).not.toHaveProperty("rebaseOnto");
  });

  it("does not mutate the defaults object", () => {
    const merged = mergeContextMenuActionsVisibility({ stash: { drop: false } });
    expect(merged.stash.drop).toBe(false);
    expect(DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY.stash.drop).toBe(true);
  });
});
