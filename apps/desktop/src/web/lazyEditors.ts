/* The editors as the page's bundle has them (#404): loaded the first time
 * one is asked for. Monaco is a few megabytes; every Tab's page, and the
 * window's own, would otherwise parse it on every load, though most never
 * show a diff. Its bundle and stylesheet come from the app itself
 * (`EDITOR_ASSETS`, served from `ging://app/`): nothing is fetched from
 * anywhere else, and the page's content security policy allows nothing else
 * (page.ts). */

import { EDITOR_ASSETS, EDITOR_GLOBAL } from "@ging/desktop/editorAssets";
import type { EditorFactory } from "@ging/webview/desktop/editors";

/** Resolves once `element`, put in the page, has loaded; rejects if it fails. */
function loaded(element: HTMLLinkElement | HTMLScriptElement, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    element.addEventListener("load", () => resolve(), { once: true });
    element.addEventListener("error", () => reject(new Error(`${what} did not load`)), {
      once: true
    });
  });
}

export function lazyEditors(doc: Document): EditorFactory {
  let editors: Promise<EditorFactory> | null = null;

  const load = (): Promise<EditorFactory> => {
    if (editors !== null) return editors;
    const style = doc.createElement("link");
    style.rel = "stylesheet";
    style.href = EDITOR_ASSETS.stylesheet;
    const script = doc.createElement("script");
    script.src = EDITOR_ASSETS.script;
    // The styles before the editor is made: it measures what it draws in.
    const ready = Promise.all([
      loaded(style, EDITOR_ASSETS.stylesheet),
      loaded(script, EDITOR_ASSETS.script)
    ]);
    doc.head.append(style, script);
    editors = ready
      .then(() => {
        const factory = (globalThis as Record<string, unknown>)[EDITOR_GLOBAL];
        if (factory === undefined) {
          throw new Error(`${EDITOR_ASSETS.script} loaded but gave no editors`);
        }
        return factory as EditorFactory;
      })
      .catch((e: unknown) => {
        // Tried afresh on the next diff, not failed for the page's life.
        style.remove();
        script.remove();
        editors = null;
        throw e;
      });
    return editors;
  };

  return {
    createDiffViewer: async (container, options) =>
      (await load()).createDiffViewer(container, options)
  };
}
