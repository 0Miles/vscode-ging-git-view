import type { BlameLine } from "@/backend/queries/blameFile";

import type { CommitDiffRequest } from "./commitDiff";

/** A blamed line's change, as the hover's "open this line's change" link hands
 *  it to its command. */
export type LineChange = {
  repo: string;
  sha: string;
  /** The file's path in `sha`. */
  filename: string;
  /** The line's 1-based number in `filename` as of `sha`. */
  line: number;
  /** The commit before `sha` that touched the file, and its path there; null
   *  when `sha` added the file — a root commit, say. */
  previous: { sha: string; filename: string } | null;
};

/** The change of a committed blamed line in `repo`. */
export function lineChangeOf(repo: string, line: BlameLine): LineChange {
  return {
    repo,
    sha: line.sha,
    filename: line.filename,
    line: line.originalLine,
    previous: line.previous === null ? null : { ...line.previous }
  };
}

/**
 * The diff editor of a line's change: the file as the previous commit had it,
 * under its name there (so a rename lines up), against the commit's version,
 * at the line. With no previous the commit added the file, so the left side is
 * empty.
 */
export function lineChangeDiff(change: LineChange): CommitDiffRequest {
  const { repo, sha, filename, line, previous } = change;
  if (previous === null) {
    return {
      repo,
      commitHash: sha,
      oldFilePath: filename,
      newFilePath: filename,
      type: "A",
      revealLine: line
    };
  }
  return {
    repo,
    commitHash: sha,
    oldFilePath: previous.filename,
    newFilePath: filename,
    type: previous.filename === filename ? "M" : "R",
    fromHash: previous.sha,
    revealLine: line
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCommitHash = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);

/** A path inside the repository, relative to its root, as git writes one. */
const isRepoPath = (value: unknown): value is string =>
  typeof value === "string" &&
  value !== "" &&
  !value.includes("\0") &&
  !/^(?:[\\/]|[A-Za-z]:)/.test(value) &&
  !value.split(/[\\/]/).includes("..");

/**
 * The line change a hover's link handed its command, or null for anything
 * else. A command link's arguments come from a URI anyone could write, so
 * every part is checked: full commit hashes only, a repository among
 * `knownRepos`, paths inside it, and a line number.
 */
export function lineChangeArgs(arg: unknown, knownRepos: readonly string[]): LineChange | null {
  if (!isRecord(arg)) return null;
  const { repo, sha, filename, line, previous } = arg;
  if (typeof repo !== "string" || !knownRepos.includes(repo)) return null;
  if (!isCommitHash(sha) || !isRepoPath(filename)) return null;
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return null;
  if (previous === null) return { repo, sha, filename, line, previous: null };
  if (!isRecord(previous) || !isCommitHash(previous.sha) || !isRepoPath(previous.filename)) {
    return null;
  }
  return {
    repo,
    sha,
    filename,
    line,
    previous: { sha: previous.sha, filename: previous.filename }
  };
}
