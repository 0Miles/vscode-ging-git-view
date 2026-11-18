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
import type { FileHunk } from "@ging/shared/backend/types";
import type {
  DiffLayout,
  DiffViewer,
  EditorFactory,
  FileViewer,
  HunkActions,
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

/** The line of the modified side a hunk's control goes above: its first, or,
 *  for a hunk that keeps none of that side's lines, after where they were. */
const above = (hunk: FileHunk) =>
  hunk.modified.count === 0 ? hunk.modified.start : hunk.modified.start - 1;

/** The hunk whose lines on `side` hold `line`; -1 for none. A hunk that
 *  takes no line of a side (count 0) holds none of it. */
const hunkAt = (hunks: FileHunk[], side: "original" | "modified", line: number) =>
  hunks.findIndex(({ [side]: span }) => line >= span.start && line < span.start + span.count);

/** The context key that says the cursor of an editor is in a hunk: the
 *  context menu's hunk action is listed only then. Each editor has its own. */
const IN_HUNK = "ging.cursorInHunk";

/** How tall the row each hunk's button sits in is, in pixels. */
const HUNK_ROW = 24;

/**
 * Offer `actions` on each hunk (#406): a button on a row of its own above the
 * hunk's first line on the modified side, named by its lines; and, for the
 * keyboard, the same action in either editor's context menu (Shift+F10),
 * listed only while the cursor is in a hunk, which it acts on. The editors'
 * accessible names say so. Not the diff editor's own gutter menu: it is off, for Monaco 0.57.0's
 * bug (`renderGutterMenu`, below), and its hunks would be Monaco's own, not
 * git's — which are what a patch is made of.
 *
 * The row is a view zone, which the diff editor pads on the other side to
 * keep the two aligned (inline, the modified side is the one editor shown).
 * The button is not in it: the editor's lines are drawn over its view zones
 * and take their clicks. It is an overlay widget, put where the zone is each
 * time the editor draws it (as Monaco's own zone widgets are), and out of
 * sight while the zone is.
 */
function offerHunks(
  editor: monaco.editor.IStandaloneDiffEditor,
  actions: HunkActions
): monaco.IDisposable {
  const right = editor.getModifiedEditor();
  const widgets: monaco.editor.IOverlayWidget[] = [];
  const zoneIds: string[] = [];
  right.changeViewZones((zones) => {
    actions.hunks.forEach((hunk, index) => {
      // Monaco clears the widget's own `top` as it lays it out: the button
      // is placed inside it.
      const widget = document.createElement("div");
      widget.className = "diffViewerHunkWidget";
      const row = document.createElement("div");
      row.className = "diffViewerHunk";
      row.style.height = `${HUNK_ROW}px`;
      // Out of sight until the editor first draws its zone.
      row.style.top = "-1000000px";
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = actions.label;
      // Every button says the same word: its name says which lines.
      button.setAttribute("aria-label", actions.names[index]);
      button.title = actions.names[index];
      button.dataset.hunk = String(index);
      button.addEventListener("click", () => actions.choose(index));
      row.append(button);
      widget.append(row);
      const overlay: monaco.editor.IOverlayWidget = {
        getId: () => `ging.hunk.${index}`,
        getDomNode: () => widget,
        getPosition: () => null
      };
      right.addOverlayWidget(overlay);
      widgets.push(overlay);
      zoneIds.push(
        zones.addZone({
          afterLineNumber: above(hunk),
          heightInPx: HUNK_ROW,
          domNode: document.createElement("div"),
          onDomNodeTop: (top) => {
            row.style.top = `${top}px`;
            row.style.left = `${right.getLayoutInfo().contentLeft}px`;
          }
        })
      );
    });
  });
  // The buttons are outside the editors' keyboard order, so the keyboard's
  // way is the context menu, on either side, listed only with the cursor in
  // a hunk; and the editors' names say so to a screen reader.
  const keyed = (["original", "modified"] as const).map((side) => {
    const one = side === "original" ? editor.getOriginalEditor() : right;
    one.updateOptions({ ariaLabel: actions.keyboard });
    const at = () => hunkAt(actions.hunks, side, one.getPosition()?.lineNumber ?? 0);
    const inHunk = one.createContextKey(IN_HUNK, at() !== -1);
    const moved = one.onDidChangeCursorPosition(() => inHunk.set(at() !== -1));
    const action = one.addAction({
      id: "ging.hunk",
      label: actions.label,
      precondition: IN_HUNK,
      contextMenuGroupId: "navigation",
      contextMenuOrder: 0,
      run: () => {
        const index = at();
        if (index !== -1) actions.choose(index);
      }
    });
    return [moved, action];
  });
  return {
    dispose: () => {
      for (const disposable of keyed.flat()) disposable.dispose();
      for (const overlay of widgets) right.removeOverlayWidget(overlay);
      right.changeViewZones((zones) => zoneIds.forEach((id) => zones.removeZone(id)));
    }
  };
}

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
      // Nothing to revert into: both sides are read-only. The gutter's menu
      // stays off as a workaround for Monaco 0.57.0: the gutter re-reads its
      // menu's actions on a timer that dispose does not cancel, which then
      // throws "AbstractContextKeyService has been disposed" into the page.
      // Hunk staging (#406) does not use it (`offerHunks`); a later use must
      // check the Monaco of its day first (ADR-0031, #404).
      renderMarginRevertIcon: false,
      renderGutterMenu: false,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      minimap: { enabled: false }
    });
    editor.setModel({ original, modified });
    const offered = options.hunks === undefined ? null : offerHunks(editor, options.hunks);
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
        offered?.dispose();
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
