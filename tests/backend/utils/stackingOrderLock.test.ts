import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * Consistency lock on the webview's stacking order, in the shape of its
 * neighbour `roundedBtnStyleLock.test.ts` and here for the same reason: it
 * reads a file off disk and has no use for a DOM. jsdom loads no stylesheet and
 * computes no stacking, so nothing behavioural can see a modal dialog sitting
 * *under* the docked Commit Details View or the find widget — which is exactly
 * what it did until #218, with both clickable behind every dialog.
 *
 * Every `z-index` rule in main.css is listed here, so a new one cannot land
 * without being placed in the order on purpose. The order itself is documented
 * beside the dialog rules in main.css; this is what keeps that comment honest.
 * It cannot tell whether the layers still *paint* in this order — a new
 * stacking context can trap a high number under a low one — only that the
 * numbers do.
 */

const css = readFileSync(new URL("../../../media/main.css", import.meta.url), "utf8");

/** Every rule carrying a `z-index`, as [selector with whitespace collapsed,
 *  value as written], in source order. Innermost blocks only, so a rule inside
 *  `@media` counts as its own selector rather than the at-rule's. A list, not a
 *  map: a second rule on the same selector must show up, not overwrite. */
const rules: [selector: string, value: string][] = [];
for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const decl = /(?:^|;)\s*z-index\s*:\s*([^;]+)/.exec(rule[2]);
  if (decl !== null) rules.push([rule[1].trim().replace(/\s+/g, " "), decl[1].trim()]);
}

const zIndexOf = (selector: string) => Number(rules.find(([s]) => s === selector)?.[1]);

const BACKING = "#dialogBacking.active";
const DIALOG = "#dialog.active";
const POPUP_BAR = "#controls:has(#repoDropdownList.active, #repoSettingsDrawer.active)";

/** The layers that compete in the document's root stacking context, bottom to
 *  top. Neighbours in one tier share a number: they never show at once. */
const ROOT_ORDER: string[][] = [
  // The inline CDV's grips: no stacking context of their own (the cell is only
  // `position: relative`), and hidden while the CDV is docked.
  ["#detailsDivider", "#detailsResizeGrip"],
  ["#commitGraph"],
  ["#commitTable th"],
  ["#controls"],
  ["#commitDetails.docked"],
  [".gitRef.branchDragGhost"],
  ["#scrollShadow.active"],
  ["#findWidget"],
  ["#contextMenu", POPUP_BAR],
  [BACKING],
  [DIALOG]
];

/** The bar's popups, which only compete inside the sticky bar's own stacking
 *  context — their numbers mean nothing against the root order. The bar lifts
 *  itself to {@link POPUP_BAR}'s tier while one is open. */
const IN_BAR = ["#repoDropdownList", "#repoSettingsDrawer"];

describe("the webview's stacking order", () => {
  it("has every z-index rule in main.css placed in it, once", () => {
    expect(rules.map(([s]) => s).toSorted()).toEqual([...ROOT_ORDER.flat(), ...IN_BAR].toSorted());
  });

  it.each(rules)("gives %s a plain integer (%s)", (_, value) => {
    expect(value).toMatch(/^-?\d+$/);
  });

  it.each(ROOT_ORDER.slice(1).map((tier, i) => [tier[0], ROOT_ORDER[i][0]]))(
    "puts %s above %s",
    (upper, lower) => {
      expect(zIndexOf(upper)).toBeGreaterThan(zIndexOf(lower));
    }
  );

  it.each(ROOT_ORDER.filter((tier) => tier.length > 1))("gives %s and %s one tier", (a, b) => {
    expect(zIndexOf(a)).toBe(zIndexOf(b));
  });

  // #218: the backing is what makes a dialog modal to the mouse, so nothing
  // else in the root context may be above it, wherever the list puts it.
  it("covers every other root layer with the dialog's backing", () => {
    for (const selector of ROOT_ORDER.flat()) {
      if (selector === BACKING || selector === DIALOG) continue;
      expect(zIndexOf(selector), selector).toBeLessThan(zIndexOf(BACKING));
    }
  });
});
