import { type GitRunOptions, runWithin } from "@ging/core/backend/gitRun";

import { BLAME_TIMEOUT_MS, type BlameLine } from "./blameFile";
import { unquoteGitPath } from "./diffFileChanges";

/** One `@@` hunk of a unified diff, as the new side numbers its lines. */
export type DiffHunk = {
  /** The 1-based line of the new side the hunk starts at. */
  newStart: number;
  /** How many lines of the new side the hunk spans. */
  newCount: number;
  /** The hunk's lines, each with its ` `, `+` or `-` prefix and no line ending,
   *  cut to `HUNK_LINE_MAX` characters; null when there were too many to keep
   *  (see `parseHunks`). */
  lines: string[] | null;
};

/** The hunks of a change to one file; `complete` is false when there were too
 *  many to record them all, and the ones past the last of `hunks` are missing. */
export type FileHunks = { hunks: DiffHunk[]; complete: boolean };

/** A hunk's lines, and the index among them of the one line it is shown for. */
export type HunkExcerpt = { lines: string[]; index: number };

/** What a blamed line's commit did: its message, and the hunks of its change
 *  to the line's file. */
export type CommitChange = { message: string } & FileHunks;

/** Which change of which commit: a blamed line's commit, the file's path
 *  there, and what the commit is compared with. */
export type BlamedCommit = Pick<BlameLine, "sha" | "filename" | "previous">;

export type BlameCommitChangeOptions = GitRunOptions & BlamedCommit;

/** A diff line longer than this — a minified or generated file's, say — is cut,
 *  the "…" marking the cut included, so no more than this is ever kept. */
export const HUNK_LINE_MAX = 200;
/**
 * How much of a change is kept: its hunks' lines, plus one for each hunk
 * recorded. With `HUNK_LINE_MAX` and `MESSAGE_MAX` it bounds what one change
 * holds — some 400,000 characters — however big the commit (a lockfile's, say).
 */
export const CHANGE_MAX_LINES = 2000;
/** A longer commit message is cut, the "…" marking the cut included. */
export const MESSAGE_MAX = 10_000;
/** The lines of a hunk shown for one of its lines, any "…" among them. */
export const EXCERPT_MAX_LINES = 10;
/** How many of an excerpt's lines come before the blamed line, room allowing. */
const EXCERPT_LINES_BEFORE = 4;

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
/** The prefix the patch is asked to give the new side's paths. */
const NEW_PREFIX = "b/";

/**
 * The hunks of a unified diff that change `filename` — the file whose new-side
 * path (`+++ b/<filename>`) it is; any other file's in the same patch are
 * skipped. Each hunk's header says how many lines it spans on either side, so
 * its end is counted rather than guessed; git's `\ No newline at end of file`
 * marker is left out, as it is no line of the file.
 *
 * At most `maxLines` are kept, each hunk recorded counting as one: a hunk
 * whose lines don't fit keeps only its place (`lines` null), and once not even
 * a hunk's place fits, no more are recorded (`complete` false).
 */
export function parseHunks(
  patch: string,
  filename: string,
  maxLines: number = CHANGE_MAX_LINES
): FileHunks {
  const hunks: DiffHunk[] = [];
  // How much is kept so far: lines, and one for each hunk.
  const kept = { lines: 0 };
  let inFile = false;
  // The hunk being read, and how many lines of either side it has still to go.
  let open: { hunk: DiffHunk; oldLeft: number; newLeft: number } | undefined;
  for (const raw of patch.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (open !== undefined && (open.oldLeft > 0 || open.newLeft > 0)) {
      if (line.startsWith("\\")) continue;
      if (line.startsWith("+")) open.newLeft--;
      else if (line.startsWith("-")) open.oldLeft--;
      else {
        // Context, or an empty line git printed for an empty context line
        // (`diff.suppressBlankEmpty`).
        open.oldLeft--;
        open.newLeft--;
      }
      const { hunk } = open;
      if (hunk.lines === null) continue;
      if (kept.lines < maxLines) {
        hunk.lines.push(cutLine(line === "" ? " " : line));
        kept.lines++;
      } else {
        // Too many: the hunk keeps its place alone.
        kept.lines -= hunk.lines.length;
        hunk.lines = null;
      }
      continue;
    }
    if (line.startsWith("diff ")) inFile = false;
    else if (line.startsWith("+++ ")) inFile = patchPath(line.slice(4)) === NEW_PREFIX + filename;
    if (!inFile) continue;
    const header = HUNK_HEADER.exec(line);
    if (header === null) continue;
    if (kept.lines >= maxLines) return { hunks, complete: false };
    const newCount = header[3] === undefined ? 1 : Number(header[3]);
    const hunk: DiffHunk = { newStart: Number(header[2]), newCount, lines: [] };
    hunks.push(hunk);
    kept.lines++;
    open = { hunk, oldLeft: header[1] === undefined ? 1 : Number(header[1]), newLeft: newCount };
  }
  return { hunks, complete: true };
}

/** `line` cut to `HUNK_LINE_MAX` characters, "…" last, if longer; never in
 *  the middle of a surrogate pair. */
function cutLine(line: string): string {
  if (line.length <= HUNK_LINE_MAX) return line;
  let end = HUNK_LINE_MAX - 1;
  const last = line.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return line.slice(0, end) + "…";
}

/** A path as a patch header writes it, maybe quoted (see `unquoteGitPath`),
 *  and maybe followed by a tab (git adds one after a path with a space). */
function patchPath(text: string): string {
  return unquoteGitPath(text.split("\t")[0]);
}

/**
 * The hunk that holds the new side's 1-based line `line`, with the index in
 * its `lines` of that line; "left out" when that hunk's lines (or the hunk
 * itself) were too many to keep — `blameLineExcerpt` looks it up alone — and
 * null when no hunk does: the change didn't touch the line.
 */
export function hunkAt(change: FileHunks, line: number): HunkExcerpt | "left out" | null {
  const hunk = change.hunks.find((h) => h.newStart <= line && line < h.newStart + h.newCount);
  if (hunk === undefined) {
    // Hunks come in order: only a line past the last one recorded can be in
    // one that wasn't.
    const last = change.hunks.at(-1);
    const pastRecorded = last === undefined || line >= last.newStart + last.newCount;
    return !change.complete && pastRecorded ? "left out" : null;
  }
  if (hunk.lines === null) return "left out";
  let at = hunk.newStart;
  for (const [index, text] of hunk.lines.entries()) {
    if (text.startsWith("-")) continue;
    if (at === line) return { lines: hunk.lines, index };
    at++;
  }
  return null;
}

/**
 * At most `EXCERPT_MAX_LINES` lines of a hunk, the blamed line among them,
 * with a "…" — one of those lines — at each end where lines were left out. A
 * "…" never stands for a single line: that line is shown in its place.
 */
export function hunkWindow({ lines, index }: HunkExcerpt): HunkExcerpt {
  if (lines.length <= EXCERPT_MAX_LINES) return { lines, index };
  const oneCut = EXCERPT_MAX_LINES - 1;
  let start: number;
  let end: number;
  if (index - EXCERPT_LINES_BEFORE <= 0) {
    // The window reaches the top: the "…" goes at the bottom only.
    [start, end] = [0, oneCut];
  } else if (index - EXCERPT_LINES_BEFORE + oneCut >= lines.length) {
    [start, end] = [lines.length - oneCut, lines.length];
  } else {
    start = index - EXCERPT_LINES_BEFORE;
    end = start + EXCERPT_MAX_LINES - 2;
    // A "…" for one line would hide it for nothing: show the line.
    if (start === 1) start = 0;
  }
  return {
    lines: [
      ...(start > 0 ? ["…"] : []),
      ...lines.slice(start, end),
      ...(end < lines.length ? ["…"] : [])
    ],
    index: index - start + (start > 0 ? 1 : 0)
  };
}

/**
 * What the blamed line's commit did: its full message (the blame gives only
 * the summary; one past `MESSAGE_MAX` is cut), and its change to the file —
 * against the line's `previous`, under the file's name there, so a rename
 * shows as the edit it was; or, with no `previous`, the file as the commit
 * added it (against its first parent, for a merge). Only the parsed hunks are
 * kept, within `CHANGE_MAX_LINES`, never the patch. Resolves null — never
 * rejects — when git fails, the deadline (by default `BLAME_TIMEOUT_MS` from
 * the call) passes, or `signal` aborts.
 */
export async function blameCommitChange(
  options: BlameCommitChangeOptions
): Promise<CommitChange | null> {
  const deadline = options.deadline ?? Date.now() + BLAME_TIMEOUT_MS;
  const [shown, patched] = await Promise.all([
    runWithin(options, deadline, ["show", "-s", "--no-show-signature", "--format=%B", options.sha]),
    runWithin(options, deadline, patchArgs(options))
  ]);
  if (shown?.kind !== "ok" || shown.exitCode !== 0) return null;
  if (patched?.kind !== "ok" || patched.exitCode !== 0) return null;
  const message = shown.stdout.toString().replace(/\s+$/, "");
  return {
    message: message.length > MESSAGE_MAX ? message.slice(0, MESSAGE_MAX - 1) + "…" : message,
    ...parseHunks(patched.stdout.toString(), options.filename)
  };
}

/**
 * The excerpt (see `hunkWindow`) of the blamed line's hunk, for one line that
 * `hunkAt` found "left out": the hunk is read whole for the moment, but only
 * the excerpt is kept. Null when the change didn't touch the line; and — never
 * rejecting — when git fails, the deadline passes, or `signal` aborts.
 */
export async function blameLineExcerpt(
  options: BlameCommitChangeOptions & { line: number }
): Promise<HunkExcerpt | null> {
  const deadline = options.deadline ?? Date.now() + BLAME_TIMEOUT_MS;
  const patched = await runWithin(options, deadline, patchArgs(options));
  if (patched?.kind !== "ok" || patched.exitCode !== 0) return null;
  const all = parseHunks(patched.stdout.toString(), options.filename, Infinity);
  const excerpt = hunkAt(all, options.line);
  return excerpt === null || excerpt === "left out" ? null : hunkWindow(excerpt);
}

/** The git args for the patch of a blamed line's commit to its file: against
 *  the line's `previous`; with none, against nothing — or, for a merge, its
 *  first parent. */
function patchArgs({ sha, filename, previous }: BlamedCommit): string[] {
  const patchOptions = [
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "-M",
    "-U3",
    // Whatever `diff.noprefix` or `diff.mnemonicPrefix` say, as `parseHunks`
    // finds the file by its `b/` path.
    "--src-prefix=a/",
    `--dst-prefix=${NEW_PREFIX}`
  ];
  // Non-ASCII paths in the patch headers as UTF-8, not octal escapes.
  const quoting = ["-c", "core.quotePath=false"];
  if (previous === null) {
    // A merge's own diff would be combined (`@@@`): take it against its first
    // parent instead, as an ordinary patch.
    return [
      ...quoting,
      "show",
      "--format=",
      "--root",
      "-m",
      "--first-parent",
      ...patchOptions,
      sha,
      "--",
      filename
    ];
  }
  const paths = [...new Set([previous.filename, filename])];
  return [...quoting, "diff", ...patchOptions, previous.sha, sha, "--", ...paths];
}
