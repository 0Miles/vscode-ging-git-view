/* The editors the desktop entry is handed (#404). The webview never imports
 * Monaco, nor lists it as a dependency: it only says here what it needs of an
 * editor, and `apps/desktop`, where Monaco is, makes them and hands them in
 * through `startDesktopEntry` (ADR-0031). The VS Code entry imports none of
 * this: VS Code opens its own editors.
 *
 * The one caller is the panel over the graph (diff/diffPanel.ts), which shows
 * a diff (#404) or one file read-only (#405), so the factory makes those two.
 * Hunk staging (#406) grows what a `DiffViewer` can do, blame (#409) what a
 * `FileViewer` can: annotations beside its lines, each with a hover. Each
 * when it has a caller (ADR-0027). */

import type { DiffDocument } from "./diff/protocol";

/** The page's theme, as `<body>`'s `vscode-dark` / `vscode-light` says. */
export type ThemeKind = "dark" | "light";

/** Two columns, before and after; or one, the lines removed above the lines
 *  that replace them. */
export type DiffLayout = "sideBySide" | "inline";

export type DiffViewerOptions = {
  original: DiffDocument;
  modified: DiffDocument;
  layout: DiffLayout;
  theme: ThemeKind;
  /** A 1-based line of `modified` to reveal and put the cursor on. */
  revealLine: number | null;
};

/** A read-only diff of two documents, drawn in the element it was made in. */
export interface DiffViewer {
  setLayout(layout: DiffLayout): void;
  /** The page's theme changed. Its colours are the `--vscode-*` variables on
   *  `<html>`, already changed by then. */
  setTheme(theme: ThemeKind): void;
  /** Give it the keyboard. */
  focus(): void;
  /** Take it out of the page; done with for good. */
  dispose(): void;
}

export type FileViewerOptions = {
  /** The file: its path, `/`-separated, tells the editor what language to
   *  colour it as. */
  document: DiffDocument;
  theme: ThemeKind;
  /** What the user does with its blame's annotations, once it shows them
   *  (`setBlame`, #409). */
  blame?: BlameGutterEvents;
};

/** A file's blame as a viewer draws it beside the lines (#409): the words of
 *  each commit's annotation, and each line's commit. */
export type BlameGutter = {
  /** Each commit's annotation, as the host wrote it. */
  commits: { text: string; uncommitted: boolean }[];
  /** Each line of the file, in order: its commit's index in `commits`. */
  lines: number[];
};

/** A hover link of a blamed line: which one (`BLAME_LINKS`), and the argument
 *  its Markdown gave it. */
export type BlameLinkClick = { link: BlameLink; arg: unknown };

export type BlameGutterEvents = {
  /** The pointer is on line `line`'s annotation (0-based): its hover is
   *  wanted, in full (`setBlameHover`). */
  hover(line: number): void;
  /** Line `line`'s annotation was clicked. */
  click(line: number): void;
  /** A link in a hover was clicked. */
  link(click: BlameLinkClick): void;
};

/** The commands a blamed line's hover links to, as the host writes them into
 *  its Markdown (`command:<id>?<args>`) and the viewer runs them. */
export const BLAME_LINKS = {
  copySha: "ging.blame.copySha",
  openLineChange: "ging.blame.openLineChange",
  locateCommit: "ging.blame.locateCommit"
} as const;
export type BlameLink = keyof typeof BLAME_LINKS;

/** The class of the text a viewer draws a line's annotation in, for the
 *  panel's styles (diffPanelStyles.ts). */
export const BLAME_ANNOTATION_CLASS = "gingBlameAnnotation";

/** One file, read-only, drawn in the element it was made in. */
export interface FileViewer {
  /** Draw `blame` beside the lines, in place of any drawn; none for null. */
  setBlame(blame: BlameGutter | null): void;
  /** Line `line`'s hover (0-based), as Markdown with codicons and the
   *  `BLAME_LINKS` commands. */
  setBlameHover(line: number, markdown: string): void;
  /** As `DiffViewer.setTheme`. */
  setTheme(theme: ThemeKind): void;
  /** Give it the keyboard. */
  focus(): void;
  /** Take it out of the page; done with for good. */
  dispose(): void;
}

export interface EditorFactory {
  /** A diff viewer filling `container`, and keeping to its size as that
   *  changes. Rejects when there is no editor to make one with — its code
   *  could not be loaded. */
  createDiffViewer(container: HTMLElement, options: DiffViewerOptions): Promise<DiffViewer>;
  /** A read-only view of one file filling `container`, as `createDiffViewer`
   *  makes a diff's. */
  createFileViewer(container: HTMLElement, options: FileViewerOptions): Promise<FileViewer>;
}
