/* What the desktop host and a Tab's file history panel (#408) say to each
 * other. The panel is a desktop-only screen over the graph, in the same page,
 * so its messages share the page's `message` event and the host's channel
 * with the graph's, and stay out of `RequestMessage` / `ResponseMessage`
 * (ADR-0031). */

import type { FileHistoryEntry } from "@ging/shared/backend/types";
import type { RequestMessage, ResponseMessage } from "@ging/shared/types";

/** The panel's words, in the host's language: they come with every history
 *  and with the answer to `fileHistoryReady`, so the panel needs none of the
 *  graph's strings. `{0}` and `{1}` are filled in by the panel. */
export type FileHistoryStrings = {
  /** A CDV file's context menu item that opens its history. */
  menuItem: string;
  /** The panel's heading: `{0}` is the file's name. */
  title: string;
  /** Under it: `{0}` is the commit the history is read from. */
  upTo: string;
  close: string;
  loadMore: string;
  /** Said in place of the list when no commit changed the file. */
  empty: string;
  /** An entry's note, `{0}` the path it came from. */
  renamedFrom: string;
  copiedFrom: string;
  /** An entry whose path is not the history's: `{0}` is the path it had. */
  asPath: string;
  added: string;
  deleted: string;
  /** A merge's entry: the file it left is unlike every parent's. */
  merge: string;
  /** A submodule's entry: `{0}` and `{1}` are the commits its gitlink moved
   *  between, either `—` when there is none. Not opened as a diff. */
  submodule: string;
};

/** Host → page: a page of a file's history. The first (`offset` 0) opens the
 *  panel on it, in place of any shown; a later one adds to the history shown
 *  when it is the page that history asked for. */
export type FileHistoryMessage = {
  command: "fileHistory";
  path: string;
  /** The commit it is read from, in full; null for a repository with no
   *  commit yet. */
  start: string | null;
  offset: number;
  entries: FileHistoryEntry[];
  /** The `offset` of the page after this one; null when there is none. */
  next: number | null;
  error: string | null;
  strings: FileHistoryStrings;
};

/** Host → page: the panel's words, before any history: the CDV's menu item
 *  needs them. The answer to `fileHistoryReady`. */
export type FileHistoryStringsMessage = {
  command: "fileHistoryStrings";
  strings: FileHistoryStrings;
};

/** Host → page. */
export type FileHistoryHostMessage = FileHistoryMessage | FileHistoryStringsMessage;

/** Page → host: the page listens; the host answers with the strings. Sent
 *  on every load of the page. */
export type FileHistoryReadyRequest = { command: "fileHistoryReady" };

/** Page → host: a page of `path`'s history from commit `start` — HEAD when
 *  null — from `offset`. */
export type FileHistoryLoadRequest = {
  command: "fileHistoryLoad";
  path: string;
  start: string | null;
  offset: number;
};

/** Page → host: open the diff of one of the history's entries. */
export type FileHistoryDiffRequest = {
  command: "fileHistoryDiff";
  entry: Pick<FileHistoryEntry, "hash" | "change" | "path" | "oldPath" | "submodule">;
};

export type FileHistoryRequest =
  | FileHistoryReadyRequest
  | FileHistoryLoadRequest
  | FileHistoryDiffRequest;

/** True when `A` and `B` share no command name. */
type NoCommandShared<A extends string, B extends string> = [Extract<A, B>] extends [never]
  ? true
  : false;

/** Checked by the compiler: these share the page's `message` event and the
 *  host's channel with the graph's, and one named like the graph's would be
 *  taken for it (ADR-0031). */
export const FILE_HISTORY_COMMANDS_STAY_APART: [
  NoCommandShared<FileHistoryHostMessage["command"], ResponseMessage["command"]>,
  NoCommandShared<FileHistoryRequest["command"], RequestMessage["command"]>
] = [true, true];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const CHANGES: ReadonlySet<unknown> = new Set(["A", "M", "D", "R", "C"]);

/** Whether `value` is an entry as the host or the page names one. */
function isEntryRef(value: unknown): value is FileHistoryDiffRequest["entry"] {
  return (
    isRecord(value) &&
    typeof value.hash === "string" &&
    CHANGES.has(value.change) &&
    typeof value.path === "string" &&
    typeof value.oldPath === "string" &&
    (value.submodule === null || isRecord(value.submodule))
  );
}

/** Whether `data`, heard on the page's `message` channel, is the host's to
 *  the file history panel. */
export function isFileHistoryHostMessage(data: unknown): data is FileHistoryHostMessage {
  if (!isRecord(data) || !isRecord(data.strings)) return false;
  if (data.command === "fileHistoryStrings") return true;
  return (
    data.command === "fileHistory" &&
    typeof data.path === "string" &&
    (data.start === null || typeof data.start === "string") &&
    typeof data.offset === "number" &&
    Array.isArray(data.entries) &&
    data.entries.every(isEntryRef) &&
    (data.next === null || typeof data.next === "number") &&
    (data.error === null || typeof data.error === "string")
  );
}

/** Whether `message`, posted by a page, is the file history panel's. */
export function isFileHistoryRequest(message: unknown): message is FileHistoryRequest {
  if (!isRecord(message)) return false;
  switch (message.command) {
    case "fileHistoryReady":
      return true;
    case "fileHistoryLoad":
      return (
        typeof message.path === "string" &&
        (message.start === null || typeof message.start === "string") &&
        typeof message.offset === "number"
      );
    case "fileHistoryDiff":
      return isEntryRef(message.entry);
    default:
      return false;
  }
}
