import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY } from "@/backend/utils/contextMenuVisibility";
import {
  branchMenuContextKeys,
  CATALOGUE_REF_ACTIONS,
  REF_ACTION_CATALOGUE,
  refActionVisibility,
  type CatalogueRefAction,
  type CmvKey
} from "@/backend/utils/refActionCatalogue";

/**
 * Consistency lock between the action catalogue's availability declarations
 * (`refKinds`, `headGuard`, `batch`, `cmvKey` — ADR-0010) and the hand-written
 * `branches.*` menu rows in the real package.json. The when-clauses stay hand
 * written (no codegen); this suite is what turns a missed edit from a silent
 * menu defect into a red test.
 */

type MenuRow = { command: string; when: string };

const packageJson = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8")
) as { contributes: { menus: { "view/item/context": MenuRow[] } } };

const COMMAND_PREFIX = "ging-git-view.branches.";

/** Every Branches-view row of the real manifest — the whole surface under test. */
const branchRows = packageJson.contributes.menus["view/item/context"].filter((row) =>
  row.command.startsWith(COMMAND_PREFIX)
);

/** The availability facts one menu row expresses. */
type AvailabilityRow = { viewItem: string; cmv: string | null };

const isMulti = (t: string) => t === "listMultiSelection" || t === "!listMultiSelection";
const isViewItem = (t: string) => /^viewItem =~ \/.+\/$/.test(t);
const isCmv = (t: string) =>
  t.startsWith("ging-git-view.cmv.") || t.startsWith("(ging-git-view.cmv.");

/**
 * Split a when-clause into the availability facts it carries. `||` only occurs
 * inside a parenthesised cmv group, which never contains ` && `, so a plain
 * split is exact. Any term this parser does not recognise fails the suite: a
 * new kind of availability condition must be declared in the catalogue and
 * taught here, not smuggled past the lock.
 */
function parseWhen(row: MenuRow): AvailabilityRow & { multi: boolean } {
  const terms = row.when.split(" && ");
  expect(terms, `${row.command}: every branches.* row is scoped to the Branches view`).toContain(
    "view == ging-git-view.branches"
  );
  const rest = terms.filter((t) => t !== "view == ging-git-view.branches");
  const multiTerms = rest.filter(isMulti);
  const viewItemTerms = rest.filter(isViewItem);
  const cmvTerms = rest.filter(isCmv);
  const leftovers = rest.filter((t) => !isMulti(t) && !isViewItem(t) && !isCmv(t));
  expect(leftovers, `${row.command}: unrecognised when-clause terms`).toEqual([]);
  expect(multiTerms, `${row.command}: exactly one listMultiSelection term`).toHaveLength(1);
  expect(viewItemTerms, `${row.command}: exactly one viewItem term`).toHaveLength(1);
  expect(cmvTerms.length, `${row.command}: at most one cmv term`).toBeLessThanOrEqual(1);
  return {
    multi: multiTerms[0] === "listMultiSelection",
    viewItem: /^viewItem =~ \/(.+)\/$/.exec(viewItemTerms[0])![1],
    cmv: cmvTerms.length === 1 ? cmvTerms[0] : null
  };
}

/** The viewItem regexes the manifest uses, one per availability shape. */
const VIEW_ITEM = {
  /** Local refs minus the checked-out branch — the head guard's spelling. */
  guardedLocal: "^branch-local(-candidate)?$",
  /** Local refs, checked-out branch included. */
  local: "^branch-(local|current)(-candidate)?$",
  /** Remote-tracking refs. The head guard is invisible on this side: a remote
   *  ref is never the checked-out branch, so no `-current` split exists. */
  remote: "^branch-remote(-candidate)?$",
  /** Every branch kind — batch rows and the keyless dual-kind row. */
  any: "^branch-(local|current|remote)(-candidate)?$",
  /** Cleanup-candidate rows only (ADR-0014). */
  candidate: "-candidate$"
};

const cmvContextKey = (category: "branch" | "remoteBranch", action: string) =>
  `ging-git-view.cmv.${category}.${action}`;

/** Widen the const catalogue's literal cmvKey objects to the declared union,
 *  so both optional sides are readable on every entry. */
const cmvKeyOf = (action: CatalogueRefAction): CmvKey | null => REF_ACTION_CATALOGUE[action].cmvKey;

/**
 * The single-selection rows package.json must contain for one catalogue
 * action: which viewItem regex each row carries (refKinds + headGuard) and
 * which cmv context key gates it (cmvKey; null = ungated).
 */
function expectedSingleRows(action: CatalogueRefAction): AvailabilityRow[] {
  const spec = REF_ACTION_CATALOGUE[action];
  const cmvKey = cmvKeyOf(action);
  // A keyless both-kinds action needs no per-category gating, so it collapses
  // into a single row covering every branch kind (createPullRequest).
  if (cmvKey === null && spec.refKinds === "both") {
    return [{ viewItem: VIEW_ITEM.any, cmv: null }];
  }
  const rows: AvailabilityRow[] = [];
  // `delete` is the one action whose remote half is spelled as its own command
  // — `deleteRemote`, same settings key — so its own rows are local-only while
  // its `refKinds: "both"` still drives the batch row (ADR-0010).
  const localSide = spec.refKinds !== "remote";
  const remoteSide = spec.refKinds !== "local" && action !== "delete";
  if (localSide) {
    rows.push({
      viewItem: spec.headGuard ? VIEW_ITEM.guardedLocal : VIEW_ITEM.local,
      cmv: cmvKey?.branch ? cmvContextKey("branch", cmvKey.branch) : null
    });
  }
  if (remoteSide) {
    rows.push({
      viewItem: VIEW_ITEM.remote,
      cmv: cmvKey?.remoteBranch ? cmvContextKey("remoteBranch", cmvKey.remoteBranch) : null
    });
  }
  return rows;
}

/**
 * The cmv condition a `<action>Selected` batch row must carry: every settings
 * key the action declares, OR-ed together — the row shows while either half is
 * still visible, because per-target hiding is not expressible in a when-clause.
 * A keyless action's batch row carries no cmv condition at all.
 */
function expectedBatchCmv(action: CatalogueRefAction): string | null {
  const key = cmvKeyOf(action);
  if (key === null) return null;
  const parts = [
    ...(key.branch ? [cmvContextKey("branch", key.branch)] : []),
    ...(key.remoteBranch ? [cmvContextKey("remoteBranch", key.remoteBranch)] : [])
  ];
  return parts.length === 1 ? parts[0] : `(${parts.join(" || ")})`;
}

const rowSortKey = (row: AvailabilityRow) => `${row.viewItem}|${row.cmv}`;
const sortRows = (rows: AvailabilityRow[]) =>
  rows.toSorted((a, b) => rowSortKey(a).localeCompare(rowSortKey(b)));

/** Classify the manifest's rows: per-action single rows, per-action batch rows,
 *  and the cleanup exception. Parsed lazily so failures surface inside tests. */
function classifyRows() {
  const singles = new Map<string, AvailabilityRow[]>();
  const batches = new Map<string, AvailabilityRow>();
  const cleanup: MenuRow[] = [];
  for (const row of branchRows) {
    const name = row.command.slice(COMMAND_PREFIX.length);
    if (name === "cleanup") {
      cleanup.push(row);
      continue;
    }
    const parsed = parseWhen(row);
    if (name.endsWith("Selected")) {
      const action = name.slice(0, -"Selected".length);
      expect(parsed.multi, `${row.command}: batch rows require listMultiSelection`).toBe(true);
      expect(batches.has(action), `${row.command}: duplicate batch row`).toBe(false);
      batches.set(action, { viewItem: parsed.viewItem, cmv: parsed.cmv });
    } else {
      expect(parsed.multi, `${row.command}: single rows require !listMultiSelection`).toBe(false);
      const rows = singles.get(name) ?? [];
      rows.push({ viewItem: parsed.viewItem, cmv: parsed.cmv });
      singles.set(name, rows);
    }
  }
  return { singles, batches, cleanup };
}

describe("branches.* menu rows stay consistent with the action catalogue", () => {
  it("every single-selection row matches its catalogue declaration (viewItem ↔ refKinds+headGuard, cmv ↔ cmvKey), with no row missing or extra", () => {
    const { singles } = classifyRows();
    const actual: Record<string, AvailabilityRow[]> = {};
    for (const [action, rows] of singles) actual[action] = sortRows(rows);
    const expected: Record<string, AvailabilityRow[]> = {};
    for (const action of CATALOGUE_REF_ACTIONS) {
      expected[action] = sortRows(expectedSingleRows(action));
    }
    expect(actual).toEqual(expected);
  });

  it("batch rows exist exactly for batch actions, cover every branch kind, and are gated by the union of the action's cmv keys", () => {
    const { batches } = classifyRows();
    const batchActions = CATALOGUE_REF_ACTIONS.filter((a) => REF_ACTION_CATALOGUE[a].batch);
    expect([...batches.keys()].toSorted()).toEqual(batchActions.toSorted());
    for (const action of batchActions) {
      expect(batches.get(action), `${action}Selected`).toEqual({
        viewItem: VIEW_ITEM.any,
        cmv: expectedBatchCmv(action)
      });
    }
  });

  it("cleanup is the sole non-catalogue row: candidate refs only, single-selection, no visibility key", () => {
    const { cleanup } = classifyRows();
    expect(cleanup).toHaveLength(1);
    // Not a ref action: the row is the affordance, not the target (ADR-0014),
    // so it lives outside the catalogue and no cmv setting can hide it.
    expect(CATALOGUE_REF_ACTIONS).not.toContain("cleanup");
    expect(parseWhen(cleanup[0])).toEqual({
      multi: false,
      viewItem: VIEW_ITEM.candidate,
      cmv: null
    });
  });

  it("fastForward and createPullRequest are the only keyless actions, and no row of theirs carries a cmv condition", () => {
    const keyless = CATALOGUE_REF_ACTIONS.filter((a) => cmvKeyOf(a) === null);
    expect(keyless.toSorted()).toEqual(["createPullRequest", "fastForward"]);
    const keylessRows = branchRows.filter((row) =>
      ["fastForward", "fastForwardSelected", "createPullRequest"].includes(
        row.command.slice(COMMAND_PREFIX.length)
      )
    );
    expect(keylessRows).toHaveLength(3);
    for (const row of keylessRows) {
      expect(row.when.includes("ging-git-view.cmv."), `${row.command}: must stay ungated`).toBe(
        false
      );
    }
  });

  it("every declared cmv side is one the action's refKinds can reach", () => {
    // A key on a side refKinds excludes would never be consulted — the menus
    // ask nothing about that side — so the declaration would be dead weight
    // the other locks cannot see. Fail loudly instead (ADR-0010's error
    // strategy: earliest and loudest during development).
    for (const action of CATALOGUE_REF_ACTIONS) {
      const { refKinds } = REF_ACTION_CATALOGUE[action];
      const key = cmvKeyOf(action);
      if (key === null) continue;
      if (key.branch) {
        expect(refKinds, `${action}: branch-side key needs local reach`).not.toBe("remote");
      }
      if (key.remoteBranch) {
        expect(refKinds, `${action}: remoteBranch-side key needs remote reach`).not.toBe("local");
      }
    }
  });

  it("the context-key projection emits exactly the declared cmv keys — shared keys once, all visible under the defaults", () => {
    // The runtime side of the same lock: extension.ts pipes this projection
    // verbatim to setContext, so the key set here IS the side-view's
    // `ging-git-view.cmv.*` surface. One key per declared settings key —
    // delete and deleteRemote both declare `remoteBranch.delete`, which is
    // one key, set once.
    const declared = new Set<string>();
    for (const action of CATALOGUE_REF_ACTIONS) {
      const key = cmvKeyOf(action);
      if (key === null) continue;
      if (key.branch) declared.add(cmvContextKey("branch", key.branch));
      if (key.remoteBranch) declared.add(cmvContextKey("remoteBranch", key.remoteBranch));
    }
    const projected = branchMenuContextKeys(DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY);
    expect(Object.keys(projected).toSorted()).toEqual([...declared].toSorted());
    for (const [key, visible] of Object.entries(projected)) {
      expect(visible, `${key}: defaults are all-visible`).toBe(true);
    }
  });

  it("the context-key projection passes each setting through to its own key: one flip hides exactly one key", () => {
    // Wiring lock: were any key valued by the wrong setting, flipping that
    // setting would hide a different key (or none) and the exact-match below
    // would name the culprit. Covers every settings key, both categories.
    for (const category of ["branch", "remoteBranch"] as const) {
      for (const action of Object.keys(DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY[category])) {
        const cmv = structuredClone(DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY);
        (cmv[category] as Record<string, boolean>)[action] = false;
        const hidden = Object.entries(branchMenuContextKeys(cmv))
          .filter(([, visible]) => !visible)
          .map(([key]) => key);
        expect(hidden, `${category}.${action}`).toEqual([cmvContextKey(category, action)]);
      }
    }
  });

  it("the per-item visibility lookup reads exactly the declared key per side: one flip hides only the actions declaring it, keyless sides never gate", () => {
    // The graph webview's side of the same lock: menuFor asks this lookup for
    // each branch/remoteBranch item's `visible:` gate, so the mapping from a
    // settings key to the items it hides IS this function. Under the
    // defaults every declared side reads true and every undeclared side has
    // no gate at all (undefined — never a hard-wired true).
    for (const action of CATALOGUE_REF_ACTIONS) {
      const key = cmvKeyOf(action);
      for (const category of ["branch", "remoteBranch"] as const) {
        const expected = key?.[category] === undefined ? undefined : true;
        expect(
          refActionVisibility(action, category, DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY),
          `${action} on ${category} under the defaults`
        ).toBe(expected);
      }
    }
    // Wiring lock, mirroring the context-key one: flipping one settings key
    // hides exactly the actions that declare that key on that side.
    for (const category of ["branch", "remoteBranch"] as const) {
      for (const setting of Object.keys(DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY[category])) {
        const cmv = structuredClone(DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY);
        (cmv[category] as Record<string, boolean>)[setting] = false;
        const hidden = CATALOGUE_REF_ACTIONS.filter(
          (action) => refActionVisibility(action, category, cmv) === false
        );
        const declaring = CATALOGUE_REF_ACTIONS.filter(
          (action) => cmvKeyOf(action)?.[category] === setting
        );
        expect(hidden.toSorted(), `${category}.${setting}`).toEqual(declaring.toSorted());
        expect(
          declaring.length,
          `${category}.${setting} hides at least one action`
        ).toBeGreaterThan(0);
      }
    }
  });

  it("cmv keys and the settings defaults describe each other exactly", () => {
    const claimed = { branch: new Set<string>(), remoteBranch: new Set<string>() };
    for (const action of CATALOGUE_REF_ACTIONS) {
      const key = cmvKeyOf(action);
      if (key === null) continue;
      if (key.branch) claimed.branch.add(key.branch);
      if (key.remoteBranch) claimed.remoteBranch.add(key.remoteBranch);
    }
    // Forward: every declared key names a real settings action; reverse: every
    // branch/remoteBranch settings action is claimed by some catalogue entry —
    // the catalogue-driven context-key projection (#50) must cover all of them.
    for (const category of ["branch", "remoteBranch"] as const) {
      expect([...claimed[category]].toSorted()).toEqual(
        Object.keys(DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY[category]).toSorted()
      );
    }
  });
});
