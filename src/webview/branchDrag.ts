/**
 * Dragging a local branch's label onto a commit row, the gesture that moves the
 * branch there (#208). This module owns the gesture only — what a drop means,
 * and the confirmation in front of it, are the caller's.
 *
 * The label already answers three other pointer gestures: click, double-click
 * (checkout) and right-click (its menu). So a press does nothing until it has
 * travelled {@link BRANCH_DRAG_THRESHOLD} pixels with the primary button; below
 * that, it is still whichever of those it was going to be. And once a drag has
 * happened, the click its release produces is swallowed, so it cannot also
 * expand the row it landed on.
 *
 * Only `.gitRef.head` chips drag. Remote branches and tags are left out, as the
 * issue asks; a combined remote badge is a `.remote` chip nested inside the
 * `.head` one, and `closest()` resolves a press on it to the badge.
 */

import { unescapeHtml } from "./utils/html";

/** How far, in CSS pixels, a press has to travel before it is a drag. */
export const BRANCH_DRAG_THRESHOLD = 5;

export interface BranchDrop {
  branchName: string;
  /** The commit the branch pointed at when the drag started. */
  fromHash: string;
  toHash: string;
  /** The dragged label, for the dialog to anchor on. */
  label: HTMLElement;
}

/** Start listening for branch drags on the commit rows inside `root`. Bound
 *  once, on the root: `renderTable` replaces the rows, never the root. */
export function attachBranchDrag(root: HTMLElement, onDrop: (drop: BranchDrop) => void): void {
  root.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const label = (e.target as Element).closest<HTMLElement>(".gitRef");
    if (label === null || !label.classList.contains("head")) return;
    const fromHash = commitRowIn(root, label)?.dataset.hash;
    if (fromHash === undefined) return;
    track(root, e, { branchName: unescapeHtml(label.dataset.name!), fromHash, label }, onDrop);
  });
}

/** The graph's commit row holding `elem`, or null — `#commitTable` only, since
 *  the branch-redundancy dialog renders `tr.commit` rows of its own. */
function commitRowIn(root: HTMLElement, elem: Element): HTMLElement | null {
  const row = elem.closest<HTMLElement>("tr.commit");
  return row !== null && root.contains(row) ? row : null;
}

function track(
  root: HTMLElement,
  start: MouseEvent,
  source: Omit<BranchDrop, "toHash">,
  onDrop: (drop: BranchDrop) => void
) {
  let dragging = false;
  /** Escape was pressed mid-drag: nothing drops, but the press is still a drag
   *  until its release, whose click must not land as an ordinary one. */
  let cancelled = false;
  let target: HTMLElement | null = null;

  const setTarget = (row: HTMLElement | null) => {
    if (row === target) return;
    target?.classList.remove("branchDropTarget");
    target = row;
    target?.classList.add("branchDropTarget");
  };
  const clearMarks = () => {
    setTarget(null);
    source.label.classList.remove("branchDragSource");
    document.body.classList.remove("branchDragging");
  };
  const end = () => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    document.removeEventListener("keydown", key, true);
    window.removeEventListener("blur", end);
    clearMarks();
  };
  const move = (e: MouseEvent) => {
    // The release happened where the webview could not see it — outside the
    // panel, say. Without this the drag would outlive the button, and the next
    // unrelated click on a row would drop the branch there.
    if ((e.buttons & 1) === 0) {
      end();
      return;
    }
    if (cancelled) return;
    if (!dragging) {
      const distance = Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY);
      if (distance < BRANCH_DRAG_THRESHOLD) return;
      dragging = true;
      source.label.classList.add("branchDragSource");
      document.body.classList.add("branchDragging");
      // The press may already have begun selecting the row's text.
      window.getSelection()?.removeAllRanges();
    }
    e.preventDefault();
    const row = commitRowIn(root, e.target as Element);
    // The row it already points at is no target: dropping there moves nothing.
    setTarget(row !== null && row.dataset.hash !== source.fromHash ? row : null);
  };
  const up = () => {
    const toHash = cancelled ? undefined : target?.dataset.hash;
    const dragged = dragging;
    end();
    if (!dragged) return;
    swallowNextClick();
    if (toHash !== undefined) onDrop({ ...source, toHash });
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (!dragging) {
      end();
      return;
    }
    // Keep listening for the release, so `up` can swallow its click.
    cancelled = true;
    clearMarks();
  };

  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
  document.addEventListener("keydown", key, true);
  window.addEventListener("blur", end);
}

/** Drop the click the browser fires right after a drag's mouseup. It goes to
 *  the nearest element both the press and the release were in, which can be
 *  the row the label sits on — and a click there expands that commit. Only the
 *  click dispatched in the same task as the release: a later one is the user's. */
function swallowNextClick() {
  window.addEventListener("click", swallowClick, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", swallowClick, { capture: true }), 0);
}
function swallowClick(e: Event) {
  e.stopPropagation();
  e.preventDefault();
}
