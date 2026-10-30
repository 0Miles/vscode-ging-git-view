import { expect } from "vitest";

import type { GitCommitDetails } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import { buildWebviewMarkup } from "@/extension/webviewMarkup";
import type * as GG from "@/types";

// The fixture itself lives in its own module so the webview harness can load
// it without vitest; suites keep importing it from here.
export { DEFAULT_REPO, makeViewState } from "./viewStateFixture";

/** The viewport height every suite starts with — jsdom's own default, restated
 *  so the threshold below is worked out from declared numbers rather than from
 *  one declared number and one inherited one. */
export const VIEWPORT_HEIGHT = 768;
/** The page height every suite starts with. Only its relation to
 *  VIEWPORT_HEIGHT matters: tall enough that a viewport at the top is nowhere
 *  near the bottom, so the near-the-bottom threshold starts out false. */
export const PAGE_HEIGHT = 10000;
/** The offset at which `innerHeight + scrollY >= offsetHeight - 250` first
 *  holds — the threshold, worked out from the geometry above rather than
 *  copied off the implementation. Suites that want automatic loading to fire
 *  park the viewport here. */
export const NEAR_BOTTOM = PAGE_HEIGHT - 250 - VIEWPORT_HEIGHT;

/** Park the viewport at a known offset. jsdom never scrolls on its own and its
 *  scrollTo is unimplemented, so the offset has to be declared.
 *
 *  Both names for it are written together because the webview reads each in a
 *  different place: `scrollY` for the near-the-bottom threshold, `pageYOffset`
 *  for context-menu placement *and* as the place an opening Commit Details View
 *  scrolls the page on from (`main.ts` around the `cdvBroughtIntoView` guard;
 *  whether it scrolls at all is measured on screen). A viewport that is in two
 *  places at once would describe a page no suite means: one reader would see
 *  it in one place and the other in another. */
export function parkViewportAt(offset: number) {
  Object.defineProperty(window, "scrollY", { value: offset, configurable: true });
  Object.defineProperty(window, "pageYOffset", { value: offset, configurable: true });
}

/* Give every webview suite a page with a size, at the top of it.
 *
 * jsdom performs no layout, so `document.body.offsetHeight` is 0 and `scrollY`
 * never moves unless told to. The webview's near-the-bottom test —
 * `innerHeight + scrollY >= offsetHeight - 250` — therefore degenerates to
 * `768 >= -250`: true wherever the viewport is. Multiply that by the viewState
 * fixture, which carries `loadMoreAutomatically: true` because it tracks the
 * shipped configuration on purpose, and any scroll event in any suite smuggles
 * in a `loadCommits` that reads like the code under test asking twice.
 *
 * Nothing was actually being smuggled when this landed: every suite that
 * dispatched a scroll had already stubbed a height of its own. That is what
 * makes it worth pinning rather than leaving alone — the ones exposed to it are
 * the ones not yet written, by someone who has not met the trap, and a suite
 * has to already suspect it to opt out. So the default is far from the bottom
 * and the threshold is false until a suite says otherwise.
 *
 * Of the three pins only `offsetHeight` changes what any suite sees today; the
 * other two restate jsdom's own defaults, so that the numbers the threshold is
 * derived from are all declared in one place instead of half-declared and
 * half-inherited.
 *
 * It reaches every suite through `setupFiles` in vitest.config.ts, not through
 * being imported — seven webview suites never import this file at all. That is
 * also why it is one bare side effect rather than an exported function nobody
 * would think to call. Every property is `configurable`, so a suite that owns
 * its geometry redefines it as before and this is only what it starts from:
 * loadMoreOnScrollDisabled and loadMoreOnScrollLayoutCost swap in counting
 * getters over their own heights, and contextMenuPosition adds the viewport
 * *width*, the one dimension nothing else measures against.
 *
 * On ADR-0019: its rejected alternative "為捲動門檻抽一個純函式" gave three
 * reasons, and this overturns the middle one — "不需要進共用的測試 setup". The
 * ruling on #97 is what overturned it, on the grounds that the first and third
 * still stand: per-suite stubbing is still the precedent for suites that want
 * their own geometry, and no seam has been opened in product code, which is
 * untouched by this file. The ADR has since been corrected in place — the
 * middle reason struck through, the other two left standing. */
Object.defineProperty(window, "innerHeight", { value: VIEWPORT_HEIGHT, configurable: true });
Object.defineProperty(document.body, "offsetHeight", {
  value: PAGE_HEIGHT,
  configurable: true
});
parkViewportAt(0);

// The real vscode.setState persists state as JSON, so anything that doesn't
// survive a JSON round-trip (Map, Set, DOM elements) is silently lost. Model
// that here, otherwise tests restore live objects the real webview never gets.
function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/** The navigation token on the last load request the webview under test sent —
 *  either kind, because the token counts navigations, not requests: a filter
 *  change reloads only the commits, and a branch answer arriving after it still
 *  belongs to the navigation that change started.
 *
 *  Kept apart from `sentMessages` because suites clear that between scenarios,
 *  and the token an answer belongs to outlives the clearing — answering off an
 *  emptied log would post the fixture's own token and read as the panel having
 *  stopped listening. Rebound by every `createVscodeMock`, one per suite. */
let lastLoadToken: number | null = null;

/** The current mock's message log, for the helpers below that read it, so
 *  their callers need not thread the mock through. Rebound by every
 *  `createVscodeMock`, like {@link lastLoadToken}. */
let sentMessages: GG.RequestMessage[] = [];

export function createVscodeMock(initialState: WebViewState | null = null) {
  const sent: GG.RequestMessage[] = [];
  sentMessages = sent;
  lastLoadToken = null;
  // The real getState() yields undefined (not null) when nothing was saved —
  // model that exactly, so a boot path that only handles null fails here too.
  let state: WebViewState | undefined =
    initialState === null ? undefined : jsonRoundTrip(initialState);

  const mock = {
    postMessage: (msg: GG.RequestMessage) => {
      if (msg.command === "loadBranches" || msg.command === "loadCommits") {
        lastLoadToken = msg.token;
      }
      return sent.push(msg);
    },
    getState: () => state,
    setState: (s: WebViewState) => {
      state = jsonRoundTrip(s);
    }
  };

  global.acquireVsCodeApi = () => mock;

  return {
    sentMessages: sent,
    /** The messages of one command the webview has sent since the last clear.
     *  Eight suites hold a byte-identical local copy of this, split across two
     *  incompatible parameter types (`string` and the command union), and one
     *  of them wraps it again just to cast the result back. It belongs here for
     *  the same reason `makeViewState` does — the mock is its only dependency. */
    sentOf: <T extends GG.RequestMessage["command"]>(command: T) =>
      sent.filter((m): m is Extract<GG.RequestMessage, { command: T }> => m.command === command),
    clearMessages: () => sent.splice(0),
    getState: () => state
  };
}

export function setupHtml(viewState: GG.GitGraphViewState) {
  const l10nStrings = getWebviewLocalizedStrings();

  // The DOM under test is the extension's real markup — the same string
  // buildWebviewHtml embeds into the webview — so the tests' DOM and the
  // shipped DOM have one source and cannot silently diverge.
  document.body.innerHTML = buildWebviewMarkup(l10nStrings);

  (global as unknown as { viewState: GG.GitGraphViewState }).viewState = viewState;
  global["l10n"] = l10nStrings;
}

/**
 * Deliver a response to the webview, as the host would post it.
 *
 * A `loadBranches` / `loadCommits` answer gets the navigation token of the
 * request it is answering, overriding whatever the fixture declared — which is
 * precisely what the host does with it (it echoes; it never originates one).
 * Without this every suite would have to track a number that belongs to the
 * plumbing rather than to anything it is about: the token only moves when a
 * navigation abandons a load in flight (#84), so a suite that happens to switch
 * repo mid-load would silently start posting answers the panel is right to
 * drop, and would read as the panel having stopped listening.
 *
 * `keepToken` opts out, for the suites that are about the plumbing: answering
 * with a token the panel has left is the whole scenario there.
 */
export function receive(msg: GG.ResponseMessage, opts: { keepToken?: boolean } = {}) {
  let data = msg;
  if (!opts.keepToken && (msg.command === "loadBranches" || msg.command === "loadCommits")) {
    if (lastLoadToken !== null) data = { ...msg, token: lastLoadToken };
  }
  window.dispatchEvent(new MessageEvent("message", { data }));
}

// The DOM helpers below were each held as local copies by several suites, some
// down to the doc comment, and some under other names. They are here for the
// reason `makeViewState` is: a guard that is wrong in one copy is wrong in all
// of them.
//
// Clicking comes under two names because suites click two different things: an
// element they already hold, and a control they know only by its id. Suites had
// each kept a `click` of their own, under incompatible signatures, so the same
// name meant different things depending on which file was open.

/** Click an element the suite already holds. */
export function clickElem(elem: Element) {
  elem.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

/** Click the control with this id, failing on the id when there is none. */
export function clickId(id: string) {
  const elem = document.getElementById(id);
  expect(elem, id).not.toBeNull();
  clickElem(elem!);
}

/** Right-click an element the suite already holds. */
export function rightClick(elem: Element) {
  elem.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
}

/** Raise the context menu of whatever `selector` names, failing on the selector
 *  when nothing matches. */
export function openMenuOn(selector: string) {
  const elem = document.querySelector<HTMLElement>(selector);
  expect(elem, selector).not.toBeNull();
  rightClick(elem!);
}

/** A commit row of the graph's, addressed through the table so the selector says
 *  which surface it wants: a dialog's commit list renders `tr.commit[data-hash]`
 *  too. */
export function graphRow(hash: string) {
  const elem = document.querySelector<HTMLElement>(`#commitTable tr.commit[data-hash="${hash}"]`);
  expect(elem, hash).not.toBeNull();
  return elem!;
}

/** A commit row of the open dialog's commit list — the other surface `graphRow`
 *  keeps out. */
export function dialogRow(hash: string) {
  const elem = document.querySelector<HTMLElement>(
    `#dialog .commitList tr.commit[data-hash="${hash}"]`
  );
  expect(elem, hash).not.toBeNull();
  return elem!;
}

/** Activate a context-menu item by its label, matched against the whole row.
 *
 *  A miss throws, naming the label and every item the menu does carry. `find`
 *  yields `undefined` when nothing matches; left unguarded, that surfaces a line
 *  later on `dispatchEvent` as a TypeError naming neither the label nor the fact
 *  that the menu simply did not carry it (issue #131), and a fixture that has
 *  drifted reads like a listener that stopped working. What the menu offered
 *  instead is the next thing anyone reading the failure needs, and without it
 *  finding out costs a second run (#154). A throw carries that as written;
 *  `expect(item, …).toBeDefined()` would trail it with "expected undefined to be
 *  defined", which says nothing the message has not. `contextMenuGutter` and
 *  `dialogRememberCheckbox` had already settled on the same message.
 *
 *  No suite reaches the guard: every label they pass is one their menu really
 *  carries. `missingMenuItem` is what exercises the miss, and without it a green
 *  run cannot tell a guard that fires from one that only looks like it. */
export function clickItem(label: string) {
  clickElem(findMenuItem(label, (text) => text === label));
}

/** The context-menu item whose label begins with `prefix`, for the items whose
 *  label carries more than the suite cares about — a shortcut hint, or the
 *  ellipsis of an item that opens a dialog. A miss throws on the same terms as
 *  {@link clickItem}, naming the prefix and every item the menu does carry. */
export function menuItemStartingWith(prefix: string) {
  return findMenuItem(prefix, (text) => text.startsWith(prefix));
}

/** The one guarded lookup behind {@link clickItem} and
 *  {@link menuItemStartingWith}; `label` is what the failure names. */
function findMenuItem(label: string, matches: (text: string) => boolean) {
  const entries = Array.from(
    document.querySelectorAll<HTMLElement>("#contextMenu .contextMenuItem")
  ).map((li) => ({ li, text: (li.textContent ?? "").trim() }));
  const item = entries.find((entry) => matches(entry.text));
  if (item === undefined) {
    throw new Error(
      `menu item "${label}" not found; items: ${entries.map((entry) => entry.text).join(" | ")}`
    );
  }
  return item.li;
}

/** Just the open menu's actionable labels, which is what a menu's *contents*
 *  are asked about — the dividers between them are not items and carry no
 *  text. */
export function menuItemLabels() {
  return Array.from(document.querySelectorAll<HTMLElement>("#contextMenu .contextMenuItem")).map(
    (li) => (li.textContent ?? "").trim()
  );
}

/** Every child of the open menu, dividers included, so that "nothing opened" is
 *  asserted against the whole element rather than against the items alone. */
export function contextMenuEntries() {
  const menu = document.getElementById("contextMenu");
  expect(menu, "#contextMenu").not.toBeNull();
  return Array.from(menu!.children).map((li) => (li.textContent ?? "").trim());
}

/** Close whatever context menu is open, the way a click elsewhere does. */
export function hideMenu() {
  document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
}

/** The keyboard's way of raising a context menu, mirroring `main.ts`'s private
 *  `MENU_KEY_EVENT`. Suites dispatch it directly rather than via Shift+F10,
 *  because the document keydown handler that would normally synthesise it
 *  returns early while a dialog stands, before the branch that reads Shift+F10.
 *  Since #145 the arrows and Enter reach a dialog row, through the dialog's own
 *  branch, but the menu key still does not. What it asserts is the *binding*,
 *  which is what would outlive the menu key ever being routed there. */
export const MENU_KEY_EVENT = "ging.contextMenuKey";

/** Put `#dialog` ahead of the graph in document order, so that a read or a
 *  binding that is not scoped to the graph meets the dialog's elements first.
 *
 *  Not a hypothetical rearrangement: `buildWebviewMarkup` is free to order its
 *  own children, nothing in it records that `#commitTable` must come first, and
 *  a future dialog drawn into `#content` would land ahead of the table without
 *  moving anything at all. `insertBefore` moves the same element, so a
 *  module-level `getElementById("dialog")` still resolves. */
export function moveDialogAheadOfTheGraph() {
  const dialog = document.getElementById("dialog");
  const content = document.getElementById("content");
  expect(dialog, "#dialog").not.toBeNull();
  expect(content, "#content").not.toBeNull();
  document.body.insertBefore(dialog!, content);
}

/** A `.commitBodyLink` under `root`, addressed by the address it points at:
 *  `commitSummaryHtml` emits one per commit for the author and one for the
 *  committer, and both the graph and a dialog can render them. */
export function bodyLink(root: string, email: string) {
  const elem = document.querySelector<HTMLElement>(
    `${root} .commitBodyLink[href="mailto:${encodeURIComponent(email)}"]`
  );
  expect(elem, `${root} ${email}`).not.toBeNull();
  return elem!;
}

/** Whether a dialog is up. */
export function dialogShown() {
  return document.getElementById("dialog")!.classList.contains("active");
}

/** The dialog's text, read whether or not it is up — a suite that cares pairs
 *  it with {@link dialogShown}. */
export function dialogText() {
  return document.getElementById("dialog")!.textContent ?? "";
}

/** Type a search. The widget searches on `keyup`, one keystroke at a time; the
 *  key itself only has to be neither Enter (step) nor Escape (close). */
export function search(query: string) {
  const input = document.getElementById("findInput") as HTMLInputElement;
  input.value = query;
  input.dispatchEvent(new KeyboardEvent("keyup", { key: "x", bubbles: true }));
}

/** The host's answer to a `commitDetails` request on `hash`, for suites that
 *  need the Commit Details View open and nothing in particular in it. */
export function commitDetails(hash: string): GitCommitDetails {
  return {
    hash,
    parents: [],
    author: "Alice",
    email: "alice@example.com",
    committer: "Alice",
    committerEmail: "alice@example.com",
    authorDate: 1700000000,
    commitDate: 1700000000,
    body: "Body",
    fileChanges: []
  };
}

/** Open the Commit Details View on `hash` by clicking its row.
 *
 *  Clicking a row that is *already* the anchored one closes the view rather
 *  than opening it, so whichever commit a previous test left anchored would
 *  otherwise decide what the click does. The `commitDetails` request the open
 *  path sends is what tells the two apart — read off the current
 *  {@link createVscodeMock}'s log, which a suite's `clearMessages` empties in
 *  place rather than replaces. */
export function openDetailsOn(hash: string) {
  const opened = () =>
    sentMessages.some((m) => m.command === "commitDetails" && m.commitHash === hash);
  clickElem(graphRow(hash));
  if (!opened()) clickElem(graphRow(hash));
  expect(opened(), `details never opened on ${hash}`).toBe(true);
}

/** Open the Commit Details View on `hash`, then CTRL-click `compareWith` to
 *  compare the two. */
export function compareRows(hash: string, compareWith: string) {
  openDetailsOn(hash);
  graphRow(compareWith).dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
}
