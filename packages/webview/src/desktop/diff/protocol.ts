/* What the desktop host sends a Tab's page to show a diff (#404): the two
 * sides' text, read by the main process, and the words the diff viewer's own
 * controls carry. Desktop-only, so declared under desktop/ and never part of
 * `ResponseMessage` (ADR-0031). The page answers nothing: once the diff is
 * in the page, it is the page's to show and to close. */

import type { ResponseMessage } from "@ging/shared/types";

/** One side of a diff: a file's text, decoded by the host. */
export type DiffDocument = {
  /** The file's path in its repository, `/`-separated: its name tells the
   *  editor what language to colour it as. */
  path: string;
  content: string;
};

/** The diff viewer's own words, in the host's language: they come with each
 *  diff, so the viewer needs no strings of the page's (`webviewL10n`). */
export type DiffViewerStrings = {
  sideBySide: string;
  inline: string;
  close: string;
  /** Said in the viewer when the editor could not be loaded. */
  cannotShow: string;
};

/** Host → page: show this diff over the graph, in place of any shown. */
export type ShowDiffMessage = {
  command: "showDiff";
  /** What the diff is of, as VS Code titles its diff editor:
   *  `file.txt (abc1234^ ↔ abc1234)`. */
  title: string;
  /** The left side: before. */
  original: DiffDocument;
  /** The right side: after. */
  modified: DiffDocument;
  /** A 1-based line of the right side to reveal and put the cursor on; null
   *  for none. */
  revealLine: number | null;
  /** Why there is no text to compare — a binary file, or one too large to
   *  send — in one line the viewer shows in place of an editor; null when
   *  there is text. The documents are then empty. */
  notShown: string | null;
  strings: DiffViewerStrings;
};

/** True when `A` and `B` share no command name. */
type NoCommandShared<A extends string, B extends string> = [Extract<A, B>] extends [never]
  ? true
  : false;

/** Checked by the compiler: a diff shares the page's `message` event with the
 *  graph's answers, and one named like them would be taken for one
 *  (ADR-0031). */
export const DIFF_COMMANDS_STAY_APART: NoCommandShared<
  ShowDiffMessage["command"],
  ResponseMessage["command"]
> = true;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDiffDocument(value: unknown): value is DiffDocument {
  return isRecord(value) && typeof value.path === "string" && typeof value.content === "string";
}

/** Whether `data`, heard on the page's `message` channel, is a diff to show. */
export function isShowDiffMessage(data: unknown): data is ShowDiffMessage {
  return (
    isRecord(data) &&
    data.command === "showDiff" &&
    typeof data.title === "string" &&
    isDiffDocument(data.original) &&
    isDiffDocument(data.modified) &&
    (data.revealLine === null || typeof data.revealLine === "number") &&
    (data.notShown === null || typeof data.notShown === "string") &&
    isRecord(data.strings)
  );
}
