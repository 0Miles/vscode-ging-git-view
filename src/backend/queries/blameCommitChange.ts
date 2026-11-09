import { type GitRunOptions, runWithin } from "@/backend/gitRun";

import { BLAME_TIMEOUT_MS, type BlameLine } from "./blameFile";
import { unquoteGitPath } from "./diffFileChanges";

/** One `@@` hunk of a unified diff, as the new side numbers its lines. */
export type DiffHunk = {
  /** The 1-based line of the new side the hunk starts at. */
  newStart: number;
  /** How many lines of the new side the hunk spans. */
  newCount: number;
  /** The hunk's lines, each with its ` `, `+` or `-` prefix and no line ending,
   *  cut to `HUNK_LINE_MAX` characters. */
  lines: string[];
};

/** A hunk's lines, and the index among them of the one line it is shown for. */
export type HunkExcerpt = { lines: string[]; index: number };

/** What a blamed line's commit did: its full message, and the hunks of its
 *  change to the line's file. */
export type CommitChange = { message: string; hunks: DiffHunk[] };

/** Which change of which commit: a blamed line's commit, the file's path
 *  there, and what the commit is compared with. */
export type BlamedCommit = Pick<BlameLine, "sha" | "filename" | "previous">;

export type BlameCommitChangeOptions = GitRunOptions & BlamedCommit;

/** A diff line longer than this — a minified or generated file's, say — is cut,
 *  the "…" marking the cut included, so no more than this is ever kept. */
export const HUNK_LINE_MAX = 200;

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
/** The prefix the patch is asked to give the new side's paths. */
const NEW_PREFIX = "b/";

/**
 * The hunks of a unified diff that change `filename` — the file whose new-side
 * path (`+++ b/<filename>`) it is; any other file's in the same patch are
 * skipped. Each hunk's header says how many lines it spans on either side, so
 * its end is counted rather than guessed; git's `\ No newline at end of file`
 * marker is left out, as it is no line of the file.
 */
export function parseHunks(patch: string, filename: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
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
      open.hunk.lines.push(cutLine(line === "" ? " " : line));
      continue;
    }
    if (line.startsWith("diff ")) inFile = false;
    else if (line.startsWith("+++ ")) inFile = patchPath(line.slice(4)) === NEW_PREFIX + filename;
    if (!inFile) continue;
    const header = HUNK_HEADER.exec(line);
    if (header === null) continue;
    const newCount = header[3] === undefined ? 1 : Number(header[3]);
    const hunk = { newStart: Number(header[2]), newCount, lines: [] };
    hunks.push(hunk);
    open = { hunk, oldLeft: header[1] === undefined ? 1 : Number(header[1]), newLeft: newCount };
  }
  return hunks;
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
 * its `lines` of that line; null when no hunk does — the change didn't touch
 * it.
 */
export function hunkAt(hunks: DiffHunk[], line: number): HunkExcerpt | null {
  const hunk = hunks.find((h) => h.newStart <= line && line < h.newStart + h.newCount);
  if (hunk === undefined) return null;
  let at = hunk.newStart;
  for (const [index, text] of hunk.lines.entries()) {
    if (text.startsWith("-")) continue;
    if (at === line) return { lines: hunk.lines, index };
    at++;
  }
  return null;
}

/**
 * What the blamed line's commit did: its full message (the blame gives only
 * the summary), and its change to the file — against the line's `previous`,
 * under the file's name there, so a rename shows as the edit it was; or, with
 * no `previous`, the file as the commit added it (against its first parent, for
 * a merge). Only the parsed, cut hunks are kept, never the patch. Resolves
 * null — never rejects — when git fails, the deadline (by default
 * `BLAME_TIMEOUT_MS` from the call) passes, or `signal` aborts.
 */
export async function blameCommitChange(
  options: BlameCommitChangeOptions
): Promise<CommitChange | null> {
  const deadline = options.deadline ?? Date.now() + BLAME_TIMEOUT_MS;
  const { sha, filename, previous } = options;
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
  const patchArgs =
    previous === null
      ? // A merge's own diff would be combined (`@@@`): take it against its
        // first parent instead, as an ordinary patch.
        [
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
        ]
      : [
          ...quoting,
          "diff",
          ...patchOptions,
          previous.sha,
          sha,
          "--",
          ...new Set([previous.filename, filename])
        ];
  const [shown, patched] = await Promise.all([
    runWithin(options, deadline, ["show", "-s", "--no-show-signature", "--format=%B", sha]),
    runWithin(options, deadline, patchArgs)
  ]);
  if (shown?.kind !== "ok" || shown.exitCode !== 0) return null;
  if (patched?.kind !== "ok" || patched.exitCode !== 0) return null;
  return {
    message: shown.stdout.toString().replace(/\s+$/, ""),
    hunks: parseHunks(patched.stdout.toString(), filename)
  };
}
