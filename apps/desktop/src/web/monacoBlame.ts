/* A file's blame drawn in Monaco's read-only editor (#409): each line's
 * annotation as text Monaco injects before the line (an empty decoration's
 * `before`), so it scrolls and folds with it and takes no part in the file's
 * text — a copy of the lines leaves it out, and the cursor steps over it.
 * The annotation is written on the first line of each run of lines from one
 * commit, and the lines under it are left blank, as blame views do; every
 * line's annotation has the same width, so the code beside it stays in one
 * column. The hover of an annotation is the decoration's own: what the
 * annotation says until the host has written it in full, then the host's
 * Markdown, whose links run the `BLAME_LINKS` commands. */

import * as monaco from "monaco-editor/editor/editor.api";

import {
  BLAME_ANNOTATION_CLASS,
  BLAME_LINKS,
  type BlameGutter,
  type BlameGutterEvents,
  type BlameLink
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

/** `text` as Markdown that shows exactly it. */
const markdownText = (text: string) => text.replace(/[\\`*_{}[\]()#+\-.!|<>~$&=]/g, "\\$&");

/** What Monaco's content hover controller (`editor.contrib.contentHover`)
 *  does that the hover of a line is shown anew with: not in Monaco's API. */
type ContentHover = {
  hideContentHover(): void;
  showContentHover(range: monaco.Range, mode: number, source: number, focus: boolean): void;
};
/** `HoverStartMode.Immediate` and `HoverStartSource.Mouse`, as Monaco 0.57
 *  numbers them. */
const IMMEDIATE = 1;
const MOUSE = 0;

/** The editor's content hover controller, when it is there as Monaco 0.57
 *  has it; null otherwise, and a hover written in full shows on the next
 *  hover instead. */
function contentHover(editor: monaco.editor.IStandaloneCodeEditor): ContentHover | null {
  const controller = editor.getContribution(
    "editor.contrib.contentHover"
  ) as Partial<ContentHover> | null;
  return typeof controller?.showContentHover === "function" &&
    typeof controller.hideContentHover === "function"
    ? (controller as ContentHover)
    : null;
}

export type EditorBlame = {
  set(blame: BlameGutter | null): void;
  setHover(line: number, markdown: string): void;
  dispose(): void;
};

export function attachBlame(
  editor: monaco.editor.IStandaloneCodeEditor,
  events: BlameGutterEvents | undefined
): EditorBlame {
  registerLinks();
  const ownLinks = (link: BlameLink, arg: unknown) => events?.link({ link, arg });
  linkTarget = ownLinks;
  let shown: BlameGutter | null = null;
  /** Each line's decoration, by its 0-based line. */
  let ids: string[] = [];
  let width = 0;
  /** The annotation the pointer is on: its 0-based line, or null. */
  let pointedAt: number | null = null;

  /** Line `line`'s decoration: its annotation, and `hover`. */
  function decoration(
    line: number,
    hover: monaco.IMarkdownString
  ): monaco.editor.IModelDeltaDecoration {
    const lines = shown!.lines;
    const commit = shown!.commits[lines[line]];
    const first = line === 0 || lines[line - 1] !== lines[line];
    return {
      range: new monaco.Range(line + 1, 1, line + 1, 1),
      options: {
        // An empty range, drawn all the same: Monaco leaves out an empty
        // decoration, its injected text with it, unless told to show it.
        showIfCollapsed: true,
        before: {
          content: (first ? fit(commit.text, width) : " ".repeat(width)) + GAP,
          inlineClassName: BLAME_ANNOTATION_CLASS,
          cursorStops: monaco.editor.InjectedTextCursorStops.None
        },
        hoverMessage: hover
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

  const listeners = [
    editor.onMouseMove((e) => {
      const line = annotationAt(e.target);
      pointedAt = line;
      if (line !== null) events?.hover(line);
    }),
    editor.onMouseLeave(() => {
      pointedAt = null;
    }),
    editor.onMouseDown((e) => {
      if (!e.event.leftButton) return;
      const line = annotationAt(e.target);
      if (line !== null) events?.click(line);
    })
  ];

  return {
    set(blame) {
      shown = blame;
      const model = editor.getModel();
      const count =
        blame === null || model === null ? 0 : Math.min(blame.lines.length, model.getLineCount());
      width = Math.min(
        ANNOTATION_COLUMNS,
        Math.max(0, ...(blame?.commits.map((c) => widthOf(c.text)) ?? []))
      );
      const next: monaco.editor.IModelDeltaDecoration[] = [];
      for (let line = 0; line < count; line++) {
        const commit = blame!.commits[blame!.lines[line]];
        next.push(decoration(line, { value: markdownText(commit.text) }));
      }
      ids = editor.deltaDecorations(ids, next);
    },
    setHover(line, markdown) {
      if (shown === null || line >= ids.length) return;
      const hover: monaco.IMarkdownString = {
        value: markdown,
        supportThemeIcons: true,
        // The hover's own links, and nothing else, may run a command.
        isTrusted: { enabledCommands: Object.values(BLAME_LINKS) }
      };
      [ids[line]] = editor.deltaDecorations([ids[line]], [decoration(line, hover)]);
      // Monaco 0.57's content hover listens to no change of decorations
      // (contentHoverController.js hooks the model, its content and the
      // mouse): a hover already shown is computed again only if something
      // else — a later mouse move — happens to restart it, so the pointer
      // resting on the annotation could keep seeing what it said before. So
      // it is shown anew, at once, from the decoration as it is now.
      if (pointedAt === line) {
        const controller = contentHover(editor);
        controller?.hideContentHover();
        controller?.showContentHover(
          new monaco.Range(line + 1, 1, line + 1, 1),
          IMMEDIATE,
          MOUSE,
          false
        );
      }
    },
    dispose() {
      for (const listener of listeners) listener.dispose();
      if (linkTarget === ownLinks) linkTarget = null;
    }
  };
}
