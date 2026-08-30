/** Bind `event` on every element carrying `className`, **document-wide**. Right
 *  while one view renders that class. Wrong the moment two do — and this webview
 *  has views that share a renderer: the Commit Details View's file rows and the
 *  branch-redundancy dialog's come out of one generator, so binding the panel's
 *  handlers across the document put them on the modal's rows too, carrying
 *  another commit's paths (#128). That caller scopes itself instead —
 *  `GitGraphView.addCdvListenerToClass`.
 *
 *  **Not every caller is safe yet — that is #144.** The dialog also renders
 *  `.commitBodyLink` and `tr.commit` rows of its own, and both are still bound
 *  through here. So before adding a call, ask what else renders the class — a
 *  root parameter on this function would not ask it for you, because it would
 *  have to default to `document`. */
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
export function blinkHeadRow(headHash: string | null) {
  if (!headHash) return;
  const row = document.querySelector(`tr.commit[data-hash="${headHash}"]`) as HTMLElement | null;
  if (!row) return;
  row.classList.add("blinking");
  // Matches CSS animation: 320ms * 2 iterations = 640ms, add small buffer
  window.setTimeout(() => row.classList.remove("blinking"), 700);
}
