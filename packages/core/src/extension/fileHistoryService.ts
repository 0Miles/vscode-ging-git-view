import { type GitCommandHandler, spawnGit } from "@ging/core/backend/gitSpawn";
import {
  type FileHistoryChange,
  FileHistoryClosedError,
  type FileHistoryEntry,
  type FileHistoryReader,
  readFileHistory
} from "@ging/core/backend/queries/fileHistory";
import { formatGitError } from "@ging/core/backend/utils/gitError";
import type { GitFileChangeType } from "@ging/shared/backend/types";

import type { CommitDiffRequest } from "./commitDiff";

/** How many entries a page of a file's history holds. */
export const FILE_HISTORY_PAGE = 100;

/** How long reading one page may take before git is stopped and the read
 *  said to have failed: a history whose path no commit touches for a long
 *  way back is walked to its end before a page is full. */
export const FILE_HISTORY_READ_MS = 60_000;

/** How long the history open is kept — its git paused, waiting — with no page
 *  asked of it. Past it git is stopped; a page asked later reads the history
 *  again, past what was already read. */
export const FILE_HISTORY_IDLE_MS = 5 * 60_000;

/** A file's history to open: `path`'s, from commit `start` — HEAD when null. */
export type FileHistoryRequest = { path: string; start: string | null };

/** What a read answers. */
export type FileHistoryAnswer = {
  path: string;
  /** The commit it is read from, by its full hash: `start` resolved, so every
   *  page is read from the same commit however HEAD moves meanwhile. Null
   *  when there is none — a repository with no commit yet. */
  start: string | null;
  /** The history's first page, not one after it. */
  first: boolean;
  entries: FileHistoryEntry[];
  /** There are entries past these. */
  more: boolean;
  /** Why it could not be read; the entries are then empty. */
  error: string | null;
};

export type FileHistoryServiceDeps = {
  gitPath: () => string;
  /** The repository the history is read from. */
  repo: () => string;
  onCommand?: GitCommandHandler;
  /** Entries a page holds; `FILE_HISTORY_PAGE` unless a test says less. */
  pageSize?: number;
  /** `FILE_HISTORY_READ_MS` and `FILE_HISTORY_IDLE_MS`, unless a test says less. */
  readMs?: number;
  idleMs?: number;
};

/**
 * One history open at a time, as one screen shows it: opening another, or
 * closing, stops the git reading the one before, and a page that one was
 * still reading is answered `null` — nobody waits for it any more. Only reads:
 * no git it runs changes anything.
 */
export type FileHistoryService = {
  /** Open a history, in place of any open, and read its first page. */
  open(request: FileHistoryRequest): Promise<FileHistoryAnswer | null>;
  /** The next page of the history open; null when none is. */
  more(): Promise<FileHistoryAnswer | null>;
  /** Stop reading the history open, if one is. */
  close(): void;
  /** Whether git tracks `path` at all: false for an untracked or ignored file,
   *  whose history is empty because git has never had it. */
  isTracked(path: string): Promise<boolean>;
};

/** A commit by its hash: nothing else is run, and so nothing git could read
 *  as an option. */
const HASH = /^[0-9a-f]{4,64}$/i;

/** How long resolving the start commit may take. */
const RESOLVE_MS = 10_000;

/** Why `request` is not one to run; null when it is. A request comes from a
 *  page, which is not to be taken at its word. */
function refusal({ path, start }: FileHistoryRequest): string | null {
  if (typeof path !== "string" || path === "" || path.includes("\0")) return "No file is named.";
  if (start !== null && (typeof start !== "string" || !HASH.test(start))) {
    return `${String(start)} is not a commit.`;
  }
  return null;
}

class ReadTooLongError extends Error {}

type Open = {
  path: string;
  start: string;
  /** Null once stopped for being idle. */
  reader: FileHistoryReader | null;
  /** Entries handed out so far. */
  read: number;
  /** Read to its end: no page is left to read. */
  done: boolean;
  idle: ReturnType<typeof setTimeout> | null;
};

/** Stop reading `open`: its git killed, its idle timer gone. */
function stop(open: Open) {
  if (open.idle !== null) clearTimeout(open.idle);
  open.idle = null;
  open.reader?.close();
  open.reader = null;
}

/**
 * A file's history as a host's screen reads it (#408): the commits that
 * changed it, each with the path it had there (fileHistory.ts says what
 * `git log --follow` does and does not follow, and how it is read a page at
 * a time). Host-neutral; the desktop host's file history panel is today's
 * only caller.
 */
export function createFileHistoryService(deps: FileHistoryServiceDeps): FileHistoryService {
  const count = deps.pageSize ?? FILE_HISTORY_PAGE;
  const readMs = deps.readMs ?? FILE_HISTORY_READ_MS;
  const idleMs = deps.idleMs ?? FILE_HISTORY_IDLE_MS;
  let generation = 0;
  let current: Open | null = null;

  const reader = (open: Open) =>
    readFileHistory({
      gitPath: deps.gitPath(),
      repo: deps.repo(),
      start: open.start,
      path: open.path,
      onCommand: deps.onCommand
    });
  /** `count` entries of `open`, or fewer; git stopped should it take longer
   *  than `readMs`. */
  const page = async (open: Open, wanted: number) => {
    const from = open.reader ?? (open.reader = reader(open));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        from.close();
        reject(new ReadTooLongError());
      }, readMs);
    });
    try {
      return await Promise.race([from.next(wanted), late]);
    } finally {
      clearTimeout(timer);
    }
  };
  /** Wait for the next page, then stop git if nobody asks for it. */
  const idleAfter = (open: Open) => {
    open.idle = setTimeout(() => {
      open.idle = null;
      open.reader?.close();
      open.reader = null;
    }, idleMs);
  };
  /** Read the next page of `open`: an answer, or null once it is not the one
   *  open any more. */
  const readPage = async (open: Open, first: boolean): Promise<FileHistoryAnswer | null> => {
    const answer = (rest: Partial<FileHistoryAnswer>): FileHistoryAnswer => ({
      path: open.path,
      start: open.start,
      first,
      entries: [],
      more: false,
      error: null,
      ...rest
    });
    if (open.idle !== null) clearTimeout(open.idle);
    open.idle = null;
    if (open.done) return answer({});
    try {
      if (open.reader === null && open.read > 0) {
        // Stopped while idle: read it again, past what was handed out.
        await page(open, open.read);
      }
      const { entries, more } = await page(open, count);
      if (open !== current) return null;
      open.read += entries.length;
      if (more) idleAfter(open);
      else {
        open.done = true;
        stop(open);
      }
      return answer({ entries, more });
    } catch (e: unknown) {
      if (open !== current || e instanceof FileHistoryClosedError) return null;
      stop(open);
      return answer({
        error:
          e instanceof ReadTooLongError
            ? `Reading the history of ${open.path} took longer than ${readMs / 1000} seconds.`
            : formatGitError(e)
      });
    }
  };

  return {
    async open(request) {
      if (current !== null) stop(current);
      current = null;
      const mine = ++generation;
      const answer = (rest: Partial<FileHistoryAnswer>): FileHistoryAnswer => ({
        path: request.path,
        start: null,
        first: true,
        entries: [],
        more: false,
        error: null,
        ...rest
      });
      const refused = refusal(request);
      if (refused !== null) return answer({ error: refused });
      const revision = `${request.start ?? "HEAD"}^{commit}`;
      const resolved = await spawnGit({
        gitPath: deps.gitPath(),
        cwd: deps.repo(),
        args: ["rev-parse", "--verify", "--quiet", revision],
        timeoutMs: RESOLVE_MS,
        onCommand: deps.onCommand
      });
      if (mine !== generation) return null;
      const start =
        resolved.kind === "ok" && resolved.exitCode === 0
          ? resolved.stdout.toString().trim().toLowerCase()
          : "";
      if (!HASH.test(start)) {
        // HEAD resolving to nothing is a repository with no commit yet: a
        // history with nothing in it, not a failure.
        return request.start === null
          ? answer({})
          : answer({ error: `${request.start} is not a commit.` });
      }
      const open: Open = {
        path: request.path,
        start,
        reader: null,
        read: 0,
        done: false,
        idle: null
      };
      current = open;
      return readPage(open, true);
    },
    async more() {
      const open = current;
      if (open === null) return null;
      return readPage(open, false);
    },
    close() {
      generation++;
      if (current !== null) stop(current);
      current = null;
    },
    async isTracked(path) {
      if (typeof path !== "string" || path === "" || path.includes("\0")) return false;
      const result = await spawnGit({
        gitPath: deps.gitPath(),
        cwd: deps.repo(),
        args: ["--literal-pathspecs", "ls-files", "--error-unmatch", "--", path],
        timeoutMs: RESOLVE_MS,
        onCommand: deps.onCommand
      });
      return result.kind === "ok" && result.exitCode === 0;
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
 * is against its first parent too: what the merge brought into that line,
 * its own change among it.
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
