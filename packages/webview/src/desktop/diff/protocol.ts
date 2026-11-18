/* What the desktop host sends a Tab's page to show a diff (#404), or one file
 * read-only (#405): the text, read by the main process, and the words the
 * viewer's own controls carry. Desktop-only, so declared under desktop/ and
 * never part of `ResponseMessage` (ADR-0031). Once the diff or the file is in
 * the page, it is the page's to show and to close; the one thing the page
 * asks of it is a hunk staged or unstaged (#406), for a diff of the working
 * tree that offers them. */

import type { FileHunk, HunkArea } from "@ging/shared/backend/types";
import type { RequestMessage, ResponseMessage } from "@ging/shared/types";

import type { FileBlameOffer } from "./blameProtocol";

/** One side of a diff, or the file shown: a file's text, decoded by the host. */
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

/** The hunks a diff of the working tree offers to stage or unstage one at a
 *  time (#406), and what the page names one by when it asks. */
export type DiffHunks = {
  /** The file, repository-relative. */
  path: string;
  /** Unstaged (index ↔ working tree): each hunk is staged; staged (HEAD ↔
   *  index): each is unstaged. */
  area: HunkArea;
  /** The very diff the hunks were cut from: the host applies one only while
   *  the file's diff is still it. */
  token: string;
  /** Each hunk's lines on both sides, in the order git wrote them. */
  hunks: FileHunk[];
  /** The hunk button's word: Stage Hunk, or Unstage Hunk. */
  label: string;
  /** A hunk's name for assistive technology: `{0}` the button's word, `{1}`
   *  and `{2}` the first and last of its lines. */
  name: string;
  /** How the keyboard reaches the hunks: the editor's context menu, said
   *  with the editor's own name. */
  keyboard: string;
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
  /** Hunks to stage or unstage one at a time (#406); absent for a diff that
   *  offers none — a commit's, or a change that is the whole file. */
  hunks?: DiffHunks;
  /** One line said over the diff: why it offers no hunk, or what became of
   *  the last one asked for. */
  said?: string;
  /** The diff shown anew after a hunk was asked for: the `asked` of that
   *  request. Shown only while the diff it was asked from still is — not
   *  over another diff opened, nor once the viewer was closed, meanwhile. */
  answers?: number;
};

/** Page → host: stage or unstage hunk `hunk` (from 0) of the diff `token`
 *  names (#406). The host answers by showing the file's diff anew. */
export type DiffHunkRequest = {
  command: "diffHunk";
  path: string;
  area: HunkArea;
  token: string;
  hunk: number;
  /** Which diff of the page's it was asked from, echoed in the answer
   *  (`ShowDiffMessage.answers`). */
  asked: number;
};

/** The file viewer's own words: it has no layouts to switch between. */
export type FileViewerStrings = {
  close: string;
  /** Said in the viewer when the editor could not be loaded. */
  cannotShow: string;
};

/** Host → page: show this file, read-only, over the graph, in place of any
 *  diff or file shown (#405). */
export type ShowFileMessage = {
  command: "showFile";
  /** What the file is, as a diff of it is titled: `file.txt (abc1234)`. */
  title: string;
  file: DiffDocument;
  /** Why there is no text to show — a binary file, or one too large to send —
   *  in one line the viewer shows in place of an editor; null when there is
   *  text. The document is then empty. */
  notShown: string | null;
  strings: FileViewerStrings;
  /** Its blame can be shown beside it (#409); absent when it cannot — no
   *  text, or the index's copy. */
  blame?: FileBlameOffer;
};

/** What the host sends the panel over the graph: a diff, or a file. */
export type ViewerMessage = ShowDiffMessage | ShowFileMessage;

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
> &
  NoCommandShared<DiffHunkRequest["command"], RequestMessage["command"]> = true;

/** As `DIFF_COMMANDS_STAY_APART`, for a file. */
export const FILE_COMMANDS_STAY_APART: NoCommandShared<
  ShowFileMessage["command"],
  ResponseMessage["command"]
> = true;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDiffDocument(value: unknown): value is DiffDocument {
  return isRecord(value) && typeof value.path === "string" && typeof value.content === "string";
}

const isArea = (value: unknown): value is HunkArea => value === "staged" || value === "unstaged";

const isSpan = (value: unknown) =>
  isRecord(value) && Number.isInteger(value.start) && Number.isInteger(value.count);

function isDiffHunks(value: unknown): value is DiffHunks {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    isArea(value.area) &&
    typeof value.token === "string" &&
    typeof value.label === "string" &&
    typeof value.name === "string" &&
    typeof value.keyboard === "string" &&
    Array.isArray(value.hunks) &&
    value.hunks.every((hunk) => isRecord(hunk) && isSpan(hunk.original) && isSpan(hunk.modified))
  );
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
    isRecord(data.strings) &&
    (data.hunks === undefined || isDiffHunks(data.hunks)) &&
    (data.said === undefined || typeof data.said === "string") &&
    (data.answers === undefined || Number.isInteger(data.answers))
  );
}

/** Whether `data`, posted by a Tab's page, is a hunk to stage or unstage. */
export function isDiffHunkRequest(data: unknown): data is DiffHunkRequest {
  return (
    isRecord(data) &&
    data.command === "diffHunk" &&
    typeof data.path === "string" &&
    isArea(data.area) &&
    typeof data.token === "string" &&
    Number.isInteger(data.hunk) &&
    (data.hunk as number) >= 0 &&
    Number.isInteger(data.asked)
  );
}

/** Whether `data`, heard on the page's `message` channel, is a file to show. */
export function isShowFileMessage(data: unknown): data is ShowFileMessage {
  return (
    isRecord(data) &&
    data.command === "showFile" &&
    typeof data.title === "string" &&
    isDiffDocument(data.file) &&
    (data.notShown === null || typeof data.notShown === "string") &&
    isRecord(data.strings) &&
    (data.blame === undefined ||
      (isRecord(data.blame) &&
        Number.isSafeInteger(data.blame.file) &&
        typeof data.blame.show === "boolean" &&
        isRecord(data.blame.strings)))
  );
}
