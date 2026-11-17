/* What the side views' trees share (#399, #400): finding a row, drawing one
 * anew without losing the keyboard, and the keys a browser's tree takes. */

/** The row of `body` keyed `key`. Compared, not put in a selector: a key holds
 *  a branch name or a path, which may hold anything a selector would read as
 *  syntax. */
export const rowKeyed = (body: HTMLElement, key: string | null): HTMLElement | null =>
  key === null
    ? null
    : (Array.from(body.querySelectorAll<HTMLElement>("[data-key]")).find(
        (row) => row.dataset.key === key
      ) ?? null);

export const rowOf = (target: EventTarget | null) =>
  target instanceof Element ? target.closest<HTMLElement>(".sideViewRow") : null;

/** A menu raised from the keyboard: no pointer, so the graph's menu hangs it
 *  off the row, as it does its own (`menuAnchorPoint`). */
export const keyboardMenuEvent = () => new Event("contextmenu");

/** Whether `e` asks for a row's menu from the keyboard. */
export const isMenuKey = (e: KeyboardEvent) =>
  e.key === "ContextMenu" || (e.shiftKey && e.key === "F10");

/** Draw, keeping the keyboard where it was when it was in the tree. */
export function redrawTree(body: HTMLElement, html: string, focused: string | null): void {
  const hadFocus = body.contains(document.activeElement);
  body.innerHTML = html;
  if (!hadFocus || focused === null) return;
  (rowKeyed(body, focused) ?? body.querySelector<HTMLElement>('[role="treeitem"]'))?.focus({
    preventScroll: true
  });
}

/** Keys a browser's tree takes, and what they do here. */
const TREE_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "Enter",
  " ",
  "ContextMenu"
]);

/**
 * A tree's keys, on the tree: they are not the graph's to move its rows by.
 * Up, Down, Home and End move the keyboard between rows, `moved` told where
 * to; every other tree key is `onRow`'s, which says whether it took it.
 */
export function treeKeys(
  body: HTMLElement,
  onRow: (row: HTMLElement, e: KeyboardEvent) => boolean,
  moved: (next: HTMLElement) => void
): void {
  body.addEventListener("keydown", (e) => {
    if (!TREE_KEYS.has(e.key) && !isMenuKey(e)) return;
    const row = rowOf(document.activeElement);
    if (row === null || !body.contains(row)) return;
    const rows = Array.from(body.querySelectorAll<HTMLElement>(".sideViewRow"));
    const at = rows.indexOf(row);
    let next: HTMLElement | null = null;
    if (e.key === "ArrowUp") next = rows[at - 1] ?? null;
    else if (e.key === "ArrowDown") next = rows[at + 1] ?? null;
    else if (e.key === "Home") next = rows[0] ?? null;
    else if (e.key === "End") next = rows[rows.length - 1] ?? null;
    else if (!onRow(row, e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (next === null) return;
    row.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
    if (typeof next.scrollIntoView === "function") next.scrollIntoView({ block: "nearest" });
    moved(next);
  });
}
