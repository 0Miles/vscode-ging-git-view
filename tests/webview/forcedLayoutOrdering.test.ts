import * as fs from "node:fs";
import * as path from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import type * as GG from "@/types";

import { createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// What a redraw costs in *layouts*, not in milliseconds.
//
// A browser computes layout lazily: a DOM write marks it dirty, and a read of a
// geometric property computes it there and then. So the price of a redraw is
// decided by the order of its reads and writes — a write landing between two
// reads makes the engine lay the whole commit table out again. Re-measured on
// the shipped bundle at 3000 rows in Chromium 148, that second layout was
// 77.3ms on top of a 245.5ms first one (#104). The first one is the table
// entering the document and no ordering removes it; the second one was the
// graph column's width being written between two reads.
//
// jsdom performs no layout at all, so the cost is not measurable here and this
// file does not pretend to measure it. What it pins is the structure underneath
// the cost: within one redraw, every layout read happens before that write. The
// model is one dirty bit, set by a write and cleared by the read that pays for
// it, with a read of clean layout costing nothing — which is what the engine
// does. Counting rather than stubbing follows `loadMoreOnScrollLayoutCost.
// test.ts`: "lays out once" and "lays out twice" return identical values and
// differ only in what they cost.
//
// The model's limits, because a model that overstates itself is worse than
// none. Reads: exhaustive for the properties this webview uses. Writes: every
// inline-style property (enumerated off the prototype, so a property nobody
// thought of is picked up by itself), innerHTML, insertAdjacentHTML, className,
// classList, textContent, node insertion and removal — all of which dirty
// layout unconditionally — plus attribute writes, which do not, and are
// modelled below on the one condition that decides it. A write outside all of
// that is invisible here, and it is the "lays out once" cases that would go on
// passing through a second layout it caused; the ordering cases need only the
// reads, which are complete.

/** Forced layouts and the graph-column write, in the order they happened. */
let trace: string[] = [];
let dirty = false;
let watching = false;

function wroteSomething() {
  if (watching) dirty = true;
}

/** Attribute names some rule in the shipped stylesheet selects on.
 *
 *  An attribute write can only invalidate style — and so only dirty layout — if
 *  a selector depends on that attribute. That is the whole reason this redraw
 *  measures once despite `restoreGraphFocus` moving the roving tab stop between
 *  its two reads: `tabindex` is not selected on, so writing it costs nothing.
 *  In Chromium 148 that read is 0.00ms; a model that counted the write would
 *  disagree with the engine it exists to describe.
 *
 *  Read out of media/main.css rather than asserted, so that the day someone
 *  adds a `[tabindex]` rule the model starts counting it again on its own and
 *  the cases below go red — instead of a comment quietly going out of date. */
const STYLED_ATTRIBUTES = new Set(
  ["class", "style"].concat(
    Array.from(
      fs
        .readFileSync(path.resolve(__dirname, "../../media/main.css"), "utf8")
        .matchAll(/\[\s*([A-Za-z][\w-]*)/g),
      (m) => m[1].toLowerCase()
    )
  )
);

const SVG_NS = "http://www.w3.org/2000/svg";

function wroteAttribute(el: Element, name: string) {
  // SVG attributes are presentational: the graph's width, height and path data
  // are its geometry, not metadata, so every one of them lays out.
  if (el.namespaceURI === SVG_NS || STYLED_ATTRIBUTES.has(name.toLowerCase())) wroteSomething();
}

/** The one write whose position is the whole point, so it is traced by name.
 *  It is `applyGraphColumnWidth` in main.ts; the property it sets is padding. */
function wroteGraphColumnPadding() {
  if (!watching) return;
  dirty = true;
  trace.push("write:graphColumnPadding");
}

function readGeometry(site: string) {
  if (!watching || !dirty) return; // layout already computed: free
  dirty = false;
  trace.push("layout:" + site);
}

function siteOf(el: Element, prop: string) {
  return el.tagName + (el.id ? "#" + el.id : "") + "." + prop;
}

/** Wrap an accessor/method, failing loudly if the shape it assumes is gone —
 *  a hook that silently found nothing to patch would make every assertion below
 *  pass for no reason. */
function descriptorOf(proto: object, prop: string) {
  const d = Object.getOwnPropertyDescriptor(proto, prop);
  if (d === undefined) throw new Error(`nothing to patch: ${prop}`);
  return d;
}

function patchWrite(proto: object, prop: string, onWrite: (this: unknown) => void) {
  const d = descriptorOf(proto, prop);
  if (d.set === undefined) throw new Error(`not a setter: ${prop}`);
  const set = d.set;
  Object.defineProperty(proto, prop, {
    ...d,
    set(value: unknown) {
      onWrite.call(this);
      set.call(this, value);
    }
  });
}

function patchWriteMethod(
  proto: object,
  name: string,
  onWrite: (self: unknown, args: unknown[]) => void = wroteSomething
) {
  const d = descriptorOf(proto, name);
  if (typeof d.value !== "function") throw new Error(`not a method: ${name}`);
  const original = d.value as (...args: unknown[]) => unknown;
  Object.defineProperty(proto, name, {
    ...d,
    value: function (this: unknown, ...args: unknown[]) {
      onWrite(this, args);
      return original.apply(this, args);
    }
  });
}

function patchRead(proto: object, prop: string) {
  const d = descriptorOf(proto, prop);
  if (d.get === undefined) throw new Error(`not a getter: ${prop}`);
  const get = d.get;
  Object.defineProperty(proto, prop, {
    ...d,
    get(this: Element) {
      readGeometry(siteOf(this, prop));
      return get.call(this);
    }
  });
}

function patchReadMethod(proto: object, name: string) {
  const d = descriptorOf(proto, name);
  if (typeof d.value !== "function") throw new Error(`not a method: ${name}`);
  const original = d.value as (...args: unknown[]) => unknown;
  Object.defineProperty(proto, name, {
    ...d,
    value: function (this: Element, ...args: unknown[]) {
      readGeometry(siteOf(this, name + "()"));
      return original.apply(this, args);
    }
  });
}

/** Every inline-style write, taken off the prototypes rather than listed: jsdom
 *  defines the CSS properties on a subclass of CSSStyleDeclaration, which one
 *  has moved between versions, and a list would go stale the first time the
 *  product code touched a property nobody thought of. */
function patchInlineStyleWrites() {
  let proto: object | null = Object.getPrototypeOf(document.createElement("div").style);
  let patched = 0;
  while (proto !== null && proto !== Object.prototype) {
    for (const prop of Object.getOwnPropertyNames(proto)) {
      const d = Object.getOwnPropertyDescriptor(proto, prop);
      if (d === undefined || d.set === undefined || !d.configurable) continue;
      patchWrite(proto, prop, prop === "padding" ? wroteGraphColumnPadding : wroteSomething);
      patched++;
    }
    for (const name of ["setProperty", "removeProperty"]) {
      if (Object.getOwnPropertyDescriptor(proto, name) !== undefined) {
        patchWriteMethod(proto, name);
        patched++;
      }
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  if (patched === 0) throw new Error("no inline-style setters were found to patch");
}

function installLayoutModel() {
  patchInlineStyleWrites();
  patchWrite(Element.prototype, "innerHTML", wroteSomething);
  patchWrite(Element.prototype, "className", wroteSomething);
  patchWrite(Node.prototype, "textContent", wroteSomething);
  patchWriteMethod(Element.prototype, "insertAdjacentHTML");
  for (const name of ["setAttribute", "removeAttribute"]) {
    patchWriteMethod(Element.prototype, name, (self, args) =>
      wroteAttribute(self as Element, String(args[0]))
    );
  }
  // `tabIndex` is the `tabindex` attribute wearing an IDL name, and goes
  // through the same rule — see STYLED_ATTRIBUTES for why that matters here.
  patchWrite(HTMLElement.prototype, "tabIndex", function (this: unknown) {
    wroteAttribute(this as Element, "tabindex");
  });
  for (const name of ["appendChild", "insertBefore", "removeChild", "replaceChild"]) {
    patchWriteMethod(Node.prototype, name);
  }
  for (const name of ["add", "remove", "toggle", "replace"]) {
    patchWriteMethod(DOMTokenList.prototype, name);
  }
  // Reads. Each computes layout when it is dirty and is free when it is not —
  // the same two cases the dirty bit above encodes.
  for (const prop of ["offsetWidth", "offsetHeight", "offsetTop", "offsetLeft"]) {
    patchRead(HTMLElement.prototype, prop);
  }
  for (const prop of ["clientHeight", "clientWidth", "scrollHeight", "scrollWidth"]) {
    patchRead(Element.prototype, prop);
  }
  for (const name of ["getBoundingClientRect", "getClientRects"]) {
    patchReadMethod(Element.prototype, name);
  }
}

const viewState = makeViewState();

/** Two windows over the same synthetic history. A redraw only happens when the
 *  commit list actually differs (an unchanged one short-circuits), so the two
 *  differ by one ref — the smallest difference that still forces a full redraw
 *  and leaves everything else about the two renders identical. */
function commits(variant: 0 | 1): GitCommitNode[] {
  return [
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
      parentHashes: ["ccc333"],
      author: "Bob",
      email: "bob@example.com",
      date: 1699000000,
      message: "Middle commit",
      refs: variant === 0 ? [] : [{ hash: "bbb222", name: "v1", type: "tag" }]
    },
    {
      hash: "ccc333",
      parentHashes: [],
      author: "Carol",
      email: "carol@example.com",
      date: 1698000000,
      message: "Base commit",
      refs: []
    }
  ];
}

const branchesResponse: GG.ResponseMessage = {
  command: "loadBranches",
  branches: ["main"],
  head: "main",
  hard: true,
  isRepo: true,
  filter: []
};

function commitsResponse(variant: 0 | 1): GG.ResponseMessage {
  return {
    command: "loadCommits",
    commits: commits(variant),
    head: "aaa111",
    moreCommitsAvailable: true,
    hard: true
  };
}

/** Run `action` with the model watching, and return what it saw. */
function watched(action: () => void) {
  trace = [];
  dirty = false;
  watching = true;
  action();
  watching = false;
  return trace;
}

/** One redraw, driven the way the host drives it: a page of commits arriving. */
function redraw(variant: 0 | 1) {
  return watched(() => receive(commitsResponse(variant)));
}

function layoutsIn(t: string[]) {
  return t.filter((e) => e.startsWith("layout:"));
}

function tableClass() {
  return document.getElementById("commitTable")!.className;
}

function graphColumnPadding() {
  return document.getElementById("tableHeaderGraphCol")!.style.padding;
}

function dateHeader() {
  return document.querySelector<HTMLElement>('.tableColHeader[data-col="date"]')!;
}

function commitRow(hash: string) {
  return document.querySelector<HTMLElement>(`tr.commit[data-hash="${hash}"]`)!;
}

/** Toggle the Date column through its header menu — a redraw with no commit
 *  load behind it, and the one other route into `render()`. */
function toggleDateColumn() {
  dateHeader().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  const item = Array.from(
    document.querySelectorAll<HTMLElement>("#contextMenu .contextMenuItem")
  ).find((li) => (li.textContent ?? "").trim().startsWith("Date"));
  if (item === undefined) throw new Error("the column header menu has no Date item");
  // The menu is opened outside the watched window on purpose: positioning it
  // measures the viewport, and those reads belong to the menu, not the redraw.
  return watched(() => item.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

const commitDetailsResponse: GG.ResponseMessage = {
  command: "commitDetails",
  commitDetails: {
    hash: "bbb222",
    parents: ["ccc333"],
    author: "Bob",
    email: "bob@example.com",
    committer: "Bob",
    committerEmail: "bob@example.com",
    authorDate: 1699000000,
    commitDate: 1699000000,
    body: "A commit body.",
    fileChanges: [
      { oldFilePath: "src/a.ts", newFilePath: "src/a.ts", type: "M", additions: 3, deletions: 1 }
    ]
  }
};

describe("how many times a redraw makes the browser lay the commit table out", () => {
  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock();
    setupHtml(viewState);
    await import("@/webview/main");
    receive(branchesResponse);
    receive(commitsResponse(0));

    // Installed after the opening render, so every scenario below describes a
    // steady-state redraw and not the boot path, which has a different shape.
    installLayoutModel();
  });

  describe("the shipped default, where the columns lay themselves out", () => {
    let autoTrace: string[];
    let autoPadding: string;

    beforeAll(() => {
      autoTrace = redraw(1);
      autoPadding = graphColumnPadding();
    });

    it("is the auto-laid-out branch and not the other one", () => {
      expect(tableClass()).toBe("autoLayout");
    });

    it("lays out once — the table entering the document, and nothing after it", () => {
      // Before #104 this was two: the graph column's padding was written
      // between this read and the heights renderGraph takes, so the engine had
      // to lay all of the rows out a second time.
      expect(layoutsIn(autoTrace)).toEqual(["layout:TH#tableHeaderGraphCol.offsetWidth"]);
    });

    it("writes the graph column's width last, after every read of this redraw", () => {
      expect(autoTrace[autoTrace.length - 1]).toBe("write:graphColumnPadding");
    });

    it("still writes the width the measurement asked for", () => {
      // The formula is unchanged: half of (the graph's width, floored at 64)
      // minus the column's own content width, on each side. jsdom reports 0 for
      // every geometric property, so the graph is 0 wide, the floor applies,
      // and the column's content width reads as 0 - 24.
      expect(autoPadding).toBe("0px 44px");
    });
  });

  describe("a redraw with no commit load behind it — a column toggled off", () => {
    let toggleTrace: string[];
    let paddingAfterToggle: string;

    beforeAll(() => {
      toggleTrace = toggleDateColumn();
      paddingAfterToggle = graphColumnPadding();
    });

    it("hid the column, so this is a redraw and not a no-op", () => {
      expect(dateHeader().classList.contains("hidden")).toBe(true);
    });

    it("still sizes the graph column", () => {
      // This path used to spell out renderTable + renderGraph for itself, which
      // is the shape that drops a write renderTable hands back: the graph column
      // would come out of a column toggle with no width at all.
      expect(paddingAfterToggle).toBe("0px 44px");
    });

    it("lays out once here too", () => {
      expect(layoutsIn(toggleTrace)).toEqual(["layout:TH#tableHeaderGraphCol.offsetWidth"]);
    });
  });

  describe("a redraw with an inline Commit Details View open", () => {
    let cdvTrace: string[];
    let paddingWithCdv: string;

    beforeAll(() => {
      commitRow("bbb222").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      receive(commitDetailsResponse);
      cdvTrace = redraw(0);
      paddingWithCdv = graphColumnPadding();
      // Closed again, so the fixed-width scenario below describes the same
      // table shape the auto one did.
      commitRow("bbb222").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    it("has the panel open, so this is the path being described", () => {
      expect(cdvTrace).not.toHaveLength(0);
      expect(paddingWithCdv).toBe("0px 44px");
    });

    it("lays out three times, and #104 is not why", () => {
      // Rebuilding the panel is itself a write, and it renders the graph again
      // on its own, so this redraw measures, writes the panel, measures, and
      // measures once more for the outer renderGraph. Both extra layouts are
      // the Commit Details View's, not the graph column's, and #104 neither
      // caused nor removed them. Recorded exactly so that "a redraw lays out
      // once" is not read as a claim about every redraw, which it is not: the
      // same shape shows up in Chromium 148 at 3000 rows, where these three
      // cost 275.8ms, 26.5ms and 29.5ms.
      expect(cdvTrace).toEqual([
        "layout:TH#tableHeaderGraphCol.offsetWidth",
        "layout:TR#tableColHeaders.clientHeight",
        "layout:TR#tableColHeaders.clientHeight",
        "write:graphColumnPadding"
      ]);
    });
  });

  describe("a redraw whose graph rendering throws half way", () => {
    let paddingAfterThrow: string;
    let thrown = 0;

    beforeAll(() => {
      // The cost of handing a write back is that something can now happen
      // between computing it and running it. `renderGraph` is that something,
      // and the fault is injected where it actually starts: the first height it
      // measures. jsdom reports a listener's exception rather than rethrowing
      // it, which is also what the real webview's error reporting does, so the
      // redraw is driven exactly as any other is.
      const d = descriptorOf(Element.prototype, "clientHeight");
      const get = d.get!;
      let armed = true;
      Object.defineProperty(Element.prototype, "clientHeight", {
        ...d,
        get(this: Element) {
          if (armed && this.id === "tableColHeaders") {
            armed = false;
            thrown++;
            throw new Error("injected: renderGraph cannot measure the header row");
          }
          return get.call(this);
        }
      });
      redraw(0);
      paddingAfterThrow = graphColumnPadding();
    });

    it("actually threw, so the case below is not describing an ordinary redraw", () => {
      expect(thrown).toBe(1);
    });

    it("still sizes the graph column, rather than leaving it unsized until the next one", () => {
      // renderTable has already replaced the header row by the time this
      // throws, so the new cell starts with no padding at all: without the
      // `finally` the column stays unsized for as long as nothing redraws.
      expect(paddingAfterThrow).toBe("0px 44px");
    });

    it("is back in a state a later redraw can describe", () => {
      expect(tableClass()).toBe("autoLayout");
    });
  });

  describe("after the user has dragged a column, where the widths are fixed", () => {
    let fixedTrace: string[];

    beforeAll(() => {
      // Enter fixedLayout the way a user does: grab a resize handle and let go.
      // The stored widths that come out of it are what makes the next redraw
      // take the other branch — nothing here reaches into repo state to fake it.
      document
        .querySelector<HTMLElement>(".resizeCol")!
        .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 100 }));
      document
        .getElementById("tableColHeaders")!
        .dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 100 }));
      fixedTrace = redraw(1);
    });

    // This path never measured the table, so it never had the second layout and
    // is not changed by #104. It is pinned so that a later attempt to share code
    // between the two branches cannot quietly give it one.
    it("is the fixed-width branch, and so a different scenario from the first", () => {
      expect(tableClass()).toBe("fixedLayout");
    });

    it("lays out once, for the heights the graph is positioned against", () => {
      expect(layoutsIn(fixedTrace)).toEqual(["layout:TR#tableColHeaders.clientHeight"]);
    });

    it("clears the graph column's padding before that read, not after", () => {
      expect(fixedTrace).toEqual([
        "write:graphColumnPadding",
        "layout:TR#tableColHeaders.clientHeight"
      ]);
    });

    it("sizes the column by its stored width instead of by padding", () => {
      // The width write itself is not observable here: jsdom reports every
      // column as 0 wide, so the width the drag stores comes out negative and
      // the CSS parser drops it. What this branch is pinned for is the pair
      // that *is* expressible — the layout mode, and a padding that was cleared
      // rather than computed.
      expect(graphColumnPadding()).toBe("");
    });
  });
});
