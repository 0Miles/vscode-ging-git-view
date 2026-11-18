import { describe, expect, it } from "vitest";

import {
  blameHoverLine,
  type HoverAsked,
  provideBlameHover
} from "@ging/desktop/web/blameHoverRule";

// Which hovers of a blamed file are the blame's, and what its hover provider
// answers (#409): Monaco asks the provider wherever a hover is wanted and
// shows "Loading…" while it waits, so the provider answers only the host's
// Markdown in full, or nothing.

const at = (lineNumber: number, column = 1) => ({ lineNumber, column });

/** Asked at line 3, column 1, with nothing pointed at and no cursor. */
const asked = (more: Partial<HoverAsked> = {}): HoverAsked => ({
  position: at(3),
  pointedAt: null,
  pointerOnCode: null,
  cursor: null,
  ...more
});

describe("blameHoverLine", () => {
  it("is the line whose annotation the pointer is on", () => {
    expect(blameHoverLine(asked({ pointedAt: 2 }))).toBe(2);
  });

  it("is the cursor's line for the keyboard's Show Hover, the pointer elsewhere", () => {
    expect(blameHoverLine(asked({ position: at(3, 5), cursor: at(3, 5) }))).toBe(2);
    expect(
      blameHoverLine(asked({ position: at(3, 5), cursor: at(3, 5), pointerOnCode: at(9, 1) }))
    ).toBe(2);
  });

  it("is none for the pointer on the code: the code's own hovers are the language's", () => {
    expect(blameHoverLine(asked({ position: at(3, 5), pointerOnCode: at(3, 5) }))).toBeNull();
    // Even resting on the cursor's own character.
    expect(
      blameHoverLine(asked({ position: at(3, 5), pointerOnCode: at(3, 5), cursor: at(3, 5) }))
    ).toBeNull();
    // Nor another line's annotation.
    expect(blameHoverLine(asked({ pointedAt: 7 }))).toBeNull();
  });
});

/** A host whose answer the test hands over when it chooses. */
function host() {
  const requested: number[] = [];
  let answer!: (markdown: string | null) => void;
  const hover = (line: number) => {
    requested.push(line);
    return new Promise<string | null>((resolve) => (answer = resolve));
  };
  return { requested, hover, answer: (md: string | null) => answer(md) };
}

describe("provideBlameHover", () => {
  it("answers only once the host has written the hover in full, with that Markdown", async () => {
    const { requested, hover, answer } = host();
    let settled = false;
    const providing = provideBlameHover(asked({ pointedAt: 2 }), hover, () => false).then(
      (result) => {
        settled = true;
        return result;
      }
    );

    await Promise.resolve();
    expect(settled).toBe(false);
    answer("**Al**, a day ago\n\nthe whole message");

    expect(await providing).toEqual({
      line: 2,
      markdown: "**Al**, a day ago\n\nthe whole message"
    });
    expect(requested).toEqual([2]);
  });

  it("answers none for a hover the host did not write: asked over, its lookup stopped", async () => {
    const { hover, answer } = host();
    const providing = provideBlameHover(asked({ pointedAt: 2 }), hover, () => false);

    answer(null);

    expect(await providing).toBeNull();
  });

  it("answers none once Monaco no longer wants it", async () => {
    const { hover, answer } = host();
    const monaco = { cancelled: false };
    const providing = provideBlameHover(asked({ pointedAt: 2 }), hover, () => monaco.cancelled);

    monaco.cancelled = true;
    answer("**Al**");

    expect(await providing).toBeNull();
  });

  it("asks the host nothing for a hover that is not the blame's", async () => {
    const { requested, hover } = host();

    expect(
      await provideBlameHover(
        asked({ position: at(3, 5), pointerOnCode: at(3, 5) }),
        hover,
        () => false
      )
    ).toBeNull();
    expect(requested).toEqual([]);
  });
});
