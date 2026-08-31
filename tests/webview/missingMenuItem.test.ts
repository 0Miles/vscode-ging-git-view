import { describe, expect, it } from "vitest";

import { clickItem, makeViewState, setupHtml } from "./setup";

// The failure path of the shared `clickItem`, which no other suite reaches:
// every label they pass is one their menu really carries, so the guard inside it
// is never observed to fire. That is the blind spot issue #131 was filed about —
// `expect(item, label).not.toBeNull()` was satisfied by the `undefined` that
// `find` answers on a miss, so it read like a guard while catching nothing, and
// five green suites said the same thing either way. Correcting the assertion
// without exercising it would have left the blind spot exactly where it was: the
// next person to put `not.toBeNull()` back gets a green run too.
//
// One assertion carries all three of the ticket's conditions, and there is
// deliberately no second one stating that the throw is not the old TypeError.
// Such a line cannot fail — once the message has matched, the thrower is
// vitest's own AssertionError by construction. What rules the TypeError out is
// the match itself: with the guard reverted this reads `expected [Function] to
// throw error including 'no context menu carries this label' but got 'Cannot
// read properties of undefined (…'`, which is the original failure quoted back,
// a line too late and naming nothing. An assertion that cannot fail is the very
// defect under test here, so it does not get to stand in the test for it.

/** A label no context menu carries, so `find` misses whatever is on screen. */
const MISSING = "no context menu carries this label";

describe("activating a context-menu item the menu does not carry", () => {
  it("fails at the guard, naming the label it was looking for", () => {
    // The extension's real markup, so the `#contextMenu` being searched is the
    // one that ships rather than a hand-rolled stand-in. It is empty here, and
    // an empty menu is the same miss as a menu without this entry — `find`
    // answers `undefined` for both.
    setupHtml(makeViewState());

    expect(() => clickItem(MISSING)).toThrowError(MISSING);
  });
});
