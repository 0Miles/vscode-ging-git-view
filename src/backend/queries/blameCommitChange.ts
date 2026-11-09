import { type GitRunOptions, runWithin } from "@/backend/gitRun";

import { BLAME_TIMEOUT_MS, type BlameLine } from "./blameFile";

/** One `@@` hunk of a unified diff, as the new side numbers its lines. */
export type DiffHunk = {
  /** The 1-based line of the new side the hunk starts at. */
  newStart: number;
  /** How many lines of the new side the hunk spans. */
  newCount: number;
  /** The hunk's lines, each with its ` `, `+` or `-` prefix and no line ending. */
  lines: string[];
};

/** A hunk's lines, and the index among them of the one line it is shown for. */
export type HunkExcerpt = { lines: string[]; index: number };

/** What a blamed line's commit did: its full message, and the hunks of its
 *  change to the line's file. */
export type CommitChange = { message: string; hunks: DiffHunk[] };

export type BlameCommitChangeOptions = GitRunOptions &
  Pick<BlameLine, "sha" | "filename" | "previous">;

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The hunks of a unified diff. Each hunk's header says how many lines it
 * spans on either side, so its end is counted rather than guessed; git's
 * `\ No newline at end of file` marker is left out, as it is no line of the
 * file.
 */
export function parseHunks(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
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
      open.hunk.lines.push(line === "" ? " " : line);
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header === null) continue;
    const newCount = header[3] === undefined ? 1 : Number(header[3]);
    const hunk = { newStart: Number(header[2]), newCount, lines: [] };
    hunks.push(hunk);
    open = { hunk, oldLeft: header[1] === undefined ? 1 : Number(header[1]), newLeft: newCount };
  }
  return hunks;
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
 * no `previous`, the file as the commit added it. Resolves null — never
 * rejects — when git fails or the deadline (by default `BLAME_TIMEOUT_MS` from
 * the call) passes.
 */
export async function blameCommitChange(
  options: BlameCommitChangeOptions
): Promise<CommitChange | null> {
  const deadline = options.deadline ?? Date.now() + BLAME_TIMEOUT_MS;
  const { sha, filename, previous } = options;
  const patchOptions = ["--no-color", "--no-ext-diff", "--no-textconv", "-M", "-U3"];
  const patchArgs =
    previous === null
      ? ["show", "--format=", "--root", ...patchOptions, sha, "--", filename]
      : [
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
    hunks: parseHunks(patched.stdout.toString())
  };
}
