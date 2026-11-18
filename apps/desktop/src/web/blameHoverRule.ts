/* Which hovers of a blamed file are the blame's (#409): Monaco asks every
 * hover provider of a model wherever a hover is wanted — the pointer on an
 * annotation, on the code, or the keyboard's Show Hover at the cursor — and
 * names only the position. Apart from Monaco, so vitest can say which. */

/** A place in a model, 1-based, as Monaco names one. */
export type HoverPosition = { lineNumber: number; column: number };

export type HoverAsked = {
  /** Where Monaco asks for a hover. */
  position: HoverPosition;
  /** The annotation the pointer is on: its 0-based line, or null. */
  pointedAt: number | null;
  /** The code the pointer is on, or null when it is on none. */
  pointerOnCode: HoverPosition | null;
  /** The cursor, or null when there is none. */
  cursor: HoverPosition | null;
};

const same = (a: HoverPosition | null, b: HoverPosition) =>
  a !== null && a.lineNumber === b.lineNumber && a.column === b.column;

/**
 * The 0-based line whose blame hover to show for `asked`, or null for none.
 * The pointer on a line's annotation shows that line's. A hover asked at the
 * cursor that the pointer is not resting on is the keyboard's (Ctrl+K Ctrl+I)
 * and shows the cursor line's. The pointer on the code shows none: the code's
 * own hovers are the language's.
 */
export function blameHoverLine(asked: HoverAsked): number | null {
  const line = asked.position.lineNumber - 1;
  if (asked.pointedAt === line) return line;
  if (same(asked.cursor, asked.position) && !same(asked.pointerOnCode, asked.position)) {
    return line;
  }
  return null;
}

/**
 * What a blamed file's hover provider answers `asked` with: the line and the
 * host's Markdown for it, in full — waited for, Monaco saying it is loading
 * meanwhile — or null: not the blame's hover (`blameHoverLine`), no hover the
 * host wrote (`hover` answered null: asked over, or the blame let go), or
 * Monaco no longer wants it (`cancelled`).
 */
export async function provideBlameHover(
  asked: HoverAsked,
  hover: (line: number) => Promise<string | null>,
  cancelled: () => boolean
): Promise<{ line: number; markdown: string } | null> {
  const line = blameHoverLine(asked);
  if (line === null) return null;
  const markdown = await hover(line);
  return markdown === null || cancelled() ? null : { line, markdown };
}
