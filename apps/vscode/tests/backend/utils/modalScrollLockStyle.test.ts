import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * Consistency lock on the modal scroll lock's declarations (#230), in the shape
 * of its neighbour `roundedBtnStyleLock.test.ts` and here for the same reason:
 * it reads a file off disk and has no use for a DOM. The class that switches
 * the lock on is pinned where the dialog is
 * (`tests/webview/modalScrollLock.test.ts`); what the class *does* is only
 * these declarations, and jsdom loads no stylesheet to notice them gone.
 *
 * The evidence that they work is a measurement in a real Chromium, not this
 * file: with a dialog up, dragging the page's scrollbar, the wheel over the
 * backing, and PageDown/Space/the arrows leave `scrollY` where it was; the
 * layout width is the same open as closed; and a dialog taller than the
 * viewport still scrolls inside itself without handing the rest of the wheel
 * to the page. This can only tell that nobody removed them without meeting
 * this comment first.
 */

const css = readFileSync(new URL("../../../media/main.css", import.meta.url), "utf8");

/** The declarations of a rule, by exact selector text, as `prop: value` with
 *  whitespace collapsed — empty when there is no such rule, so a missing one
 *  fails as a named test. Comments are dropped first so a `}` inside one
 *  cannot end the match early. */
function declarations(selector: string): string[] {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const at = plain.indexOf(`\n${selector} {`);
  if (at === -1) return [];
  const body = plain.slice(plain.indexOf("{", at) + 1, plain.indexOf("}", at));
  return body
    .split(";")
    .map((d) => d.trim().replace(/\s+/g, " "))
    .filter((d) => d !== "");
}

describe("the modal scroll lock in main.css", () => {
  it("takes the page's own scrolling away while a dialog is up", () => {
    expect(declarations("html.dialogOpen")).toContain("overflow: hidden");
  });

  it("keeps the scrollbar's gutter, so the layout width does not shift", () => {
    expect(declarations("html.dialogOpen")).toContain("scrollbar-gutter: stable");
  });

  it("keeps a dialog's own scroll from chaining to the page", () => {
    expect(declarations("#dialog.active")).toContain("overscroll-behavior: contain");
    expect(declarations("#dialog.active")).toContain("overflow-y: auto");
  });
});
