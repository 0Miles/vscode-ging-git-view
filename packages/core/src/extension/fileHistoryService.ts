import type { SimpleGit } from "simple-git";

import {
  type FileHistoryChange,
  type FileHistoryEntry,
  loadFileHistory
} from "@ging/core/backend/queries/fileHistory";
import { formatGitError } from "@ging/core/backend/utils/gitError";
import type { GitFileChangeType } from "@ging/shared/backend/types";

import type { CommitDiffRequest } from "./commitDiff";

/** How many entries a page of a file's history holds. */
export const FILE_HISTORY_PAGE = 100;

/** A page of a file's history to read: `path`'s, from commit `start` — HEAD
 *  when null — past the first `offset` entries. */
export type FileHistoryRequest = { path: string; start: string | null; offset: number };

/** What a read answers. */
export type FileHistoryAnswer = {
  path: string;
  /** The commit it was read from, by its full hash: `start` resolved, so
   *  every later page is read from the same commit however HEAD moves
   *  meanwhile. Null when there is none — a repository with no commit yet. */
  start: string | null;
  offset: number;
  entries: FileHistoryEntry[];
  /** There are entries past these. */
  more: boolean;
  /** Why it could not be read; the entries are then empty. */
  error: string | null;
};

export type FileHistoryServiceDeps = {
  /** The repository's git client. */
  git: () => SimpleGit;
  /** Entries a page holds; `FILE_HISTORY_PAGE` unless a test says less. */
  pageSize?: number;
};

export type FileHistoryService = {
  /** A page of a file's history. Only reads: no git it runs changes anything. */
  load(request: FileHistoryRequest): Promise<FileHistoryAnswer>;
};

/** A commit by its hash: nothing else is run, and so nothing git could read
 *  as an option. */
const HASH = /^[0-9a-f]{4,64}$/i;

/** Why `request` is not one to run; null when it is. A request comes from a
 *  page, which is not to be taken at its word. */
function refusal({ path, start, offset }: FileHistoryRequest): string | null {
  if (typeof path !== "string" || path === "" || path.includes("\0")) return "No file is named.";
  if (start !== null && (typeof start !== "string" || !HASH.test(start))) {
    return `${String(start)} is not a commit.`;
  }
  if (!Number.isSafeInteger(offset) || offset < 0) return `${String(offset)} is not an offset.`;
  return null;
}

/**
 * A file's history as a host's screen reads it (#408): the commits that
 * changed it, each with the path it had there (fileHistory.ts says what
 * `git log --follow` does and does not follow), a page at a time.
 * Host-neutral; the desktop host's file history panel is today's only caller.
 */
export function createFileHistoryService(deps: FileHistoryServiceDeps): FileHistoryService {
  const count = deps.pageSize ?? FILE_HISTORY_PAGE;
  return {
    async load(request) {
      const answer = (rest: Partial<FileHistoryAnswer>): FileHistoryAnswer => ({
        path: request.path,
        start: null,
        offset: request.offset,
        entries: [],
        more: false,
        error: null,
        ...rest
      });
      const refused = refusal(request);
      if (refused !== null) return answer({ error: refused });
      const git = deps.git();
      let start: string;
      try {
        // simple-git resolves a git that failed without a word on stderr, so
        // an empty answer is a failure too.
        start = (await git.raw(["rev-parse", "--verify", `${request.start ?? "HEAD"}^{commit}`]))
          .trim()
          .toLowerCase();
        if (!HASH.test(start)) throw new Error(`${request.start ?? "HEAD"} is not a commit.`);
      } catch (e: unknown) {
        // HEAD resolving to nothing is a repository with no commit yet: a
        // history with nothing in it, not a failure.
        return request.start === null ? answer({}) : answer({ error: formatGitError(e) });
      }
      try {
        const page = await loadFileHistory(git, {
          start,
          path: request.path,
          offset: request.offset,
          count
        });
        return answer({ start, ...page });
      } catch (e: unknown) {
        return answer({ start, error: formatGitError(e) });
      }
    }
  };
}

/** The diff a history's change opens as, in a host's commit diff. */
const DIFF_TYPE: Record<FileHistoryChange, GitFileChangeType> = {
  A: "A",
  M: "M",
  D: "D",
  R: "R",
  // A copy, like a rename, is the file at this commit against the one it was
  // made from, in the commit's parent.
  C: "R"
};

/**
 * The commit diff an entry of `repo`'s file history opens: the file as the
 * commit left it, against the file in its first parent under the path it had
 * there — the old path, for a rename or copy (`commitDiffView`). A merge's
 * is against its first parent too: what the merge brought into that line.
 * Null for a submodule's entry, which has no file of the repository's to
 * show.
 */
export function fileHistoryDiff(
  repo: string,
  entry: Pick<FileHistoryEntry, "hash" | "change" | "path" | "oldPath" | "submodule">
): CommitDiffRequest | null {
  if (entry.submodule !== null) return null;
  return {
    repo,
    commitHash: entry.hash,
    oldFilePath: entry.oldPath,
    newFilePath: entry.path,
    type: DIFF_TYPE[entry.change]
  };
}
