import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * Consistency lock on the webview's stacking order, in the shape of its
 * neighbour `roundedBtnStyleLock.test.ts`: read the shipped stylesheet and
 * assert the z-index values that carry a decision. jsdom loads no stylesheet
 * and computes no stacking, so nothing behavioural can see a modal dialog
 * sitting *under* the docked Commit Details View or the find widget — which is
 * exactly what it did until #218, with the CDV's files and the find buttons
 * clickable behind every dialog.
 *
 * Every `z-index` in main.css is listed here, so a new one cannot land without
 * being placed in the order on purpose. The order itself is documented beside
 * the dialog rules in main.css; this is what keeps that comment honest. It
 * cannot tell whether the layers still *paint* in this order — a new stacking
 * context can trap a high number under a low one — only that the numbers do.
 */

const css = readFileSync(new URL("../../../media/main.css", import.meta.url), "utf8");

/** Every rule carrying a `z-index`, by its selector text with whitespace
 *  collapsed. Innermost blocks only, so a rule inside `@media` counts as its
 *  own selector rather than the at-rule's. */
const zIndexes = new Map<string, number>();
for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const decl = /(?:^|;)\s*z-index\s*:\s*([^;]+)/.exec(rule[2]);
  if (decl !== null) zIndexes.set(rule[1].trim().replace(/\s+/g, " "), Number(decl[1].trim()));
}

const z = (selector: string) => zIndexes.get(selector);

const POPUP_BAR = "#controls:has(#repoDropdownList.active, #repoSettingsDrawer.active)";

/** The layers that compete in the document's root stacking context, bottom to
 *  top. Neighbours in one tier share a number: they never show at once. */
const ROOT_ORDER: string[][] = [
  ["#commitGraph"],
  ["#commitTable th"],
  ["#controls"],
  ["#commitDetails.docked"],
  [".gitRef.branchDragGhost"],
  ["#scrollShadow.active"],
  ["#findWidget"],
  ["#contextMenu", POPUP_BAR],
  ["#dialogBacking.active"],
  ["#dialog.active"]
];

/** Layers that only compete inside a stacking context of their own — the
 *  CDV's grips inside the CDV, the bar's popups inside the sticky bar — so
 *  their numbers mean nothing against the root order. */
const NESTED = [
  "#detailsDivider",
  "#detailsResizeGrip",
  "#repoDropdownList",
  "#repoSettingsDrawer"
];

describe("the webview's stacking order", () => {
  it("has every z-index in main.css placed in it", () => {
    expect([...zIndexes.keys()].toSorted()).toEqual([...ROOT_ORDER.flat(), ...NESTED].toSorted());
  });

  it.each(ROOT_ORDER.slice(1).map((tier, i) => [tier[0], ROOT_ORDER[i][0]]))(
    "puts %s above %s",
    (upper, lower) => {
      expect(z(upper)).toBeGreaterThan(z(lower)!);
    }
  );

  it.each(ROOT_ORDER.filter((tier) => tier.length > 1))("gives %s and %s one tier", (a, b) => {
    expect(z(a)).toBe(z(b));
  });

  // #218: the backing is what makes a dialog modal to the mouse, so nothing
  // outside the dialog may be above it, however a later layer is numbered.
  it("covers everything but the dialog with the dialog's backing", () => {
    const backing = z("#dialogBacking.active")!;
    for (const [selector, value] of zIndexes) {
      if (selector === "#dialogBacking.active" || selector === "#dialog.active") continue;
      expect(value, selector).toBeLessThan(backing);
    }
  });
});
