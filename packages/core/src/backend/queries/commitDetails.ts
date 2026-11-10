import type { SimpleGit } from "simple-git";

import { fileChangeRevision } from "@ging/core/backend/utils/fileChangeRevision";
import type { GitCommitDetails, GitFileChange, QueryResult } from "@ging/shared/backend/types";

import { parseDiffFileChanges, toPath, unquoteGitPath } from "./diffFileChanges";

const eolRegex = /\r\n|\r|\n/g;
const gitLogSeparator = "XX7Nal-YARtTpjCikii9nJxER19D6diSyk-AWkPb";

type CommitDetailsInput = {
  commitHash: string;
  useMailmap: boolean;
  isStash?: boolean;
};

async function fetchCommitInfo(
  git: SimpleGit,
  commitHash: string,
  useMailmap: boolean
): Promise<GitCommitDetails> {
  // %aN/%aE/%cN/%cE always apply .mailmap; their lowercase forms never do.
  const authorName = useMailmap ? "%aN" : "%an";
  const authorEmail = useMailmap ? "%aE" : "%ae";
  const committerName = useMailmap ? "%cN" : "%cn";
  const committerEmail = useMailmap ? "%cE" : "%ce";
  const format =
    ["%H", "%P", authorName, authorEmail, committerName, committerEmail, "%at", "%ct"].join(
      gitLogSeparator
    ) + "%n%B";
  const stdout = await git.raw(["show", "--quiet", commitHash, `--format=${format}`]);
  const lines = stdout.split(eolRegex);
  let lastLine = lines.length - 1;
  while (lastLine >= 0 && lines[lastLine] === "") lastLine--;
  const commitInfo = lines[0].split(gitLogSeparator);
  return {
    hash: commitInfo[0],
    parents: commitInfo[1] === "" ? [] : commitInfo[1].split(" "),
    author: commitInfo[2],
    email: commitInfo[3],
    committer: commitInfo[4],
    committerEmail: commitInfo[5],
    authorDate: parseInt(commitInfo[6]),
    commitDate: parseInt(commitInfo[7]),
    body: lines.slice(1, lastLine + 1).join("\n"),
    fileChanges: []
  };
}

// `-c core.quotePath=false` stops git from octal-escaping non-ASCII bytes in
// file paths (e.g. "\303\244.txt"), so paths come through as raw UTF-8.
//
// For commits with parents we diff against the FIRST parent (`<hash>^ <hash>`),
// so a merge commit's files are shown relative to its first parent. The
// old `-m` form instead emitted a separate diff against every parent (each
// prefixed by a commit hash line), which listed merged-in files twice and
// broke the line parser. Root commits (no parent) use the `--root` form.
//
// The two-argument form prints no leading commit-hash line, whereas the
// single-commit `--root` form does — so the first line is skipped only for
// root commits (see `fetchFileChanges`).
async function fetchDiff(
  git: SimpleGit,
  commitHash: string,
  hasParents: boolean,
  stat: "--name-status" | "--numstat"
): Promise<string[]> {
  const args = ["-c", "core.quotePath=false", "diff-tree", stat, "-r", "--find-renames"];
  if (hasParents) {
    args.push("--diff-filter=AMDR", commitHash + "^", commitHash);
  } else {
    args.push("--root", "--diff-filter=AMDR", commitHash);
  }
  return (await git.raw(args)).split(eolRegex);
}

/** A commit's file changes, counted: against its first parent, or — a root
 *  commit, `hasParents` false — as every file added. */
async function fetchFileChanges(
  git: SimpleGit,
  commitHash: string,
  hasParents: boolean
): Promise<GitFileChange[]> {
  const [nameStatusLines, numStatLines] = await Promise.all([
    fetchDiff(git, commitHash, hasParents, "--name-status"),
    fetchDiff(git, commitHash, hasParents, "--numstat")
  ]);
  // Only the single-commit `--root` form (no parents) prints a leading hash line.
  const firstFileLine = hasParents ? 0 : 1;
  return parseDiffFileChanges(nameStatusLines, numStatLines, firstFileLine);
}

/** A root commit's file changes: every one added, none renamed, so `--numstat`
 *  alone names them (a binary file's counts are `-`, as in `fetchFileChanges`). */
async function fetchRootFileChanges(git: SimpleGit, commitHash: string): Promise<GitFileChange[]> {
  const numStatLines = await fetchDiff(git, commitHash, false, "--numstat");
  const fileChanges: GitFileChange[] = [];
  // Skip the leading hash line the single-commit `--root` form prints.
  for (let i = 1; i < numStatLines.length - 1; i++) {
    const line = numStatLines[i].split("\t");
    if (line.length !== 3) break;
    const filePath = toPath(unquoteGitPath(line[2]));
    fileChanges.push({
      oldFilePath: filePath,
      newFilePath: filePath,
      type: "A",
      additions: parseInt(line[0]),
      deletions: parseInt(line[1])
    });
  }
  return fileChanges;
}

export async function commitDetails(
  git: SimpleGit,
  input: CommitDetailsInput
): Promise<QueryResult<"commitDetails">> {
  try {
    // The commit's parents decide the diff strategy, so fetch them first.
    const details = await fetchCommitInfo(git, input.commitHash, input.useMailmap);
    const hasParents = details.parents.length > 0;
    // A stash's third parent holds its untracked files; one with ≤ 2 parents has none.
    const hasUntracked = input.isStash === true && details.parents.length > 2;
    const [fileChanges, untrackedFileChanges] = await Promise.all([
      fetchFileChanges(git, input.commitHash, hasParents),
      hasUntracked
        ? fetchRootFileChanges(git, fileChangeRevision(input.commitHash, "untracked"))
        : []
    ]);
    details.fileChanges.push(...fileChanges);

    // A file untracked when stashed can still be in the commit the stash was
    // made on (`git rm --cached` leaves it so); the stash's tracked changes then
    // list it too, and that row is the one kept. So no untracked row has a file
    // on the left side of its diff, which is why `commitDiffView` reads it empty.
    const trackedPaths = new Set(fileChanges.map((fc) => fc.newFilePath));
    for (const fileChange of untrackedFileChanges) {
      if (trackedPaths.has(fileChange.newFilePath)) continue;
      details.fileChanges.push({ ...fileChange, origin: "untracked" });
    }

    return { commitDetails: details };
  } catch {
    return { commitDetails: null };
  }
}
