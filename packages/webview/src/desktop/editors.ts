/* The editors the desktop entry is handed (#404). The webview never imports
 * Monaco, nor lists it as a dependency: it only says here what it needs of an
 * editor, and `apps/desktop`, where Monaco is, makes them and hands them in
 * through `startDesktopEntry` (ADR-0031). The VS Code entry imports none of
 * this: VS Code opens its own editors.
 *
 * Today the one caller is the diff viewer (diff/diffPanel.ts), so a diff
 * viewer is all the factory makes. A file read-only at a revision (#405) adds
 * its own maker beside it, when it has a caller (ADR-0027). Hunk staging
 * (#406) is a choice the viewer offers on each hunk it is given. */

import type { FileHunk } from "@ging/shared/backend/types";

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

export interface EditorFactory {
  /** A diff viewer filling `container`, and keeping to its size as that
   *  changes. Rejects when there is no editor to make one with — its code
   *  could not be loaded. */
  createDiffViewer(container: HTMLElement, options: DiffViewerOptions): Promise<DiffViewer>;
}
