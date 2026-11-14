import { describe, expect, it, vi } from "vitest";

import { createVscodeMock } from "./setup";

// The desktop host says which kind of page it served, on `<html>` as
// `data-ging-page` (#388): a graph, or a notice in its place — nothing asked
// for, or a path that is no repository. A notice page still loads the desktop
// entry (the screens that replace the graph come in through it, ADR-0031) and
// starts no graph. A graph page the desktop host forgot to give a `viewState`
// is its mistake, and is reported as a failure rather than left blank.
//
// Apart from desktopEntry.test.ts, which boots the graph for its whole file.

/** Load the desktop entry afresh on a page of `kind`, with or without a
 *  `viewState`, and say what it did. */
async function load(kind: "graph" | "notice") {
  vi.resetModules();
  const mock = createVscodeMock();
  delete (globalThis as { viewState?: unknown }).viewState;
  document.documentElement.dataset.gingPage = kind;
  document.body.innerHTML = "<h2>Unable to load GING</h2>";
  await import("@ging/webview/desktop/main");
  return mock;
}

describe("the desktop entry on a notice page", () => {
  it("still marks the page as loaded from the desktop entry", async () => {
    await load("notice");
    expect(document.documentElement.dataset.gingEntry).toBe("ging-desktop-entry");
  });

  it("starts no graph: asks the host nothing and leaves the page as served", async () => {
    const mock = await load("notice");
    expect(mock.sentMessages).toEqual([]);
    expect(document.body.innerHTML).toBe("<h2>Unable to load GING</h2>");
  });
});

describe("the desktop entry on a graph page without a view state", () => {
  it("reports the failure to the host instead of starting nothing in silence", async () => {
    const mock = await load("graph");
    expect(mock.sentMessages).toEqual([
      {
        command: "reportError",
        report: expect.objectContaining({
          origin: "uncaught",
          command: null,
          message: expect.stringContaining("viewState")
        })
      }
    ]);
  });
});
