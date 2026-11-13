import { beforeAll, describe, expect, it, vi } from "vitest";

import { createVscodeMock } from "./setup";

// The desktop host serves a page without a graph when it has no repository to
// show: nothing asked for, or a path that is not one (#388). That page still
// loads the desktop entry — the screens that replace the graph come in through
// it (ADR-0031) — but carries no `viewState`, and the graph must not start on
// it: built from nothing, it would only throw, and report that it did.
//
// A file of its own, because desktopEntry.test.ts boots the graph for its
// whole file and a module is evaluated once.

describe("the desktop entry on a page without a graph", () => {
  let mock: ReturnType<typeof createVscodeMock>;
  const errors: unknown[] = [];

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    delete (globalThis as { viewState?: unknown }).viewState;
    document.body.innerHTML = "<h2>Unable to load GING</h2>";
    window.addEventListener("error", (e) => errors.push(e.error));
    await import("@ging/webview/desktop/main");
  });

  it("still marks the page as loaded from the desktop entry", () => {
    expect(document.documentElement.dataset.gingEntry).toBe("ging-desktop-entry");
  });

  it("starts no graph: asks the host nothing and leaves the page as served", () => {
    expect(mock.sentMessages).toEqual([]);
    expect(errors).toEqual([]);
    expect(document.body.innerHTML).toBe("<h2>Unable to load GING</h2>");
  });
});
