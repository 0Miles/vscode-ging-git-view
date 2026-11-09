import type { SimpleGit } from "simple-git";

import type { GitCommitDetails, QueryResult } from "@/backend/types";

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
// single-commit `--root` form does — so callers skip the first line only for
// root commits (see `firstFileLine`).
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

export async function commitDetails(
  git: SimpleGit,
  input: CommitDetailsInput
): Promise<QueryResult<"commitDetails">> {
  try {
    // The commit's parents decide the diff strategy, so fetch them first.
    const details = await fetchCommitInfo(git, input.commitHash, input.useMailmap);
    const hasParents = details.parents.length > 0;
    const [nameStatusLines, numStatLines] = await Promise.all([
      fetchDiff(git, input.commitHash, hasParents, "--name-status"),
      fetchDiff(git, input.commitHash, hasParents, "--numstat")
    ]);
    // Only the single-commit `--root` form (no parents) prints a leading hash line.
    const firstFileLine = hasParents ? 0 : 1;

    details.fileChanges.push(...parseDiffFileChanges(nameStatusLines, numStatLines, firstFileLine));

    // A stash created with --include-untracked stores those files in a third
    // parent (<stash>^3); list them so the stash's details include them.
    if (input.isStash) {
      try {
        const stdout = await git.raw([
          "-c",
          "core.quotePath=false",
          "ls-tree",
          "-r",
          "--name-only",
          input.commitHash + "^3"
        ]);
        for (const line of stdout.split(eolRegex)) {
          if (line === "") continue;
          const filePath = toPath(unquoteGitPath(line));
          if (details.fileChanges.some((fc) => fc.newFilePath === filePath)) continue; // already listed
          details.fileChanges.push({
            oldFilePath: filePath,
            newFilePath: filePath,
            type: "A",
            additions: null,
            deletions: null
          });
        }
      } catch {
        // No ^3 (stash had no untracked files) — nothing to add.
      }
    }

    return { commitDetails: details };
  } catch {
    return { commitDetails: null };
  }
}
