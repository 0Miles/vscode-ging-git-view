import { describe, expect, it } from "vitest";

import {
  findGraphTabs,
  GRAPH_VIEW_TYPE,
  isGraphWebviewTab,
  mayOpenGraphUnprompted
} from "@/extension/graphPanelWindow";

/** A tab holding a webview of `viewType`, in the shape `vscode.Tab` reports. */
const webviewTab = (viewType: string) => ({ input: { viewType } });
/** A tab holding an ordinary text editor — no `viewType` at all. */
const textTab = (path: string) => ({ input: { uri: { path } } });

describe("isGraphWebviewTab", () => {
  it("matches the graph panel's tab through VSCode's mainThreadWebview- prefix", () => {
    // What `createWebviewPanel` was given …
    expect(isGraphWebviewTab(webviewTab(GRAPH_VIEW_TYPE))).toBe(true);
    // … and what the tab reports it back as (microsoft/vscode#150031).
    expect(isGraphWebviewTab(webviewTab(`mainThreadWebview-${GRAPH_VIEW_TYPE}`))).toBe(true);
  });

  it("ignores tabs that are not a graph panel", () => {
    expect(isGraphWebviewTab(textTab("/repo/README.md"))).toBe(false);
    expect(isGraphWebviewTab(webviewTab("mainThreadWebview-markdown.preview"))).toBe(false);
    expect(isGraphWebviewTab({ input: undefined })).toBe(false);
  });

  it("does not match a view type that merely ends with the graph's name", () => {
    expect(isGraphWebviewTab(webviewTab("someone-elses-ging-git-view"))).toBe(false);
  });
});

describe("findGraphTabs", () => {
  it("collects every graph tab across all groups, in tab order", () => {
    const first = webviewTab(`mainThreadWebview-${GRAPH_VIEW_TYPE}`);
    const second = webviewTab(GRAPH_VIEW_TYPE);
    const groups = [
      { tabs: [textTab("/repo/a.ts"), first] },
      { tabs: [second, textTab("/repo/b.ts")] }
    ];
    expect(findGraphTabs(groups)).toEqual([first, second]);
  });

  it("finds nothing in a window with no graph open", () => {
    expect(findGraphTabs([{ tabs: [textTab("/repo/a.ts")] }])).toEqual([]);
    expect(findGraphTabs([])).toEqual([]);
  });
});

describe("mayOpenGraphUnprompted", () => {
  it("allows a window that has a workspace open", () => {
    expect(mayOpenGraphUnprompted([{ uri: "/repo" }])).toBe(true);
  });

  it("refuses a window with no folder open", () => {
    expect(mayOpenGraphUnprompted(undefined)).toBe(false);
    expect(mayOpenGraphUnprompted([])).toBe(false);
  });
});
