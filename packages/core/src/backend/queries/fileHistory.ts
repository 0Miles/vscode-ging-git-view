import type { SimpleGit } from "simple-git";

import type { FileHistoryChange, FileHistoryEntry } from "@ging/shared/backend/types";

export type { FileHistoryChange, FileHistoryEntry };

/* A file's history (#408): the commits that changed one path, read with
 * `git log --follow`, each with the path the file had at that commit — a
 * diff of a commit before a rename must read the old path, or it reads a
 * file that was not there.
 *
 * What `--follow` is, and so what this is:
 *
 * - **Renames and copies are followed backwards**, as git detects them for
 *   the one path it follows: past the commit that renamed (`R`) or copied
 *   (`C`) the file there, the history goes on under the name it came from.
 *   A copy's history therefore runs on into its source's; the source's own
 *   changes after the copy are not in it.
 * - **The path it follows is one for the whole walk, not one per line of
 *   history.** Once git meets the rename, it follows the old name on every
 *   branch it walks after that — a commit on another branch that still
 *   changed the file under its new name, but comes later in the walk, is not
 *   listed. git documents `--follow` as working "only for a single file", and
 *   this is that limit; GING does not try to work around it.
 * - **One path, never a pattern.** `--literal-pathspecs` and `--` make the
 *   path a literal file name whatever it holds (`*`, `[ab]`, a leading `:` or
 *   `-`); git refuses `--follow` with more than one.
 * - **Every line of history from the start commit, merges' too.** With
 *   `--follow` git prunes nothing while it walks, so there is no history
 *   simplification for `--full-history` to turn off, and no `--first-parent`:
 *   a change made on a branch that was merged is listed where it was made.
 *   A merge is listed only when the file it left differs from the file in
 *   every one of its parents (`--cc`) — a conflict resolution, or a change
 *   made in the merge itself — since no other commit holds that change.
 *
 * A merge whose file is one of its parents' is printed without a diff (its
 * combined diff of the path is empty); it is no entry, and dropped.
 *
 * `--skip` cannot page it: under `--follow` git counts every commit walked
 * against `--skip`, shown or not, while `--max-count` counts only those
 * shown (log.c gives back what it took for a commit it did not show). So a
 * page past the first reads the history again from the start, `offset` and
 * a page more, and drops what was already read.
 */

export type FileHistoryPage = {
  entries: FileHistoryEntry[];
  /** There are entries past these. */
  more: boolean;
};

// Collision-free separators, as loadReflog's: the record separator is three
// bytes no commit header field holds, and the fields are NUL-separated, as
// `-z` separates the raw diff that follows.
const RS = "\x01\x02\x03";
const RS_FMT = "%x01%x02%x03";
const FORMAT = `--format=${RS_FMT}%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00`;
const HEADER_FIELDS = 6;

/** The mode git gives a gitlink: a submodule's commit, recorded in the tree. */
const GITLINK = "160000";
const NULL_SHA = /^0+$/;

/** A raw diff line's header — `:100644 100644 <sha> <sha> M`, or with one
 *  colon per parent for a merge's combined diff — as its parts. */
function rawHeader(token: string): {
  parents: number;
  modes: string[];
  shas: string[];
  status: string;
} {
  const body = token.trimStart();
  const parents = body.length - body.replace(/^:+/, "").length;
  const fields = body.slice(parents).trim().split(" ");
  const sides = parents + 1;
  return {
    parents,
    modes: fields.slice(0, sides),
    shas: fields.slice(sides, sides * 2),
    status: fields[sides * 2] ?? ""
  };
}

function changeOf(status: string, combined: boolean): FileHistoryChange {
  if (combined) return "M";
  switch (status.charAt(0)) {
    case "A":
    case "D":
    case "R":
    case "C":
      return status.charAt(0) as FileHistoryChange;
    default:
      // M, and T: a type change (a file become a link) is a modification here.
      return "M";
  }
}

/** One record of the log: its commit's fields, then its raw diff of the path. */
function parseRecord(record: string): FileHistoryEntry | null {
  const tokens = record.split("\0");
  if (tokens.length < HEADER_FIELDS) return null;
  const [hash, parents, author, authorEmail, date, subject] = tokens;
  // The raw diff: a header token starting with `:`, then the path, or for a
  // rename or copy the old path and the new. Paths are taken where they stand,
  // never trimmed: a file may be named with spaces.
  for (let i = HEADER_FIELDS; i < tokens.length; i++) {
    if (!tokens[i].trimStart().startsWith(":")) continue;
    const header = rawHeader(tokens[i]);
    const combined = header.parents > 1;
    const change = changeOf(header.status, combined);
    const twoPaths = !combined && (change === "R" || change === "C");
    const oldPath = tokens[i + 1] ?? "";
    const path = twoPaths ? (tokens[i + 2] ?? "") : oldPath;
    const before = header.modes[0] === GITLINK ? header.shas[0] : null;
    const after = header.modes.at(-1) === GITLINK ? header.shas.at(-1)! : null;
    return {
      hash,
      parents: parents === "" ? [] : parents.split(" "),
      author,
      authorEmail,
      date: Number(date),
      subject,
      change,
      path,
      oldPath,
      submodule:
        before === null && after === null
          ? null
          : {
              from: before === null || NULL_SHA.test(before) ? null : before,
              to: after === null || NULL_SHA.test(after) ? null : after
            }
    };
  }
  return null;
}

/** Each commit `git log --follow -z --raw --cc` in `FORMAT` printed: its
 *  entry, or null for one printed without a diff of the path. */
function parseRecords(out: string): (FileHistoryEntry | null)[] {
  return out.split(RS).slice(1).map(parseRecord);
}

/** Parse `git log --follow -z --raw --cc` in `FORMAT`. */
export function parseFileHistory(out: string): FileHistoryEntry[] {
  return parseRecords(out).filter((entry): entry is FileHistoryEntry => entry !== null);
}

/**
 * Entries `offset` to `offset + count` of `path`'s history from commit
 * `start`, newest first. `start` must be a commit git can resolve, and
 * nothing git would read as an option; the caller checks it.
 */
export async function loadFileHistory(
  git: SimpleGit,
  { start, path, offset, count }: { start: string; path: string; offset: number; count: number }
): Promise<FileHistoryPage> {
  const out = await git.raw([
    "-c",
    "core.quotePath=false",
    "--literal-pathspecs",
    "log",
    "--follow",
    "--cc",
    "--raw",
    "--no-abbrev",
    "-z",
    // One more than asked: whether there are more is whether it comes.
    `--max-count=${offset + count + 1}`,
    FORMAT,
    start,
    "--",
    path
  ]);
  // Paged by what git printed, which is what `--max-count` counts: a merge
  // whose file is one parent's is printed without a diff of it, and is no
  // entry, but it takes its place in the count all the same. A page may so
  // hold fewer entries than asked, never one twice or none missed.
  const read = parseRecords(out);
  return {
    entries: read
      .slice(offset, offset + count)
      .filter((entry): entry is FileHistoryEntry => entry !== null),
    more: read.length > offset + count
  };
}
