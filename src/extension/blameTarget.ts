import { blameLocation } from "@/backend/utils/repoMatch";

/** The parts of an editor that decide whether, and where, it is annotated. */
export type BlameEditorState = {
  /** The document URI's scheme. */
  scheme: string;
  isDirty: boolean;
  /** The document's path, with "/" separators. */
  filePath: string;
  selections: { startLine: number; endLine: number }[];
  /** The primary cursor's line. */
  cursorLine: number;
};

export type BlameTarget = { line: number; repo: string; filePath: string };

/** True when any selection covers more than one line. */
export function spansLines(selections: { startLine: number; endLine: number }[]): boolean {
  return selections.some((s) => s.startLine !== s.endLine);
}

/**
 * The line to annotate and where to blame it, or null when the editor shows
 * nothing to annotate: not a file on disk, unsaved edits (they no longer line up
 * with what git blames on disk), a selection across lines, or a file outside
 * every known repository.
 */
export function blameTarget(editor: BlameEditorState, knownRepos: string[]): BlameTarget | null {
  if (editor.scheme !== "file" || editor.isDirty) return null;
  if (spansLines(editor.selections)) return null;
  const location = blameLocation(editor.filePath, knownRepos);
  return location === null ? null : { line: editor.cursorLine, ...location };
}
