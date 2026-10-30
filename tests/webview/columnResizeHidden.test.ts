import * as fs from "node:fs";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

import {
  createVscodeMock,
  DEFAULT_REPO,
  makeViewState,
  receive,
  rightClick,
  setupHtml
} from "./setup";

// Dragging a column edge while a column is hidden saved a negative width:
// `columnWidths` came back as `[119,-24,38,42]` (#261). The first drag measures
// every column off its header as `clientWidth - 24`, and a hidden header
// (`display: none`) measures 0. And once widths were stored, the handles still
// paired each column with its neighbour in the markup, hidden or not: the edge
// between Description and Author resized the hidden Date column, and Author's
// right edge, with Commit hidden, resized Commit.
//
// jsdom lays nothing out, so `clientWidth` is stood in for: a header's natural
// width while it is displayed, 0 while it is not. "Displayed" is read off the
// computed style with the shipped stylesheet loaded, so the stand-in answers
// to the same rules the webview does rather than to a class name. Real
// Chromium was checked by hand against the same scenarios (see the PR).
//
// One webview is booted for the whole file and the scenarios run in order, the
// way a session unfolds (#80).

const L = getWebviewLocalizedStrings();

/** Each header's width as the browser would lay it out, padding included. */
const NATURAL_WIDTH: Record<string, number> = {
  graph: 150,
  description: 400,
  date: 130,
  author: 110,
  commit: 80
};
/** What the first drag stores for a column: its width less the header's 12px
 *  padding either side. */
const measured = (key: string) => NATURAL_WIDTH[key] - 24;

/** Widths left over from the bug, as one user's state still holds them. */
const CORRUPT = [119, -24, 38, 42];

const viewState = makeViewState({
  defaultColumnVisibility: { date: false, author: true, commit: true },
  repos: { [DEFAULT_REPO]: { columnWidths: CORRUPT } }
});

const commits: GitCommitNode[] = [
  {
    hash: "aaa111",
    parentHashes: [],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Only commit",
    refs: [{ hash: "aaa111", name: "main", type: "head" }]
  }
];

let mock: ReturnType<typeof createVscodeMock>;
const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")!;

function headerKey(th: HTMLElement): string {
  if (th.id === "tableHeaderGraphCol") return "graph";
  return th.dataset.col ?? "description";
}

function header(key: string) {
  const th = Array.from(
    document.querySelectorAll<HTMLElement>("#commitTable #tableColHeaders th")
  ).find((h) => headerKey(h) === key);
  expect(th, key).toBeDefined();
  return th!;
}

function handle(key: string, side: "left" | "right") {
  return header(key).querySelector<HTMLElement>(`.resizeCol.${side}`);
}

/** Press `elem`, move the pointer `dx` across the header row, release. */
function drag(elem: HTMLElement, dx: number) {
  const row = document.getElementById("tableColHeaders")!;
  elem.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 500 }));
  row.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 500 + dx }));
  row.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 500 + dx }));
}

function lastSavedWidths(): number[] | null {
  const saves = mock.sentOf("saveRepoState");
  expect(saves.length).toBeGreaterThan(0);
  return saves[saves.length - 1].state.columnWidths;
}

function toggleColumn(label: string) {
  rightClick(header("date"));
  const item = Array.from(
    document.querySelectorAll<HTMLElement>("#contextMenu .contextMenuItem")
  ).find((li) => (li.textContent ?? "").trim().endsWith(label));
  expect(item, label).toBeDefined();
  item!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

describe("resizing a column while another is hidden", () => {
  beforeAll(async () => {
    Object.defineProperty(Element.prototype, "clientWidth", {
      configurable: true,
      get(this: Element) {
        if (!(this instanceof HTMLTableCellElement) || this.tagName !== "TH") return 0;
        if (getComputedStyle(this).display === "none") return 0;
        return NATURAL_WIDTH[headerKey(this)] ?? 0;
      }
    });
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    const style = document.createElement("style");
    style.textContent = fs.readFileSync(path.resolve(__dirname, "../../media/main.css"), "utf8");
    document.head.appendChild(style);
    await import("@/webview/main");
    receive({
      command: "loadBranches",
      token: 0,
      branches: ["main"],
      head: "main",
      hard: true,
      isRepo: true,
      filter: []
    } satisfies GG.ResponseMessage);
    receive({
      command: "loadCommits",
      token: 0,
      commits,
      head: "aaa111",
      moreCommitsAvailable: false,
      hard: true
    } satisfies GG.ResponseMessage);
  });

  afterAll(() => {
    Object.defineProperty(Element.prototype, "clientWidth", clientWidth);
  });

  it("lays the table out afresh over a stored negative width, rather than applying it", () => {
    expect(getComputedStyle(header("date")).display).toBe("none");
    expect(document.getElementById("commitTable")!.className).toBe("autoLayout");
  });

  it("stores a hidden column at its natural width on the first drag, not at -24", () => {
    mock.clearMessages();
    drag(handle("graph", "right")!, 10);
    expect(lastSavedWidths()).toEqual([
      measured("graph") + 10,
      measured("date"),
      measured("author"),
      measured("commit")
    ]);
  });

  it("resizes the visible column across a hidden one, leaving the hidden width alone", () => {
    // With Date hidden, Author's left edge is Description's right edge.
    mock.clearMessages();
    drag(handle("author", "left")!, -20);
    expect(lastSavedWidths()).toEqual([
      measured("graph") + 10,
      measured("date"),
      measured("author") + 20,
      measured("commit")
    ]);
    // And from Description's side the same edge does the same thing.
    mock.clearMessages();
    drag(handle("description", "right")!, 20);
    expect(lastSavedWidths()).toEqual([
      measured("graph") + 10,
      measured("date"),
      measured("author"),
      measured("commit")
    ]);
  });

  it("gives the last visible column no right edge to drag against a hidden one", () => {
    toggleColumn(L.commit);
    expect(getComputedStyle(header("commit")).display).toBe("none");
    expect(handle("author", "right")).toBeNull();
    expect(handle("author", "left")).not.toBeNull();
  });

  it("brings a hidden column back at the width it kept", () => {
    toggleColumn(L.date);
    expect(getComputedStyle(header("date")).display).not.toBe("none");
    expect(header("date").style.width).toBe(measured("date") + "px");
  });
});
