/* The editors the desktop entry is handed (#404). The webview never imports
 * Monaco, nor lists it as a dependency: it only says here what it needs of an
 * editor, and `apps/desktop`, where Monaco is, makes them and hands them in
 * through `startDesktopEntry` (ADR-0031). The VS Code entry imports none of
 * this: VS Code opens its own editors.
 *
 * The one caller is the panel over the graph (diff/diffPanel.ts), which shows
 * a diff (#404) or one file read-only (#405), so the factory makes those two.
 * Hunk staging (#406) is a choice a `DiffViewer` offers on each hunk it is
 * given; blame (#409) grows what a `FileViewer` can: annotations beside its
 * lines, each with a hover. Each when it has a caller (ADR-0027). */

import type { FileHunk } from "@ging/shared/backend/types";

import type { BlameLink } from "./diff/blameProtocol";
import type { DiffDocument } from "./diff/protocol";

/** Hunks of the diff for the user to act on one at a time (#406): a control
 *  at each, `label` its word, `choose` called with the hunk's index. */
export type HunkActions = {
  label: string;
  hunks: FileHunk[];
  /** Each hunk's control's name for assistive technology, in `hunks`'
   *  order: its word and its lines. */
  names: string[];
  /** How the keyboard reaches the action — the controls sit outside the
   *  editor's own keyboard order — said as the editors' accessible name. */
  keyboard: string;
  choose(index: number): void;
};

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
  /** Hunks to offer an action on, each above its first line in `modified`;
   *  none offered when absent. */
  hunks?: HunkActions;
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
  /** Its blame, once it shows it (`setBlame`, #409): what the user does with
   *  the annotations, and the words of the viewer's own action. Absent for a
   *  file that cannot be blamed. */
  blame?: FileViewerBlame;
};

export type FileViewerBlame = {
  events: BlameGutterEvents;
  /** The editor's action, in its context menu, that finds the commit of the
   *  cursor's line in the graph — the keyboard's way to what a click on the
   *  annotation does. */
  findInGraph: string;
};

/** A file's blame as a viewer draws it beside the lines (#409): the words of
 *  each commit's annotation, and each line's commit. */
export type BlameGutter = {
  /** Each commit's annotation, as the host wrote it. */
  commits: { text: string; uncommitted: boolean }[];
  /** Each line of the file, in order: its commit's index in `commits`. */
  lines: number[];
};

/** A hover link of a blamed line: which one (`BLAME_LINKS`, blameProtocol.ts),
 *  and the argument its Markdown gave it. */
export type BlameLinkClick = { link: BlameLink; arg: unknown };

export type BlameGutterEvents = {
  /** Line `line`'s hover (0-based), in full, as Markdown with codicons and
   *  the `BLAME_LINKS` commands — asked when the pointer is on its annotation,
   *  or the keyboard asks for the hover of the cursor's line. Null when there
   *  is none to show: the blame is gone, or the host did not write it. */
  hover(line: number): Promise<string | null>;
  /** Line `line`'s annotation was clicked, or the editor's Find in Graph
   *  run on it. */
  click(line: number): void;
  /** A link in a hover was clicked. */
  link(click: BlameLinkClick): void;
};

/** The class of the text a viewer draws a line's annotation in, for the
 *  panel's styles (diffPanelStyles.ts). */
export const BLAME_ANNOTATION_CLASS = "gingBlameAnnotation";

/** One file, read-only, drawn in the element it was made in. */
export interface FileViewer {
  /** Draw `blame` beside the lines, in place of any drawn; none for null. */
  setBlame(blame: BlameGutter | null): void;
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
