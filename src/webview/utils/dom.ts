/** Bind `event` on every element carrying `className`, **document-wide**. Right
 *  while one view renders that class. Wrong the moment two do — and this webview
 *  has views that share a renderer: the Commit Details View's file rows and the
 *  branch-redundancy dialog's come out of one generator, so binding the panel's
 *  handlers across the document put them on the modal's rows too, carrying
 *  another commit's paths (#128). That caller scopes itself instead —
 *  `GitGraphView.addCdvListenerToClass`.
 *
 *  **#144 took the rest of that family out, through two different doors.** The
 *  dialog also renders `tr.commit` rows and `.commitBodyLink`s of its own. The
 *  graph's commit rows went to `GitGraphView.addGraphListenerToClass`
 *  (`#commitTable`); the Commit Details View's `cdvFileViewBtn`,
 *  `commitBodyHash` and body links went to `addCdvListenerToClass`
 *  (`#commitDetails`). Two scopes, because the two surfaces are not nested: a
 *  docked Commit Details View is appended to `<body>`, outside the table.
 *
 *  **#166 took the graph's last six.** The ref chip's `click`, `dblclick` and
 *  menu, the uncommitted-changes row's menu, the column header's menu and the
 *  resize handle's `mousedown` all bind within `#commitTable` now, and
 *  `addContextMenuListener`, the menu-pair wrapper the three menus went
 *  through, was left with no callers and deleted. Their
 *  safety had rested on "only one view renders this class", and for `gitRef`
 *  that was already untrue: a branch drag clones the chip onto `<body>`
 *  (`branchDrag.ts`), and a redraw during the drag bound the chip's handlers to
 *  the copy — double-click to checkout among them. Only `pointer-events: none`
 *  kept a pointer off it.
 *
 *  **What still binds through here, and what its safety rests on.** This list
 *  lives here rather than beside the scoped helpers, because here is where
 *  someone adding a call site is looking:
 *
 *  - `contextMenuItem` — in `showContextMenu`, on markup it has just written.
 *
 *  That one is safe for a different reason from the ones that left: it binds
 *  what its own caller wrote a line earlier, not what some view happens to
 *  render. Before adding anything else here, move it to a scoped helper instead;
 *  `tr.commit` and `gitRef` both looked exactly like this list until a second
 *  copy of the class turned up.
 *
 *  So before adding a call, ask what else renders the class, and pick the scope
 *  from the answer. A root parameter on this function would not ask it for you,
 *  because it would have to default to `document` — which is how both of those
 *  bugs read exactly like the calls around them until someone measured. The
 *  scoped helpers take a **required** root for that reason; see
 *  `GitGraphView.addScopedListenerToClass`. */
export function addListenerToClass(className: string, event: string, eventListener: EventListener) {
  let elems = document.getElementsByClassName(className),
    i;
  for (i = 0; i < elems.length; i++) {
    elems[i].addEventListener(event, eventListener);
  }
}
export function insertAfter(newNode: HTMLElement, referenceNode: HTMLElement) {
  referenceNode.parentNode!.insertBefore(newNode, referenceNode.nextSibling);
}
/** Flash `row` for the length of the CSS animation, or do nothing when there is
 *  no row to flash.
 *
 *  **It takes the row, not a hash, and that is the whole of what #150 changed
 *  here.** As `blinkHeadRow(hash)` it ran `document.querySelector` on
 *  `tr.commit[data-hash=…]`, which the branch-redundancy dialog also renders —
 *  so it flashed whichever copy came first in the page, and only the order
 *  `buildWebviewMarkup` happens to write its children in made that the graph's.
 *  Both callers had *already* resolved the row they meant, scoped to
 *  `#commitTable`, on the line above; re-deriving it from the hash down here
 *  discarded that scope and asked the question a second time in a wider place.
 *  Passing the answer instead leaves no query to get wrong, which is why this
 *  needs no root parameter of its own — see `GitGraphView.graphRowByHash` for
 *  the scope its callers now use.
 *
 *  Named for what it does rather than for HEAD: `scrollToStash` has always
 *  called it too, and a name that says HEAD is how the stash caller reads like a
 *  mistake. */
export function blinkRow(row: HTMLElement | null) {
  if (row === null) return;
  row.classList.add("blinking");
  // Matches CSS animation: 320ms * 2 iterations = 640ms, add small buffer
  window.setTimeout(() => row.classList.remove("blinking"), 700);
}
