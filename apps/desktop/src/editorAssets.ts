/* The editor's files (#404): Monaco, built apart from the page's own bundle
 * (esbuild.js) and loaded by a Tab's page on its first diff
 * (web/lazyEditors.ts). The main process serves them from out/ beside the
 * page's assets (`PAGE_ASSETS`); esbuild.js writes them under these names.
 * Rename one, rename both. */

export const EDITOR_ASSETS = {
  /** The editors' bundle: Monaco and the factory over it (web/monacoEditors.ts). */
  script: "monaco.js",
  /** Monaco's styles, the codicon font's rules among them. */
  stylesheet: "monaco.css",
  /** The codicon font the stylesheet loads, beside it. */
  font: "codicon.ttf",
  /** Monaco's editor worker: it computes the diffs. */
  worker: "editor.worker.js"
} as const;

/** The global the editors' bundle hands its `EditorFactory` over on: the
 *  two bundles share nothing else. */
export const EDITOR_GLOBAL = "gingEditors";
