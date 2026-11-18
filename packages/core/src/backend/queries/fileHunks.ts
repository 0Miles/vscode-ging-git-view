import { createHash } from "node:crypto";

import type { SimpleGit } from "simple-git";

import type { GitRunOptions } from "@ging/core/backend/gitRun";
import { spawnGit } from "@ging/core/backend/gitSpawn";
import { unmergedFiles } from "@ging/core/backend/queries/unmergedFiles";
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
 * which must not hold the index lock a stage of the user's then meets (#403).
 */
function diffArgs(path: string, area: HunkArea): string[] {
  return [
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
    (line) => line.startsWith("index ") || line.startsWith("old mode ") || line.startsWith("new mode ")
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
 * none: staging any of it would mark it resolved, which only #410's Mark
 * Resolved does. Rejects when git fails, or `path` names more than one file.
 */
export async function readFileDiff(
  git: SimpleGit,
  run: DiffRun,
  path: string,
  area: HunkArea
): Promise<CutDiff> {
  if ((await unmergedFiles(git)).includes(path)) return { kind: "none", reason: "conflicted" };
  const result = await spawnGit({
    gitPath: run.gitPath,
    cwd: run.repoPath,
    args: diffArgs(path, area),
    onCommand: run.onCommand,
    gitEnv: run.gitEnv
  });
  if (result.kind === "error") throw result.error;
  if (result.kind !== "ok") throw new Error(`git diff did not finish (${result.kind})`);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git diff exited with ${result.exitCode}`);
  }
  return cutFileDiff(result.stdout.toString("latin1"));
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
