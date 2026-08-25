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

  /** Move focus to `target` and bring it into view — what the arrow keys call,
   *  and the one to reach for by default. The tab stop moves with focus,
   *  keeping the two in step: wherever the arrow keys last went is where Tab
   *  comes back to.
   *
   *  Stepping onto a member is the user asking to go there, so it is allowed to
   *  scroll. {@link focusInPlace} is the exception, for when it is not. */
  focus(target: HTMLElement) {
    this.focusInPlace(target);
    // preventScroll inside focusInPlace, then a nearest-edge scroll of our own:
    // a row stepped onto from off-screen should surface, but without the jump
    // to centre the browser's default focus scroll makes. (jsdom has no
    // scrollIntoView.)
    if (typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "nearest" });
  }

  /** {@link focus} without the scroll, for putting focus *back* where it
   *  already was after a re-render replaced the element holding it. The tab
   *  stop moves the same way; only the scroll is withheld, because the user
   *  never moved and so nothing may move on their behalf. */
  focusInPlace(target: HTMLElement) {
    this.set(target);
    target.focus({ preventScroll: true });
  }
}

/** Step `delta` from `from` within `length` members, stopping at either end.
 *  The commit table is a list to walk, not a menu to cycle: holding Down at the
 *  last commit must not throw the user back to the top. */
export function stepWithinGroup(length: number, from: number, delta: number): number {
  return Math.max(0, Math.min(from + delta, length - 1));
}
