/* What the desktop host and a Tab's page say to each other about the blame of
 * the file shown read-only (#409). The host offers it with the file
 * (`ShowFileMessage.blame`), naming the file by a number of its own; the page
 * asks for it by that number, and for a line's hover, and runs the hover's
 * links through it. Nothing the page sends names a revision or a path: the
 * host blames only the file it offered. Desktop-only, so declared under
 * desktop/ and never part of the graph's protocol (ADR-0031). */

import type { RequestMessage, ResponseMessage } from "@ging/shared/types";
import type { BlameGutter } from "@ging/webview/desktop/editors";
import { isRecord, type NoCommandShared } from "@ging/webview/desktop/protocolGuards";

/** The commands a blamed line's hover links to, as the host writes them into
 *  its Markdown (`command:<id>?<args>`) and the viewer runs them. */
export const BLAME_LINKS = {
  copySha: "ging.blame.copySha",
  openLineChange: "ging.blame.openLineChange",
  locateCommit: "ging.blame.locateCommit"
} as const;
export type BlameLink = keyof typeof BLAME_LINKS;

/** The blame view's own words, in the host's language. */
export type FileBlameStrings = {
  /** The toggle's word: Blame. */
  toggle: string;
  /** Said while git blames the file. */
  blaming: string;
  /** Said when it could not. */
  failed: string;
  /** The file viewer's action that finds the cursor line's commit in the
   *  graph. */
  findInGraph: string;
};

/** The file shown can be blamed: by asking for `file`. */
export type FileBlameOffer = {
  file: number;
  /** Show it at once, whatever the toggle was left at: the file was opened
   *  to be blamed (the application menu's Blame File…). */
  show: boolean;
  strings: FileBlameStrings;
};

/** A file's blame as the host sends it: the gutter, each commit by its full
 *  hash, in the repository it was blamed in. */
export type FileBlame = BlameGutter & {
  repo: string;
  commits: (BlameGutter["commits"][number] & { sha: string })[];
};

/** Host → page: the blame of `file`, or none when it could not be blamed
 *  (the offer's `failed` says so then). */
export type FileBlameMessage = { command: "fileBlame"; file: number; blame: FileBlame | null };

/** Host → page: line `line`'s hover (0-based), as Markdown; null when it was
 *  not written — another line's was asked for meanwhile, which stopped its
 *  lookup — so it is asked again next time. */
export type FileBlameHoverMessage = {
  command: "fileBlameHover";
  file: number;
  line: number;
  markdown: string | null;
};

/** Host → page: something to say for a moment beside the toggle — a hash
 *  copied. */
export type FileBlameSaidMessage = { command: "fileBlameSaid"; file: number; text: string };

export type FileBlameHostMessage = FileBlameMessage | FileBlameHoverMessage | FileBlameSaidMessage;

/** Page → host: blame `file`. */
export type FileBlameOpenRequest = { command: "fileBlameOpen"; file: number };
/** Page → host: `file`'s blame is not shown any more; stop git. */
export type FileBlameCloseRequest = { command: "fileBlameClose"; file: number };
/** Page → host: line `line`'s hover, in full. */
export type FileBlameHoverRequest = { command: "fileBlameHoverOf"; file: number; line: number };
/** Page → host: run a hover's link, or a click on an annotation (as the
 *  hover's `locateCommit`). */
export type FileBlameRunRequest = {
  command: "fileBlameRun";
  file: number;
  link: BlameLink;
  arg: unknown;
};

export type FileBlameRequest =
  | FileBlameOpenRequest
  | FileBlameCloseRequest
  | FileBlameHoverRequest
  | FileBlameRunRequest;

/** Checked by the compiler: these share the page's `message` event and the
 *  host's channel with the graph's, and one named like the graph's would be
 *  taken for it (ADR-0031). */
export const FILE_BLAME_COMMANDS_STAY_APART: [
  NoCommandShared<FileBlameHostMessage["command"], ResponseMessage["command"]>,
  NoCommandShared<FileBlameRequest["command"], RequestMessage["command"]>
] = [true, true];

const isIndex = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const LINKS: ReadonlySet<unknown> = new Set(Object.keys(BLAME_LINKS));

function isBlame(value: unknown): value is FileBlame | null {
  if (value === null) return true;
  return (
    isRecord(value) &&
    typeof value.repo === "string" &&
    Array.isArray(value.commits) &&
    value.commits.every(
      (c: unknown) =>
        isRecord(c) &&
        typeof c.sha === "string" &&
        typeof c.text === "string" &&
        typeof c.uncommitted === "boolean"
    ) &&
    Array.isArray(value.lines) &&
    value.lines.every((i: unknown) => isIndex(i) && i < (value.commits as unknown[]).length)
  );
}

/** Whether `data`, heard on the page's `message` channel, is the host's to
 *  the blame view. */
export function isFileBlameHostMessage(data: unknown): data is FileBlameHostMessage {
  if (!isRecord(data) || !isIndex(data.file)) return false;
  switch (data.command) {
    case "fileBlame":
      return isBlame(data.blame);
    case "fileBlameHover":
      return isIndex(data.line) && (data.markdown === null || typeof data.markdown === "string");
    case "fileBlameSaid":
      return typeof data.text === "string";
    default:
      return false;
  }
}

/** Whether `message`, posted by a page, is the blame view's. */
export function isFileBlameRequest(message: unknown): message is FileBlameRequest {
  if (!isRecord(message) || !isIndex(message.file)) return false;
  switch (message.command) {
    case "fileBlameOpen":
    case "fileBlameClose":
      return true;
    case "fileBlameHoverOf":
      return isIndex(message.line);
    case "fileBlameRun":
      return LINKS.has(message.link);
    default:
      return false;
  }
}
