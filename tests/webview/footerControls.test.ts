import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

import { createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// The graph footer's two controls: Load More, and the way back from a widened
// loaded commit window. ADR-0019 keeps automatic loading on the condition that
// the window is visible *and has a way back* — and a control only a mouse can
// reach is not a way back for everyone. So both are real `<button>`s: the tab
// order, the accessible role and the Enter/Space activation all come with the
// element rather than being three separate things to remember.
//
// One webview is booted for the whole suite and the scenarios run in order
// against it, the way a session actually unfolds; re-importing the module per
// scenario would leave the previous instance still listening on `window`. The
// loaded commit window therefore carries across scenarios: it opens at the
// fixture's initialLoadCommits (300) and each accepted press adds
// loadMoreCount (100).

const L = getWebviewLocalizedStrings();

const viewState = makeViewState();

const commits: GitCommitNode[] = [
  {
    hash: "aaa111",
    parentHashes: ["bbb222"],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Tip commit",
    refs: [{ hash: "aaa111", name: "main", type: "head" }]
  },
  {
    hash: "bbb222",
    parentHashes: [],
    author: "Bob",
    email: "bob@example.com",
    date: 1699000000,
    message: "Base commit",
    refs: []
  }
];

const branchesResponse: GG.ResponseMessage = {
  command: "loadBranches",
  branches: ["main"],
  head: "main",
  hard: true,
  isRepo: true,
  filter: []
};

function commitsResponse(moreCommitsAvailable = true): GG.ResponseMessage {
  return {
    command: "loadCommits",
    commits,
    head: "aaa111",
    moreCommitsAvailable,
    hard: true
  };
}

let mock: ReturnType<typeof createVscodeMock>;

function footer() {
  return document.getElementById("footer")!;
}

function loadMoreBtn() {
  return document.getElementById("loadMoreCommitsBtn");
}

function resetBtn() {
  return document.getElementById("resetLoadedCommitWindowBtn");
}

function row(hash: string) {
  return document.querySelector<HTMLElement>(`#commitTable tr.commit[data-hash="${hash}"]`)!;
}

function click(id: string) {
  const elem = document.getElementById(id);
  expect(elem, id).not.toBeNull();
  elem!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function loadCommitsRequests() {
  return mock.sentMessages.filter((m) => m.command === "loadCommits");
}

// jsdom implements neither scrolling nor scrollTo, so record what the webview
// asks the browser for instead: which elements it brought into view, in order,
// and whether it ever reached for a raw scroll offset.
const scrolledIntoView: Element[] = [];
const scrollTo = vi.fn();

/** Every `focus()` the code under test performs, with what it asked for.
 *
 *  `preventScroll` has to be watched at the call, because jsdom's own `focus()`
 *  never scrolls and ignores the option: the two spellings are indistinguish-
 *  able by their effect here, and distinguishable in a browser, where focusing
 *  an off-screen element brings it into view. It is not a detail of how the
 *  restoration is written — it *is* ADR-0019's "a redraw may not move the user"
 *  at the one seam that can see it. */
const focusCalls: { target: Element; preventScroll: boolean }[] = [];
const nativeFocus = HTMLElement.prototype.focus;
HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
  focusCalls.push({ target: this, preventScroll: options?.preventScroll === true });
  nativeFocus.call(this, options);
};

/** What a browser does with Enter and Space while a native button holds focus,
 *  which jsdom implements no part of: the key event goes to the page first,
 *  and the button is activated only if it is a real `<button>` and nothing
 *  cancelled the key on its way through.
 *
 *  Both of those conditions are ours, which is what keeps this a test rather
 *  than a formality. Turn either control back into a `div` and the activation
 *  stops — a `div` has no activation behaviour to model. Add the footer to the
 *  document keydown handler's `ACTIVATABLE` list and the `preventDefault` that
 *  comes with it stops it too, which is the right answer: the browser already
 *  knows how to press a button, and a second opinion is how you get two.
 *
 *  Enter activates on keydown and Space on keyup; a cancelled keydown
 *  suppresses both. Modelled in that order so a listener reading `keyup` would
 *  see the same sequence a browser sends. */
function pressOnFocused(key: string): KeyboardEvent {
  const target = document.activeElement;
  if (!(target instanceof HTMLElement)) throw new Error("nothing holds focus");
  const down = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(down);
  const activates = target instanceof HTMLButtonElement && !down.defaultPrevented;
  if (key === "Enter" && activates) target.click();
  target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
  if (key === " " && activates) target.click();
  return down;
}

describe("the graph footer's controls", () => {
  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolledIntoView.push(this);
    };
    await import("@/webview/main");
    receive(branchesResponse);
    receive(commitsResponse());
    // Widen the window once, so both controls are on screen at the same time.
    click("loadMoreCommitsBtn");
    receive(commitsResponse());
  });

  describe("as the keyboard and a screen reader meet them", () => {
    // The three things #88 asked for, and the three a `<button>` supplies
    // together: it is in the tab order without a `tabindex` of its own, it
    // carries the button role without an `aria-role` of its own, and its text
    // is its accessible name.
    it("puts Load More in the tab order as a button, named by its own text", () => {
      expect(loadMoreBtn()).toBeInstanceOf(HTMLButtonElement);
      expect(loadMoreBtn()!.tabIndex).toBe(0);
      expect(loadMoreBtn()!.textContent).toBe(L.loadMore);
    });

    it("puts the way back in the tab order as a button, named by its own text", () => {
      expect(resetBtn()).toBeInstanceOf(HTMLButtonElement);
      expect(resetBtn()!.tabIndex).toBe(0);
      expect(resetBtn()!.textContent).toBe(L.resetLoadedCommitWindow.replace("{0}", "300"));
    });
  });

  describe("Load More reached by Tab and pressed with Enter", () => {
    let down: KeyboardEvent;

    beforeAll(() => {
      loadMoreBtn()!.focus();
      mock.clearMessages();
      down = pressOnFocused("Enter");
    });

    it("asks for the next page, exactly as the mouse would", () => {
      expect(loadCommitsRequests()).toMatchObject([{ maxCommits: 500, hard: true }]);
    });

    it("leaves the key to the browser instead of pressing the button a second time", () => {
      // The same rule the commit-message links follow: a real element's own
      // activation is the browser's job, so the page must not cancel the key
      // out from under it.
      expect(down.defaultPrevented).toBe(false);
    });
  });

  describe("the way back pressed with Space", () => {
    let down: KeyboardEvent;

    beforeAll(() => {
      receive(commitsResponse()); // settle the Enter press: the window is at 500
      resetBtn()!.focus();
      mock.clearMessages();
      down = pressOnFocused(" ");
    });

    it("shrinks the loaded commit window back to the opening count", () => {
      expect(loadCommitsRequests()).toMatchObject([{ maxCommits: 300, hard: true }]);
    });

    it("does not let Space scroll the page instead of pressing the button", () => {
      expect(down.defaultPrevented).toBe(false);
    });
  });

  // ADR-0014 gave the arrow keys one meaning — move between commit rows — and
  // made them unconditional, entering the grid when nothing was focused because
  // "nothing focused" meant `<body>`, which is nowhere. The footer is somewhere,
  // and it is *below* the graph, so the old rule sends Down upwards past every
  // loaded commit to the top of the table. This is reachable only because #88
  // made the footer focusable, which makes it #88's to answer.
  describe("the arrow keys while a footer control holds focus", () => {
    let down: KeyboardEvent;

    beforeAll(() => {
      receive(commitsResponse()); // settle the Space press: the window is at 300
      loadMoreBtn()!.focus();
      scrolledIntoView.length = 0;
      down = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
      document.activeElement!.dispatchEvent(down);
    });

    it("leaves the user on the button rather than throwing them to the top of the graph", () => {
      expect(document.activeElement).toBe(loadMoreBtn());
      expect(scrolledIntoView).toEqual([]);
    });

    it("hands the key back to the browser, whose answer to Down here is to scroll", () => {
      // Scrolling is browsing and browsing is what Page Up/Down and the wheel
      // do (ADR-0014). Below the last row there is nothing to step to, so the
      // browser's own behaviour is the right one and the page must not cancel
      // it to substitute a worse one.
      expect(down.defaultPrevented).toBe(false);
    });
  });

  // #82. `renderFooter` is the footer's one writer and it writes `innerHTML`,
  // so every control in it is a different element after every redraw and
  // `document.activeElement` falls back to `<body>`. Pressing Load More with
  // the keyboard therefore used to cost the user their place: to press it a
  // second time they had to Tab in from the top of the document again.
  //
  // The footer is not a roving group — its two controls are peers Tab visits
  // separately, not one tab stop with arrow keys inside it — so this is
  // #73/#85's shape without their machinery: read the identity before the
  // redraw, look it up after, put focus back without scrolling. What it does
  // need that neither of those did is to survive *two* redraws. A commit row
  // and a Commit Details View file row are gone and back inside one
  // `renderTable`; Load More is replaced by the spinner when the press goes out
  // and only returns when the page lands.
  describe("Load More pressed with the keyboard, and its page on its way", () => {
    let pressedButton: Element | null = null;
    let focusedWhileLoading: Element | null = null;
    let focusedAfterLoad: Element | null = null;

    beforeAll(() => {
      loadMoreBtn()!.focus();
      pressedButton = loadMoreBtn();
      scrolledIntoView.length = 0;
      scrollTo.mockClear();
      focusCalls.length = 0;

      pressOnFocused("Enter");
      focusedWhileLoading = document.activeElement;
      receive(commitsResponse());
      focusedAfterLoad = document.activeElement;
    });

    it("parks focus on the footer while the spinner stands in for the button", () => {
      // Not `<body>`, which is where the press used to leave it and where Tab
      // starts again from the top of the document — a load can be seconds long
      // on a large repository. Not the way back either, which is on screen
      // throughout the load: moving focus onto a control the user did not press
      // and whose action is the opposite of theirs is worse than moving it
      // nowhere. The footer is where they are, and it holds nothing to press.
      expect(focusedWhileLoading).toBe(footer());
    });

    it("puts focus on the button the redraw replaced, not on <body>", () => {
      expect(loadMoreBtn()).not.toBe(pressedButton);
      expect(focusedAfterLoad).toBe(loadMoreBtn());
    });

    it("moves nothing on the way back", () => {
      // ADR-0019: appending a page is browsing, and browsing moves nothing.
      // Restoring focus is not a focus *move* either, so it may not scroll.
      // Three ways for it to: the two the webview could ask for outright, and
      // the one the browser would do by itself on a `focus()` that did not say
      // otherwise. The whole array, so these two are the only focus moves and
      // nothing else shifted on the way.
      expect(scrolledIntoView).toEqual([]);
      expect(scrollTo).not.toHaveBeenCalled();
      expect(focusCalls).toEqual([
        { target: footer(), preventScroll: true },
        { target: loadMoreBtn(), preventScroll: true }
      ]);
    });
  });

  describe("the way back pressed, which is the press that removes it", () => {
    let focusedAfterReset: Element | null = null;

    beforeAll(() => {
      // The window is at 400, so the way back is on screen; pressing it takes
      // it to 300, where the footer stops drawing the line it lives in.
      resetBtn()!.focus();
      scrolledIntoView.length = 0;
      scrollTo.mockClear();
      focusCalls.length = 0;

      pressOnFocused(" ");
      receive(commitsResponse());
      focusedAfterReset = document.activeElement;
    });

    it("has no way back left to come back to", () => {
      expect(resetBtn()).toBeNull();
    });

    it("leaves focus in the footer instead of dropping it to <body>", () => {
      // Deliberately *not* the footer's other control, though it is right
      // there and would be pressable straight away. Two reasons, and either
      // alone decides it. A held Enter auto-repeats, so a press that ends on
      // Load More can run Load More; the reverse — ending on the way back —
      // discards the whole widened window the user just spent presses on.
      // And a screen reader would announce the swap as if the user had
      // navigated, when all they did was press the button they were already
      // on. The footer is the nearest place that cannot do either.
      expect(focusedAfterReset).toBe(footer());
    });

    it("takes the viewport where the reset takes it, and adds nothing of its own", () => {
      // The reset gets exactly one movement (see loadedCommitWindow.test.ts):
      // the graph's own restoration brings the row the graph now begins at into
      // view, because the alternative — standing at the bottom, where the
      // browser's clamp leaves it — is the near-the-bottom threshold, and
      // automatic loading would widen the window straight back out.
      //
      // So focus and viewport do end up apart here, and knowingly: the footer
      // holds a container, not an action, and following it with the viewport
      // would undo the press. Pinned positively, so that "the footer scrolled
      // nothing" cannot be satisfied by a redraw that scrolled nothing at all.
      expect(scrolledIntoView).toEqual([row("aaa111")]);
      expect(scrollTo).not.toHaveBeenCalled();
      expect(focusCalls).toEqual([
        { target: footer(), preventScroll: true },
        { target: footer(), preventScroll: true }
      ]);
    });
  });

  describe("Load More pressed on the last page there is", () => {
    let focusedAfterLoad: Element | null = null;

    beforeAll(() => {
      click("loadMoreCommitsBtn"); // widen it again, to 400, so a way back exists
      receive(commitsResponse());
      loadMoreBtn()!.focus();

      pressOnFocused("Enter");
      receive(commitsResponse(false)); // the whole history is in
      focusedAfterLoad = document.activeElement;
    });

    it("has no Load More button left to come back to", () => {
      expect(loadMoreBtn()).toBeNull();
    });

    it("lands in the footer, not on the way back that outlived it", () => {
      // The same rule read the other way round, and the same reason: the way
      // back is on screen and one auto-repeated Enter away from throwing out
      // every page the user just loaded.
      expect(resetBtn()).not.toBeNull();
      expect(focusedAfterLoad).toBe(footer());
    });
  });

  describe("the control coming back a refresh later, long after the press", () => {
    let focusedAfterReturn: Element | null = null;

    beforeAll(() => {
      // Focus is parked on the footer from the scenario above, and Load More
      // is gone. A background refresh now finds more history — a fetch landed,
      // a branch filter widened — and draws the button again.
      focusCalls.length = 0;
      receive(commitsResponse());
      focusedAfterReturn = document.activeElement;
    });

    it("draws the button again", () => {
      expect(loadMoreBtn()).not.toBeNull();
    });

    it("does not reclaim focus for it, the press being long over", () => {
      // The identity is spent the moment the footer settles without the
      // control, and it has to be: an arbitrary amount of time passes before a
      // refresh brings it back, and "the user pressed this five minutes ago"
      // is not a licence to move their focus now. A redraw nobody asked for
      // moves nothing (ADR-0019) — and this one is a redraw nobody asked for
      // even though the press that preceded it was real.
      expect(focusedAfterReturn).toBe(footer());
      expect(focusCalls).toEqual([]);
    });
  });

  describe("the press that empties the footer outright", () => {
    let focusedAfterReset: Element | null = null;

    beforeAll(() => {
      // The page that answers the press has the whole (now shorter) history
      // in: the window is at its opening count and there is nothing more to
      // load, so the footer draws neither control. Reachable when history
      // shrinks under a widened window — a reset --hard or a rebase, picked up
      // by the next refresh.
      resetBtn()!.focus();
      focusCalls.length = 0;

      pressOnFocused(" ");
      receive(commitsResponse(false));
      focusedAfterReset = document.activeElement;
    });

    it("has nothing left in the footer at all", () => {
      expect(footer().innerHTML).toBe("");
    });

    it("still keeps focus out of <body>, there being no control to offer", () => {
      // The case a fallback that named the *other control* could not answer,
      // because there is no other control. #82's complaint is `<body>`, and it
      // is `<body>` whether or not the footer has anything left to press.
      expect(focusedAfterReset).toBe(footer());
    });
  });

  describe("the user going elsewhere while the page is on its way", () => {
    let focusedAfterLoad: Element | null = null;

    beforeAll(() => {
      receive(commitsResponse()); // there is more history again
      loadMoreBtn()!.focus();
      pressOnFocused("Enter");

      // Somewhere the graph's own restoration has no opinion about, so that
      // what is asserted below can only be the footer standing down. A commit
      // row would prove nothing: #73 puts focus back on one of those anyway,
      // and it runs *after* the footer, so a footer that stole focus would be
      // covered up.
      document.getElementById("findInput")!.focus();
      receive(commitsResponse());
      focusedAfterLoad = document.activeElement;
    });

    it("leaves them there rather than pulling focus back to the footer", () => {
      // The identity is held only while the focus the redraw dropped is still
      // in the footer's keeping — on the footer itself, or on `<body>` before
      // there was a footer to park on. Once something else has claimed it,
      // there is nothing to put back and the press is over.
      expect(focusedAfterLoad).toBe(document.getElementById("findInput"));
    });
  });
});
