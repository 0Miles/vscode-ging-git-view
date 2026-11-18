/* The desktop app's editors (#404): Monaco's, made as the webview's desktop
 * entry asks for them (`EditorFactory`, packages/webview/src/desktop/editors.ts)
 * — a read-only diff, or one file read-only (#405). Its own bundle
 * (out/monaco.js, esbuild.js), loaded by a page on its first diff or file
 * (lazyEditors.ts), to which it hands the factory on `EDITOR_GLOBAL`.
 *
 * Offline and self-contained: Monaco's ESM build bundled whole, no AMD loader
 * and nothing from a CDN; its worker and font are the app's own files
 * (`EDITOR_ASSETS`). Monaco is MIT; its notice is in LICENSE (#402). */

import * as monaco from "monaco-editor/editor/editor.api";
// Monaco's contributions register themselves when imported: there is
// nothing to assign.
/* oxlint-disable import/no-unassigned-import */
// What a read-only diff needs of what `editor.main` would bring: the diff
// editor, Find, copying and the context menu, and every language's colouring
// (Monarch). Not the language services — TypeScript, CSS, HTML, JSON — which
// run workers of their own and serve editing, nor the rest of the editing
// contributions.
import "monaco-editor/editor/browser/widget/diffEditor/diffEditor.contribution";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard";
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu";
import "monaco-editor/features/find/register";
import "monaco-editor/languages/definitions/register.all";
// The codicon font, which `editor.main` imports and the package's exports do
// not reach (esbuild.js resolves `monaco-editor/esm/…` into the package).
import "monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css";
import "monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css";
/* oxlint-enable import/no-unassigned-import */

import { EDITOR_ASSETS, EDITOR_GLOBAL } from "@ging/desktop/editorAssets";
import type {
  DiffLayout,
  DiffViewer,
  EditorFactory,
  FileViewer,
  ThemeKind
} from "@ging/webview/desktop/editors";

// The diff is computed in Monaco's editor worker, the app's own file. Asked
// for when the first diff is computed, not before.
globalThis.MonacoEnvironment = {
  getWorker: () => new Worker(new URL(EDITOR_ASSETS.worker, document.baseURI))
};

/** A `--vscode-*` variable of the page's theme (on `<html>`, theme.ts), when
 *  it is a colour Monaco can take. */
function themeColour(name: string): string | undefined {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return /^#[0-9a-f]{3,8}$/i.test(value) ? value : undefined;
}

/** Monaco's theme for the page's: VS Code's own base, in the page's editor
 *  colours, so the diff sits on the same background as the graph. Defined
 *  anew each time, from the variables the page has then. */
function applyTheme(kind: ThemeKind): void {
  const colors: Record<string, string> = {};
  for (const [key, variable] of [
    ["editor.background", "--vscode-editor-background"],
    ["editor.foreground", "--vscode-editor-foreground"]
  ]) {
    const colour = themeColour(variable);
    if (colour !== undefined) colors[key] = colour;
  }
  const name = `ging-${kind}`;
  monaco.editor.defineTheme(name, {
    base: kind === "dark" ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors
  });
  monaco.editor.setTheme(name);
}

/** The page's editor font, as VS Code's webviews are told it. */
function editorFont(): { fontFamily?: string; fontSize?: number } {
  const css = getComputedStyle(document.documentElement);
  const family = css.getPropertyValue("--vscode-editor-font-family").trim();
  const size = parseFloat(css.getPropertyValue("--vscode-editor-font-size"));
  return {
    ...(family === "" ? {} : { fontFamily: family }),
    ...(Number.isFinite(size) ? { fontSize: size } : {})
  };
}

/** Each diff's two models get names of their own: Monaco keeps one model per
 *  URI. The path is the file's, so Monaco colours it by its name. */
let diffs = 0;
const modelUri = (diff: number, side: "original" | "modified", path: string) =>
  monaco.Uri.from({ scheme: "ging-diff", authority: `${diff}.${side}`, path: `/${path}` });

/** Each file shown gets a model of its own, coloured by its path as a diff's
 *  are. */
let files = 0;
const fileUri = (file: number, path: string) =>
  monaco.Uri.from({ scheme: "ging-file", authority: String(file), path: `/${path}` });

const sideBySide = (layout: DiffLayout) => layout === "sideBySide";

const editors: EditorFactory = {
  createDiffViewer: async (container, options) => {
    const diff = ++diffs;
    applyTheme(options.theme);
    const original = monaco.editor.createModel(
      options.original.content,
      undefined,
      modelUri(diff, "original", options.original.path)
    );
    const modified = monaco.editor.createModel(
      options.modified.content,
      undefined,
      modelUri(diff, "modified", options.modified.path)
    );
    const editor = monaco.editor.createDiffEditor(container, {
      ...editorFont(),
      readOnly: true,
      originalEditable: false,
      renderSideBySide: sideBySide(options.layout),
      // The layout is the user's to choose (the viewer's bar): a narrow
      // window does not switch it behind the choice's back.
      useInlineViewWhenSpaceIsLimited: false,
      // Nothing to revert into: both sides are read-only. Nor any hunk
      // actions for the gutter's menu to offer. And off as a workaround for
      // Monaco 0.57.0: the gutter re-reads its menu's actions on a timer that
      // dispose does not cancel, which then throws "AbstractContextKeyService
      // has been disposed" into the page. #406, putting hunk staging in the
      // gutter, must check the Monaco of its day first (ADR-0031, #404).
      renderMarginRevertIcon: false,
      renderGutterMenu: false,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      minimap: { enabled: false }
    });
    editor.setModel({ original, modified });
    if (options.revealLine !== null) {
      const right = editor.getModifiedEditor();
      right.setPosition({ lineNumber: options.revealLine, column: 1 });
      right.revealLineInCenter(options.revealLine);
    }
    const viewer: DiffViewer = {
      setLayout: (layout) => editor.updateOptions({ renderSideBySide: sideBySide(layout) }),
      setTheme: applyTheme,
      focus: () => editor.getModifiedEditor().focus(),
      dispose: () => {
        editor.dispose();
        original.dispose();
        modified.dispose();
      }
    };
    return viewer;
  },
  createFileViewer: async (container, options) => {
    applyTheme(options.theme);
    const model = monaco.editor.createModel(
      options.document.content,
      undefined,
      fileUri(++files, options.document.path)
    );
    const editor = monaco.editor.create(container, {
      ...editorFont(),
      model,
      readOnly: true,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      minimap: { enabled: false }
    });
    const viewer: FileViewer = {
      setTheme: applyTheme,
      focus: () => editor.focus(),
      dispose: () => {
        editor.dispose();
        model.dispose();
      }
    };
    return viewer;
  }
};

(globalThis as Record<string, unknown>)[EDITOR_GLOBAL] = editors;
