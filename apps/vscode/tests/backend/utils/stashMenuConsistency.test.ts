import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY } from "@ging/shared/backend/utils/contextMenuVisibility";
import {
  STASH_ACTION_CATALOGUE,
  STASH_ACTIONS,
  stashActionCommand,
  stashMenuContextKeys,
  type StashAction
} from "@ging/shared/backend/utils/stashActionCatalogue";

/**
 * Consistency lock between the stash catalogue's `cmvKey` declarations and the
 * hand-written `stash.*` menu rows in the real package.json — the stash
 * counterpart of branchMenuConsistency.test.ts (ADR-0010). The when-clauses
 * stay hand written; this suite turns a missed edit into a red test.
 */

type MenuRow = { command: string; when: string };
type CommandRow = { command: string };

const packageJson = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8")
) as {
  contributes: {
    commands: CommandRow[];
    menus: { "view/item/context": MenuRow[]; commandPalette: MenuRow[] };
  };
};

const ITEM_TERMS = ["view == ging-git-view.stash", "viewItem == stash"];
const cmvContextKey = (setting: string) => `ging-git-view.cmv.stash.${setting}`;

/** The Stash view's item rows: every row the stash items' context menu has. */
const stashItemRows = packageJson.contributes.menus["view/item/context"].filter((row) =>
  row.when.includes("view == ging-git-view.stash")
);

/** The cmv term a row carries, or null; any other term fails the suite. */
function cmvTermOf(row: MenuRow): string | null {
  const terms = row.when.split(" && ");
  for (const term of ITEM_TERMS) {
    expect(terms, `${row.command}: scoped to stash items`).toContain(term);
  }
  const rest = terms.filter((t) => !ITEM_TERMS.includes(t));
  const cmv = rest.filter((t) => t.startsWith("ging-git-view.cmv.stash."));
  expect(
    rest.filter((t) => !cmv.includes(t)),
    `${row.command}: unrecognised terms`
  ).toEqual([]);
  expect(cmv.length, `${row.command}: at most one cmv term`).toBeLessThanOrEqual(1);
  return cmv[0] ?? null;
}

/** Widen the const catalogue's literal to its declared type. */
const cmvKeyOf = (action: StashAction): string | null => STASH_ACTION_CATALOGUE[action].cmvKey;

/**
 * Stash settings keys no side-view action claims yet. Apply and pop reach the
 * Stash side-view in #337 (S3b); that ticket empties this list.
 */
const NOT_YET_IN_SIDE_VIEW = ["apply", "pop"];

const byCommand = (a: { command: string }, b: { command: string }) =>
  a.command.localeCompare(b.command);

describe("stash.* menu rows stay consistent with the stash catalogue", () => {
  it("each catalogue action has exactly one stash-item row, gated by its declared cmv key — and no row is outside the catalogue", () => {
    const actual = stashItemRows.map((row) => ({ command: row.command, cmv: cmvTermOf(row) }));
    const expected = STASH_ACTIONS.map((action) => {
      const key = cmvKeyOf(action);
      return { command: stashActionCommand(action), cmv: key === null ? null : cmvContextKey(key) };
    });
    expect(actual.toSorted(byCommand)).toEqual(expected.toSorted(byCommand));
  });

  it("rename is the only keyless action (#333: it has no setting, and none is added)", () => {
    expect(STASH_ACTIONS.filter((a) => cmvKeyOf(a) === null)).toEqual(["rename"]);
  });

  it("each catalogue action is a declared command, hidden from the Command Palette", () => {
    const declared = new Set(packageJson.contributes.commands.map((c) => c.command));
    const hidden = new Set(
      packageJson.contributes.menus.commandPalette
        .filter((row) => row.when === "false")
        .map((row) => row.command)
    );
    for (const action of STASH_ACTIONS) {
      expect(declared.has(stashActionCommand(action)), `${action}: declared`).toBe(true);
      expect(hidden.has(stashActionCommand(action)), `${action}: hidden from the palette`).toBe(
        true
      );
    }
  });

  it("the context-key projection emits exactly the declared keys, each valued by its own setting", () => {
    const declared = STASH_ACTIONS.flatMap((a) => {
      const key = cmvKeyOf(a);
      return key === null ? [] : [cmvContextKey(key)];
    });
    const projected = stashMenuContextKeys(DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY);
    expect(Object.keys(projected).toSorted()).toEqual(declared.toSorted());
    for (const [key, visible] of Object.entries(projected)) {
      expect(visible, `${key}: defaults are all-visible`).toBe(true);
    }
    // Wiring lock: one flipped setting hides exactly its own key, or none
    // when no side-view action declares it.
    for (const setting of Object.keys(DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY.stash)) {
      const cmv = structuredClone(DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY);
      (cmv.stash as Record<string, boolean>)[setting] = false;
      const hidden = Object.entries(stashMenuContextKeys(cmv))
        .filter(([, visible]) => !visible)
        .map(([key]) => key);
      expect(hidden, `stash.${setting}`).toEqual(
        declared.includes(cmvContextKey(setting)) ? [cmvContextKey(setting)] : []
      );
    }
  });

  it("every stash setting is claimed by a catalogue action, apart from the ones still to come", () => {
    const claimed = STASH_ACTIONS.map(cmvKeyOf).filter((key) => key !== null);
    expect([...claimed, ...NOT_YET_IN_SIDE_VIEW].toSorted()).toEqual(
      Object.keys(DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY.stash).toSorted()
    );
  });
});
