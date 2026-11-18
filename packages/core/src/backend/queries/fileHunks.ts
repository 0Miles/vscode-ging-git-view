import { createHash } from "node:crypto";

import type { GitRunOptions } from "@ging/core/backend/gitRun";
import { NO_INDEX_REFRESH, spawnGit } from "@ging/core/backend/gitSpawn";
import type {
  FileHunk,
  FileHunks,
  HunkArea,
  LineSpan,
  NoHunksReason
} from "@ging/shared/backend/types";

/** Where a file's diff is read: the repository's top, with the client's git
 *  and environment. No deadline: a read, never killed half-way. */
export type DiffRun = Pick<GitRunOptions, "gitPath" | "repoPath" | "onCommand" | "gitEnv">;

/** A hunk as cut from the diff: its spans, and its lines as git wrote them,
 *  its `@@` line first. Text here is the diff's bytes one character each
 *  (latin1), so a file in any encoding goes back to git as it came. */
export type CutHunk = FileHunk & { text: string };

/** A file's diff cut into what a patch of one hunk is made of. */
export type CutDiff =
  | {
      kind: "hunks";
      token: string;
      /** The patch's header: `diff --git`, `---` and `+++`, as git wrote them. */
      header: string;
      hunks: CutHunk[];
    }
  | { kind: "none"; reason: NoHunksReason };

/**
 * `git diff` of one file, as GING reads it: whatever the user's config says
 * about colour, prefixes, context, external diff drivers or text conversion —
 * none of which a patch git applies can carry. Rename detection is off: one
 * path is asked for, and a rename is two. `--no-optional-locks`: a read,
 * which must not hold the index lock a stage of the user's then meets (#403);
 * and NO_INDEX_REFRESH, because a `git diff` against the working tree takes
 * that lock to refresh the index whatever optional locks say (#451).
 */
function diffArgs(path: string, area: HunkArea): string[] {
  return [
    ...NO_INDEX_REFRESH,
    "--no-optional-locks",
    "--literal-pathspecs",
    // An unchanged empty line keeps its " ": what git apply reads as context.
    "-c",
    "diff.suppressBlankEmpty=false",
    "diff",
    ...(area === "staged" ? ["--cached"] : []),
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--unified=3",
    "--inter-hunk-context=0",
    "--",
    path
  ];
}

/** The `@@ -a,b +c,d @@` of a hunk: its spans, a count left out being 1. */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const span = (start: string, count: string | undefined): LineSpan => ({
  start: Number(start),
  count: count === undefined ? 1 : Number(count)
});

/** A mode that is no regular file: a symbolic link, or a submodule (gitlink). */
const NOT_A_FILE = /\b(?:120000|160000)\b/;

/** Why the header's file offers no hunk of its own, if it does not. */
function headerRefusal(lines: string[]): NoHunksReason | null {
  const has = (prefix: string) => lines.some((line) => line.startsWith(prefix));
  if (has("Binary files ") || has("GIT binary patch")) return "binary";
  if (has("rename from ") || has("copy from ") || has("similarity index ")) return "renamed";
  if (has("new file mode ")) return "added";
  if (has("deleted file mode ")) return "deleted";
  const modes = lines.filter(
    (line) =>
      line.startsWith("index ") || line.startsWith("old mode ") || line.startsWith("new mode ")
  );
  if (modes.some((line) => NOT_A_FILE.test(line))) return "notText";
  return null;
}

/**
 * Cut `git diff`'s output for one file (latin1) into its header and hunks.
 * Answers `none` for a diff no single hunk of which can be staged alone, and
 * throws for output that is not one file's diff — a path that named several.
 */
export function cutFileDiff(out: string): CutDiff {
  if (out === "") return { kind: "none", reason: "unchanged" };
  const lines = out.split("\n");
  // A diff ends its last line, so the split leaves an empty string after it.
  if (lines.at(-1) === "") lines.pop();
  // In conflict: the staged side says so, the unstaged one is a combined
  // diff. Staging any of it would mark it resolved, which only #410's Mark
  // Resolved does.
  if (lines.some((line) => /^(?:\* Unmerged path |diff --cc |diff --combined )/.test(line))) {
    return { kind: "none", reason: "conflicted" };
  }
  if (lines.filter((line) => line.startsWith("diff --git ")).length !== 1) {
    throw new Error("the path named no single file's diff");
  }
  const first = lines.findIndex((line) => line.startsWith("@@ "));
  const headerLines = first === -1 ? lines : lines.slice(0, first);
  const refusal = headerRefusal(headerLines);
  if (refusal !== null) return { kind: "none", reason: refusal };
  // A change of mode alone, say: nothing to cut.
  if (first === -1) return { kind: "none", reason: "notText" };
  // The lines a patch of one hunk needs; the blob ids and modes are left
  // out, so a hunk carries a change of content and nothing else.
  const header = headerLines
    .filter((line) => /^(?:diff --git |--- |\+\+\+ )/.test(line))
    .map((line) => `${line}\n`)
    .join("");
  const hunks: CutHunk[] = [];
  for (let at = first; at < lines.length; ) {
    let end = at + 1;
    while (end < lines.length && !lines[end].startsWith("@@ ")) end++;
    const match = HUNK_HEADER.exec(lines[at]);
    if (match === null) throw new Error(`not a hunk header: ${lines[at]}`);
    hunks.push({
      original: span(match[1], match[2]),
      modified: span(match[3], match[4]),
      text: lines
        .slice(at, end)
        .map((line) => `${line}\n`)
        .join("")
    });
    at = end;
  }
  return {
    kind: "hunks",
    token: createHash("sha1").update(out, "latin1").digest("hex"),
    header,
    hunks
  };
}

/**
 * The diff of `path` (repository-relative) in `area`, cut into hunks to
 * stage or unstage one at a time (#406). Read as bytes: a file in an encoding
 * other than UTF-8 goes back to git byte for byte. A conflicted path offers
 * none, nor does a file git converts on its way into the index (`CONVERTING`;
 * in either area, for one rule). Git runs straight from `spawnGit`: no git client's
 * queue, which the graph's own reads may fill after a change to the working
 * tree. Rejects when git fails, or `path` names more than one file.
 */
export async function readFileDiff(run: DiffRun, path: string, area: HunkArea): Promise<CutDiff> {
  const [diff, attributes] = await Promise.all([
    gitOut(run, "diff", diffArgs(path, area)),
    gitOut(run, "check-attr", ["check-attr", "-z", ...CONVERTING, "--", path])
  ]);
  const cut = cutFileDiff(diff.toString("latin1"));
  if (cut.kind === "hunks" && converts(attributes.toString())) {
    return { kind: "none", reason: "converted" };
  }
  return cut;
}

/** The attributes under which git's diff is not of the text the viewer
 *  shows: a `filter` (LFS and the like) cleans the working tree's file into
 *  something else, `working-tree-encoding` re-encodes it, `ident` expands
 *  `$Id$`. The viewer shows the index's blob against the file as it is, so
 *  git's hunks would sit on lines that are not theirs. Line endings are not
 *  among them: they change no line's place. */
const CONVERTING = ["filter", "working-tree-encoding", "ident"];

/** Whether `git check-attr -z` says any of `CONVERTING` applies. Each answer
 *  is `path NUL attribute NUL value NUL`. */
function converts(out: string): boolean {
  const fields = out.split("\0");
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (fields[i + 2] !== "unspecified" && fields[i + 2] !== "unset") return true;
  }
  return false;
}

/** `git <args>`'s output, as bytes; rejects when git fails. Run straight from
 *  `spawnGit`, not behind a git client's queue. */
export async function gitOut(run: DiffRun, what: string, args: string[]): Promise<Buffer> {
  const result = await spawnGit({
    gitPath: run.gitPath,
    cwd: run.repoPath,
    args,
    onCommand: run.onCommand,
    gitEnv: run.gitEnv
  });
  if (result.kind === "error") throw result.error;
  if (result.kind !== "ok") throw new Error(`git ${what} did not finish (${result.kind})`);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git ${what} exited with ${result.exitCode}`);
  }
  return result.stdout;
}

/** HEAD's commit, or `null` on a branch with no commit yet: what the staged
 *  diff's left side is read at (#460). One git run, as `readFileDiff` is. */
export async function readHead(run: DiffRun): Promise<string | null> {
  const result = await spawnGit({
    gitPath: run.gitPath,
    cwd: run.repoPath,
    args: ["rev-parse", "--verify", "-q", "HEAD^{commit}"],
    onCommand: run.onCommand,
    gitEnv: run.gitEnv
  });
  if (result.kind === "error") throw result.error;
  if (result.kind !== "ok") throw new Error(`git rev-parse did not finish (${result.kind})`);
  // `--verify -q` exits 1, saying nothing, when there is no HEAD commit.
  if (result.exitCode === 1 && result.stdout.length === 0) return null;
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git rev-parse exited with ${result.exitCode}`);
  }
  return result.stdout.toString().trim();
}

/** What `readFileDiff` offers the user: the hunks' spans, and the token
 *  naming the diff they were cut from. */
export function offeredHunks(diff: CutDiff): FileHunks {
  return diff.kind === "none"
    ? diff
    : {
        kind: "hunks",
        token: diff.token,
        hunks: diff.hunks.map(({ original, modified }) => ({ original, modified }))
      };
}
