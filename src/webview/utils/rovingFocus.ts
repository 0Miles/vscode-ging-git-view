/**
 * Roving tabindex: a group of peer widgets — the commit table's rows, the file
 * rows of the Commit Details View — that share a single tab stop. Tab moves
 * past the whole group in one press; the arrow keys move within it.
 *
 * Every member carries a tabindex from the markup, because an element without
 * one cannot be focused at all, and exactly one of them carries `0`. This class
 * is what holds that invariant: `set` is the only way a member becomes the tab
 * stop, and it demotes whoever held it before.
 */
export class RovingTabStop {
  private holder: HTMLElement | null = null;

  /** The member currently holding the tab stop, or null once a re-render has
   *  replaced it — fresh markup ships every member at `-1`, so the group has no
   *  tab stop until the next `set`. */
  get current(): HTMLElement | null {
    return this.holder !== null && this.holder.isConnected ? this.holder : null;
  }

  /** Hand the tab stop to `target`, demoting the previous holder. */
  set(target: HTMLElement) {
    const previous = this.current;
    if (previous !== null && previous !== target) previous.tabIndex = -1;
    target.tabIndex = 0;
    this.holder = target;
  }

  /** Hand the tab stop to `target` and put focus there, keeping the two in
   *  step — wherever the arrow keys last went is where Tab comes back to. */
  focus(target: HTMLElement) {
    this.set(target);
    target.focus({ preventScroll: true });
    // preventScroll above, then a nearest-edge scroll of our own: a row stepped
    // onto from off-screen should surface, but without the jump to centre that
    // the browser's default focus scroll makes. (jsdom has no scrollIntoView.)
    if (typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "nearest" });
  }
}

/** Step `delta` from `from` within `length` members, stopping at either end.
 *  The commit table is a list to walk, not a menu to cycle: holding Down at the
 *  last commit must not throw the user back to the top. */
export function stepWithinGroup(length: number, from: number, delta: number): number {
  return Math.max(0, Math.min(from + delta, length - 1));
}
