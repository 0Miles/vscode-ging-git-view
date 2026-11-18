import { afterEach, describe, expect, it } from "vitest";

import { EDITOR_ASSETS, EDITOR_GLOBAL } from "@ging/desktop/editorAssets";
import { lazyEditors } from "@ging/desktop/web/lazyEditors";
import type { DiffViewer, EditorFactory, FileViewer } from "@ging/webview/desktop/editors";

// The editors as a page's bundle has them (#404): Monaco's bundle is put in
// the page the first time a diff asks, and only then. jsdom loads neither
// file, so each test says when they have loaded (or failed to).

const options = {
  original: { path: "a.txt", content: "a\n" },
  modified: { path: "a.txt", content: "b\n" },
  layout: "sideBySide" as const,
  theme: "dark" as const,
  revealLine: null
};
const viewer: DiffViewer = {
  setLayout: () => {},
  setTheme: () => {},
  focus: () => {},
  dispose: () => {}
};
const fileViewer: FileViewer = {
  setBlame: () => {},
  setBlameHover: () => {},
  setTheme: () => {},
  focus: () => {},
  dispose: () => {}
};
const monaco: EditorFactory = {
  createDiffViewer: async () => viewer,
  createFileViewer: async () => fileViewer
};

const script = () =>
  document.head.querySelector<HTMLScriptElement>(`script[src="${EDITOR_ASSETS.script}"]`);
const style = () =>
  document.head.querySelector<HTMLLinkElement>(`link[href="${EDITOR_ASSETS.stylesheet}"]`);
/** The editors' bundle, as it does once evaluated: its factory on the global. */
const evaluate = () => ((globalThis as Record<string, unknown>)[EDITOR_GLOBAL] = monaco);

afterEach(() => {
  document.head.innerHTML = "";
  delete (globalThis as Record<string, unknown>)[EDITOR_GLOBAL];
});

describe("the page's editors", () => {
  it("put nothing in the page until a diff is asked for", () => {
    lazyEditors(document);

    expect(script()).toBeNull();
    expect(style()).toBeNull();
  });

  it("load Monaco's bundle and styles from the app on the first diff, then make it", async () => {
    const editors = lazyEditors(document);
    const made = editors.createDiffViewer(document.createElement("div"), options);

    expect(script()).not.toBeNull();
    expect(style()?.rel).toBe("stylesheet");
    evaluate();
    style()!.dispatchEvent(new Event("load"));
    script()!.dispatchEvent(new Event("load"));

    await expect(made).resolves.toBe(viewer);
  });

  it("load them once, however many diffs follow", async () => {
    const editors = lazyEditors(document);
    const first = editors.createDiffViewer(document.createElement("div"), options);
    const second = editors.createDiffViewer(document.createElement("div"), options);
    evaluate();
    style()!.dispatchEvent(new Event("load"));
    script()!.dispatchEvent(new Event("load"));
    await Promise.all([first, second]);

    await editors.createDiffViewer(document.createElement("div"), options);

    expect(document.head.querySelectorAll("script")).toHaveLength(1);
    expect(document.head.querySelectorAll("link")).toHaveLength(1);
  });

  it("load the same bundle, once, for a file shown read-only (#405)", async () => {
    const editors = lazyEditors(document);
    const file = editors.createFileViewer(document.createElement("div"), {
      document: { path: "a.ts", content: "a\n" },
      theme: "dark"
    });
    evaluate();
    style()!.dispatchEvent(new Event("load"));
    script()!.dispatchEvent(new Event("load"));
    await expect(file).resolves.toBe(fileViewer);

    await expect(editors.createDiffViewer(document.createElement("div"), options)).resolves.toBe(
      viewer
    );
    expect(document.head.querySelectorAll("script")).toHaveLength(1);
  });

  it("reject when the bundle does not load, and try afresh on the next diff", async () => {
    const editors = lazyEditors(document);
    const failed = editors.createDiffViewer(document.createElement("div"), options);
    style()!.dispatchEvent(new Event("load"));
    script()!.dispatchEvent(new Event("error"));

    await expect(failed).rejects.toThrow(`${EDITOR_ASSETS.script} did not load`);
    expect(script()).toBeNull();
    expect(style()).toBeNull();

    const again = editors.createDiffViewer(document.createElement("div"), options);
    evaluate();
    style()!.dispatchEvent(new Event("load"));
    script()!.dispatchEvent(new Event("load"));
    await expect(again).resolves.toBe(viewer);
  });

  it("reject when the bundle loaded but handed over no editors", async () => {
    const editors = lazyEditors(document);
    const made = editors.createDiffViewer(document.createElement("div"), options);
    style()!.dispatchEvent(new Event("load"));
    script()!.dispatchEvent(new Event("load"));

    await expect(made).rejects.toThrow("gave no editors");
  });
});
