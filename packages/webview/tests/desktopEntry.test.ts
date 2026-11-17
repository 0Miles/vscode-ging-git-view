import { beforeAll, describe, expect, it, vi } from "vitest";

import type * as GG from "@ging/shared/types";
import type { DiffViewerOptions, EditorFactory } from "@ging/webview/desktop/editors";

import { createVscodeMock, graphRow, makeViewState, receive, setupHtml } from "./setup";
import { startDesktop } from "./startDesktop";

// The desktop entry (#384) is the bundle only the desktop host ships. What it
// owes the desktop host today is two things: the same graph view the VS Code
// entry boots, and a marker that says which entry the page loaded — the string
// #386's E2E looks for. Keeping it out of the extension's bundle is not this
// file's job: apps/vscode/tests/backend/webviewEntries.test.ts bundles both
// entries itself and holds the extension's to that.
//
// One webview is booted for the whole file, as in busyLoads: re-importing per
// scenario would leave the previous instance listening on `window`.

const viewState = makeViewState();

/** What the diff viewer asked the editors to draw. */
const diffsAsked: DiffViewerOptions[] = [];
const editors: EditorFactory = {
  createDiffViewer: async (_container, options) => {
    diffsAsked.push(options);
    return { setLayout: () => {}, setTheme: () => {}, focus: () => {}, dispose: () => {} };
  }
};

const branchesResponse: GG.ResponseMessage = {
  command: "loadBranches",
  token: 0,
  branches: ["main"],
  head: "main",
  hard: true,
  isRepo: true,
  filter: []
};

const commitsResponse: GG.ResponseMessage = {
  command: "loadCommits",
  token: 0,
  commits: [
    {
      hash: "aaa111",
      parentHashes: [],
      author: "Alice",
      email: "alice@example.com",
      date: 1700000000,
      message: "Only commit",
      refs: [{ hash: "aaa111", name: "main", type: "head" }]
    }
  ],
  head: "aaa111",
  moreCommitsAvailable: false,
  hard: true
};

describe("the desktop entry", () => {
  let mock: ReturnType<typeof createVscodeMock>;

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    // As the desktop host serves a graph page (#388).
    document.documentElement.dataset.gingPage = "graph";
    await startDesktop(editors);
  });

  it("marks the page as loaded from the desktop entry", () => {
    expect(document.documentElement.dataset.gingEntry).toBe("ging-desktop-entry");
  });

  it("tells the desktop host it is listening for its prompts (#390)", () => {
    // Not a request: read off the wire as the host reads it.
    expect(mock.sentMessages.map((m) => m.command as string)).toContain("hostPromptReady");
  });

  it("boots the same graph view the VS Code entry does", () => {
    expect(mock.sentOf("loadBranches")).toHaveLength(1);

    receive(branchesResponse);
    receive(commitsResponse);

    expect(graphRow("aaa111").textContent).toContain("Only commit");
  });

  it("leaves a message that is not the graph's alone, without reporting a failure", () => {
    // The desktop host's own messages (`HostPromptMessage`, #390) travel the
    // same `message` channel but are kept out of `ResponseMessage` (ADR-0031),
    // so the graph's listener hears them too. That is only safe while the
    // dispatch drops a command it has no arm for; this pins it. (Malformed, so
    // the overlay's listener drops it as well: jsdom has no modal dialog to
    // show it in. The overlay itself is the webview E2E's, e2e/webview.)
    mock.clearMessages();

    receive({ command: "hostPrompt" } as unknown as GG.ResponseMessage);

    expect(mock.sentOf("reportError")).toEqual([]);
  });

  it("shows a diff the host sends in the diff viewer, with the editors it was handed (#404)", async () => {
    mock.clearMessages();

    receive({
      command: "showDiff",
      title: "file.txt (aaa111^ ↔ aaa111)",
      original: { path: "file.txt", content: "before\n" },
      modified: { path: "file.txt", content: "after\n" },
      revealLine: null,
      strings: { sideBySide: "Side by Side", inline: "Inline", close: "Close", cannotShow: "-" }
    } as unknown as GG.ResponseMessage);
    await vi.waitFor(() => expect(diffsAsked).toHaveLength(1));

    expect(diffsAsked[0]).toMatchObject({ original: { content: "before\n" } });
    expect(document.getElementById("diffViewer")!.hidden).toBe(false);
    // The graph's listener heard it too, and let it be.
    expect(mock.sentOf("reportError")).toEqual([]);
  });
});
