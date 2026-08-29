import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * Consistency lock on `.roundedBtn`'s user-agent reset, in the shape its
 * neighbour `branchMenuConsistency.test.ts` uses on the manifest: read the
 * shipped file and assert the declarations that carry a decision are still in
 * it. Here rather than beside the behaviour it protects
 * (`tests/webview/footerControls.test.ts`) for the same reason that one is:
 * this reads a file off disk and has no use for a DOM, and the webview project
 * runs under jsdom, where `import.meta.url` is not a file URL to resolve from.
 *
 * It exists because the decision has no other guard. Since #88 the footer's two
 * members of this class are real `<button>`s while the dialog's and the
 * conflict banner's are still `<div>`s, and the reset is the whole of what
 * makes them render alike. Nothing in the suites can see that: jsdom loads no
 * stylesheet, so every behavioural test passes just as well with the reset
 * deleted, and this repo has no visual-regression harness to add it to.
 *
 * The evidence that the reset is *right* is a measurement, not this file:
 * rendering both markups against `media/main.css` in a real Chromium and
 * diffing every computed property of the footer and its controls gives no
 * difference with the block present, and dozens without it — `#loadMoreCommitsBtn`
 * going 182x30 to 180x28 as `box-sizing: border-box` and a `1px 6px` padding
 * arrive, the font falling back to Arial, `appearance` returning to `auto`.
 * That measurement does not run in CI, which is exactly why a text lock is
 * worth having: it is the second-best guard, and second-best beats the nothing
 * that was here before. It cannot tell whether the declarations still *work* —
 * only that nobody removed them without meeting this comment first.
 */

const css = readFileSync(new URL("../../../media/main.css", import.meta.url), "utf8");

/** The `prop: value` pairs of a rule, by exact selector text, in source order —
 *  empty when there is no such rule, so a missing one fails as a named test
 *  rather than as a collection error that takes the whole file down with it.
 *
 *  Brace counting rather than a regex to the next `}`: the reset block's
 *  comment is longer than the block and a lazy match would stop inside it. */
function declarations(selector: string): { prop: string; value: string }[] {
  const at = css.indexOf(`\n${selector} {`);
  if (at === -1) return [];
  const open = css.indexOf("{", at);
  let depth = 0;
  let close = open;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) {
      close = i;
      break;
    }
  }
  return css
    .slice(open + 1, close)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d !== "")
    .map((d) => {
      const colon = d.indexOf(":");
      return { prop: d.slice(0, colon).trim(), value: d.slice(colon + 1).trim() };
    });
}

/**
 * The reset, member by member, each paired with what it is holding off. A
 * `<button>` arrives with all of these replaced by values of its own — the HTML
 * Standard's form-control rendering rule — so each entry is one way the two
 * kinds of member could drift apart.
 */
const RESET: [prop: string, value: string, holdsOff: string][] = [
  ["appearance", "none", "the platform's own button chrome"],
  ["-webkit-appearance", "none", "the same, for engines still reading the prefix"],
  ["box-sizing", "content-box", "border-box, which shrinks #loadMoreCommitsBtn's 180x28"],
  ["font", "inherit", "the UA button font, which is not the page's"],
  ["letter-spacing", "inherit", "normal"],
  ["word-spacing", "inherit", "normal"],
  ["text-transform", "inherit", "none"],
  ["text-indent", "0", "the rule's own 0, restated so it cannot be inherited away"],
  ["text-shadow", "inherit", "none"],
  ["unicode-bidi", "isolate", "normal, where a block div isolates"],
  ["margin", "0", "the UA margin"],
  ["padding", "0", "1px 6px"]
];

describe(".roundedBtn keeps the reset that makes its button and div members alike", () => {
  const decls = declarations(".roundedBtn");
  const index = (prop: string) => decls.findIndex((d) => d.prop === prop);

  it("is a rule in media/main.css at all", () => {
    expect(decls.length, ".roundedBtn must exist and carry declarations").toBeGreaterThan(0);
  });

  it.each(RESET)("resets %s to %s, holding off %s", (prop, value) => {
    expect(decls.find((d) => d.prop === prop)).toEqual({ prop, value });
  });

  it("declares every one of them before the base rule begins", () => {
    // The reset has to lose to the base's own declarations, not the other way
    // round: `display: block` is the class's, and a reset re-applied after it
    // would put the button's `inline-block` back.
    const displayAt = index("display");
    expect(displayAt, "display: block is the first of the base declarations").toBeGreaterThan(-1);
    for (const [prop] of RESET) {
      expect(index(prop), `${prop} belongs to the reset, above display`).toBeLessThan(displayAt);
    }
  });

  it("puts the font shorthand before the font-size it would otherwise reset", () => {
    // `font: inherit` carries a size with it. Swap these two and every member
    // of the class silently takes the page's font size instead of 13px.
    expect(index("font")).toBeLessThan(index("font-size"));
    expect(decls[index("font-size")].value).toBe("13px");
  });
});

describe(".roundedBtn keeps a focus ring of its own", () => {
  // Reachable only since #88: a `div` could not be focused, so there was
  // nothing to draw. Without this rule the browser draws its own ring, which
  // is not the one every other focusable thing here wears.
  const decls = declarations(".roundedBtn:focus-visible");

  it("is a rule in media/main.css at all", () => {
    expect(decls.length, ".roundedBtn:focus-visible must exist").toBeGreaterThan(0);
  });

  it("draws it from the theme's focus border rather than leaving it to the browser", () => {
    expect(decls.find((d) => d.prop === "outline")?.value).toContain("--vscode-focusBorder");
  });

  it("offsets the ring the way VS Code's own button does", () => {
    expect(decls.find((d) => d.prop === "outline-offset")).toEqual({
      prop: "outline-offset",
      value: "2px"
    });
  });

  it("is :focus-visible only, so a click does not leave a ring behind", () => {
    // The commit rows' rule gives the reason: a click already says where it
    // landed. A plain `:focus` here would ring the button after every press.
    expect(css).not.toMatch(/\n\.roundedBtn:focus\s*\{/);
  });
});
