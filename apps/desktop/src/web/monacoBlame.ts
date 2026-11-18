/* A file's blame drawn in Monaco's read-only editor (#409): each line's
 * annotation as text Monaco injects before the line (an empty decoration's
 * `before`), so it scrolls and folds with it and takes no part in the file's
 * text — a copy of the lines leaves it out, and the cursor steps over it.
 * The annotation is written on the first line of each run of lines from one
 * commit, and the lines under it are left blank, as blame views do; every
 * line's annotation has the same width, so the code beside it stays in one
 * column. Its hover comes from a hover provider, which waits for the host's
 * Markdown (Monaco says it is loading meanwhile), whose links run the
 * `BLAME_LINKS` commands; the keyboard's Show Hover (Ctrl+K Ctrl+I) shows the
 * cursor line's. The editor's context menu has Find in Graph for the
 * cursor's line, the keyboard's way to a click on the annotation. */

import * as monaco from "monaco-editor/editor/editor.api";

import { provideBlameHover } from "@ging/desktop/web/blameHoverRule";
import { BLAME_LINKS, type BlameLink } from "@ging/webview/desktop/diff/blameProtocol";
import {
  BLAME_ANNOTATION_CLASS,
  type BlameGutter,
  type FileViewerBlame
} from "@ging/webview/desktop/editors";

/** The widest an annotation is drawn, in columns; a longer one is cut. */
const ANNOTATION_COLUMNS = 50;
/** Between the annotation and the line's own text. */
const GAP = "  ";

/** Where the hovers' links go: the viewer made last. A page shows one file
 *  at a time, and Monaco's commands are the page's, not an editor's. */
let linkTarget: ((link: BlameLink, arg: unknown) => void) | null = null;
let linksRegistered = false;

function registerLinks(): void {
  if (linksRegistered) return;
  linksRegistered = true;
  for (const link of Object.keys(BLAME_LINKS) as BlameLink[]) {
    // A link's argument is the JSON array of its URI's query; Monaco hands
    // its items over as arguments.
    monaco.editor.registerCommand(BLAME_LINKS[link], (_accessor, arg: unknown) =>
      linkTarget?.(link, arg)
    );
  }
}

/** How many columns `char` takes in a monospace font: two for the wide
 *  characters of East Asian scripts, one for the rest. */
function columns(char: string): number {
  const code = char.codePointAt(0)!;
  return (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
    ? 2
    : 1;
}

const widthOf = (text: string) => Array.from(text).reduce((n, c) => n + columns(c), 0);

/** `text` cut to `width` columns, an ellipsis marking the cut, and padded
 *  to it. */
function fit(text: string, width: number): string {
  let used = 0;
  let out = "";
  const chars = Array.from(text);
  const cut = widthOf(text) > width;
  for (const char of chars) {
    if (used + columns(char) > width - (cut ? 1 : 0)) break;
    out += char;
    used += columns(char);
  }
  if (cut) {
    out += "…";
    used += 1;
  }
  return out + " ".repeat(Math.max(0, width - used));
}

/** Each blamed file's hover, by its model: Monaco's hover providers are the
 *  page's, by language, and ask about every model there is. */
const hoverOf = new WeakMap<
  monaco.editor.ITextModel,
  (
    position: monaco.Position,
    token: monaco.CancellationToken
  ) => Promise<monaco.languages.Hover | null>
>();
let hoversRegistered = false;

function registerHovers(): void {
  if (hoversRegistered) return;
  hoversRegistered = true;
  // Every language: a file is coloured by its name, whatever it is.
  monaco.languages.registerHoverProvider("*", {
    provideHover: (model, position, token) => hoverOf.get(model)?.(position, token) ?? null
  });
}

/** The context key that holds while the editor shows a blame: what Find in
 *  Graph is offered under. */
const BLAME_SHOWN = "gingBlameShown";

export type EditorBlame = {
  set(blame: BlameGutter | null): void;
  dispose(): void;
};

export function attachBlame(
  editor: monaco.editor.IStandaloneCodeEditor,
  blame: FileViewerBlame | undefined
): EditorBlame {
  registerLinks();
  registerHovers();
  const events = blame?.events;
  const ownLinks = (link: BlameLink, arg: unknown) => events?.link({ link, arg });
  linkTarget = ownLinks;
  let shown: BlameGutter | null = null;
  /** Each line's decoration, by its 0-based line. */
  let ids: string[] = [];
  /** Where the pointer is: on an annotation (its 0-based line), on the code,
   *  or neither. */
  let pointedAt: number | null = null;
  let pointerOnCode: monaco.IPosition | null = null;
  const shownKey = editor.createContextKey<boolean>(BLAME_SHOWN, false);

  /** Line `line`'s decoration: its annotation, `content`. No hover of its
   *  own: the provider below writes it, waiting for the host. */
  function decoration(line: number, content: string): monaco.editor.IModelDeltaDecoration {
    return {
      range: new monaco.Range(line + 1, 1, line + 1, 1),
      options: {
        // An empty range, drawn all the same: Monaco leaves out an empty
        // decoration, its injected text with it, unless told to show it.
        showIfCollapsed: true,
        before: {
          content,
          inlineClassName: BLAME_ANNOTATION_CLASS,
          cursorStops: monaco.editor.InjectedTextCursorStops.None
        }
      }
    };
  }

  /** The annotation under the pointer: its 0-based line, or null. */
  function annotationAt(target: monaco.editor.IMouseTarget): number | null {
    if (shown === null || target.position === null) return null;
    if (!target.element?.closest(`.${BLAME_ANNOTATION_CLASS}`)) return null;
    const line = target.position.lineNumber - 1;
    return line < ids.length ? line : null;
  }

  const model = editor.getModel();
  // The blame's hover: on an annotation, or the keyboard's at the cursor
  // (`blameHoverLine`), in full once the host has written it.
  if (model !== null && events !== undefined) {
    hoverOf.set(model, async (position, token) => {
      if (shown === null || model !== editor.getModel()) return null;
      const answer = await provideBlameHover(
        { position, pointedAt, pointerOnCode, cursor: editor.getPosition() },
        (line) => events.hover(line),
        () => token.isCancellationRequested
      );
      if (answer === null) return null;
      return {
        range: new monaco.Range(answer.line + 1, 1, answer.line + 1, 1),
        contents: [
          {
            value: answer.markdown,
            supportThemeIcons: true,
            // The hover's own links, and nothing else, may run a command.
            isTrusted: { enabledCommands: Object.values(BLAME_LINKS) }
          }
        ]
      };
    });
  }

  const disposables: monaco.IDisposable[] = [
    editor.onMouseMove((e) => {
      pointedAt = annotationAt(e.target);
      pointerOnCode =
        pointedAt === null && e.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT
          ? e.target.position
          : null;
    }),
    editor.onMouseLeave(() => {
      pointedAt = null;
      pointerOnCode = null;
    }),
    editor.onMouseDown((e) => {
      if (!e.event.leftButton) return;
      const line = annotationAt(e.target);
      if (line !== null) events?.click(line);
    })
  ];
  // The keyboard's way to a click on an annotation: from the context menu
  // (Shift+F10), for the cursor's line.
  if (blame !== undefined) {
    disposables.push(
      editor.addAction({
        id: "ging.blame.findInGraph",
        label: blame.findInGraph,
        precondition: BLAME_SHOWN,
        contextMenuGroupId: "navigation",
        contextMenuOrder: 1,
        run: (ed) => {
          const position = ed.getPosition();
          if (position !== null && shown !== null) events?.click(position.lineNumber - 1);
        }
      })
    );
  }

  return {
    set(next) {
      shown = next;
      shownKey.set(next !== null);
      const now = editor.getModel();
      const count =
        next === null || now === null ? 0 : Math.min(next.lines.length, now.getLineCount());
      const width = Math.min(
        ANNOTATION_COLUMNS,
        Math.max(0, ...(next?.commits.map((c) => widthOf(c.text)) ?? []))
      );
      // A commit's annotation on the first of its lines in a row, blank on
      // the rest: each made once, not once per line.
      const labels = next?.commits.map((c) => fit(c.text, width) + GAP) ?? [];
      const blank = " ".repeat(width) + GAP;
      const lines = next?.lines ?? [];
      const decorations: monaco.editor.IModelDeltaDecoration[] = [];
      for (let line = 0; line < count; line++) {
        const first = line === 0 || lines[line - 1] !== lines[line];
        decorations.push(decoration(line, first ? labels[lines[line]] : blank));
      }
      ids = editor.deltaDecorations(ids, decorations);
    },
    dispose() {
      for (const disposable of disposables) disposable.dispose();
      if (model !== null) hoverOf.delete(model);
      if (linkTarget === ownLinks) linkTarget = null;
    }
  };
}
