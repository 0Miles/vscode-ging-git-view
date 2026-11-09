/** How long the cursor has to rest before the annotation follows it. */
export const CURSOR_SETTLE_MS = 150;
/** How long typing has to stop before the edited document is blamed again. */
export const EDIT_SETTLE_MS = 500;

/**
 * How long to wait before updating the annotation: until the cursor has
 * settled, and — when the document was edited — until typing has stopped for
 * `EDIT_SETTLE_MS`. Typing moves the cursor after every keystroke, so a cursor
 * move alone must not cut the wait after an edit short.
 */
export function updateDelay(state: {
  now: number;
  /** When the document was last edited (epoch ms), if ever. */
  lastEditAt: number | undefined;
}): number {
  const editWait =
    state.lastEditAt === undefined ? 0 : state.lastEditAt + EDIT_SETTLE_MS - state.now;
  return Math.max(CURSOR_SETTLE_MS, editWait);
}
