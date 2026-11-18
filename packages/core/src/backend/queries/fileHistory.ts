import { type GitCommandHandler, spawnGit, streamGit } from "@ging/core/backend/gitSpawn";
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
 *   `-`, a newline); git refuses `--follow` with more than one.
 * - **Every line of history from the start commit.** With `--follow` git
 *   prunes nothing while it walks, so there is no history simplification for
 *   `--full-history` to turn off, and no `--first-parent`: a change made on a
 *   branch that was merged is listed where it was made.
 * - **A merge only for a change of its own** — a conflict's resolution, or a
 *   change made in the merge itself — since no other commit holds it. git's
 *   combined raw diff (`--cc --raw`) lists a merge whenever its file is unlike
 *   every parent's, which a clean merge of two sides that each changed it is
 *   too, though both changes are already listed where they were made. So each
 *   merge it lists is asked again for its dense combined patch (`diff-tree
 *   --cc -p`), which leaves out every hunk the merge took unchanged from one
 *   side; only a merge with something left is an entry.
 *
 * **Read as a stream, a page at a time.** `--skip` cannot page it — under
 * `--follow` git counts every commit walked against `--skip`, shown or not —
 * and reading the history again from the start for each page walks it once
 * per page. So one `git log` runs for as long as the history is being read:
 * a page is taken from its output as it comes, and git is paused (its pipe
 * left full) in between, until the next page is asked for or the reader is
 * closed, which kills it. It runs through `streamGit`, not the repository's
 * simple-git client, so it holds none of the client's few process slots.
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

/** How long a merge's dense patch may take to be read. */
const MERGE_CHECK_MS = 30_000;

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

/** The change a status letter names. A merge's combined status has one letter
 *  per parent, and its entry is the change from the first: the one its diff
 *  is against, which then reads no file that is not there. */
function changeOf(status: string): FileHistoryChange {
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

/** One record of the log: its commit's fields, then its raw diff of the path.
 *  Null for one with no diff of it. */
function parseRecord(record: string): FileHistoryEntry | null {
  const tokens = record.split("\0");
  if (tokens.length < HEADER_FIELDS) return null;
  const [hash, parents, author, authorEmail, date, subject] = tokens;
  // The raw diff: a header token starting with `:`, then the path, or for a
  // rename or copy the old path and the new. Paths are taken where they stand,
  // never trimmed: a file may be named with spaces, or a newline.
  for (let i = HEADER_FIELDS; i < tokens.length; i++) {
    if (!tokens[i].trimStart().startsWith(":")) continue;
    const header = rawHeader(tokens[i]);
    const combined = header.parents > 1;
    const change = changeOf(header.status);
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
      // A combined diff has no rename: one path, as the merge left it.
      change: combined && (change === "R" || change === "C") ? "M" : change,
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

/** Parse `git log --follow -z --raw --cc` in `FORMAT`: every commit printed
 *  with a diff of the path. Merges are as git lists them, before their dense
 *  patch is asked for (`readFileHistory` asks). */
export function parseFileHistory(out: string): FileHistoryEntry[] {
  return out
    .split(RS)
    .slice(1)
    .map(parseRecord)
    .filter((entry): entry is FileHistoryEntry => entry !== null);
}

/** Where and how the history is read. `start` must be a commit git can
 *  resolve, and nothing git would read as an option; the caller checks it. */
export type FileHistorySource = {
  gitPath: string;
  repo: string;
  start: string;
  path: string;
  onCommand?: GitCommandHandler;
};

/** A file's history as it is read, a page at a time (see the top of this file). */
export type FileHistoryReader = {
  /** The next `count` entries or fewer, newest first. Rejects with git's
   *  error, or a `FileHistoryClosedError` once closed. One at a time. */
  next(count: number): Promise<FileHistoryPage>;
  /** Kill git, if it is still running; any `next` waiting rejects. */
  close(): void;
  /** Settles once git has ended, however it did. */
  ended: Promise<void>;
};

/** The reader was closed before the page asked of it was read. */
export class FileHistoryClosedError extends Error {
  constructor() {
    super("The file's history was closed");
  }
}

/** Whether merge `entry` holds a change of its own to the file: its dense
 *  combined patch of it is not empty. */
async function mergeChangesFile(
  source: FileHistorySource,
  entry: FileHistoryEntry,
  signal: AbortSignal
): Promise<boolean> {
  const result = await spawnGit({
    gitPath: source.gitPath,
    cwd: source.repo,
    args: [
      "--literal-pathspecs",
      "diff-tree",
      "--cc",
      "-p",
      "--no-commit-id",
      entry.hash,
      "--",
      entry.path
    ],
    timeoutMs: MERGE_CHECK_MS,
    signal,
    onCommand: source.onCommand
  });
  if (result.kind === "aborted") throw new FileHistoryClosedError();
  if (result.kind !== "ok" || result.exitCode !== 0) {
    throw new Error(
      result.kind === "ok"
        ? result.stderr.trim() || `git diff-tree exited ${result.exitCode}`
        : result.kind === "error"
          ? result.error.message
          : "git diff-tree took too long"
    );
  }
  return result.stdout.length > 0;
}

/** Open `source`'s history for reading: git starts, and waits for the first
 *  page to be asked for. */
export function readFileHistory(source: FileHistorySource): FileHistoryReader {
  const git = streamGit({
    gitPath: source.gitPath,
    cwd: source.repo,
    args: [
      "-c",
      "core.quotePath=false",
      "--literal-pathspecs",
      "log",
      "--follow",
      "--cc",
      "--raw",
      "--no-abbrev",
      "-z",
      FORMAT,
      source.start,
      "--",
      source.path
    ],
    onCommand: source.onCommand
  });
  const aborts = new AbortController();
  const decoder = new TextDecoder();
  /** Output not yet split into records: the last record may be incomplete. */
  let text = "";
  /** Records read whole, not yet made entries. */
  const records: string[] = [];
  /** Entries ready, not yet handed out. */
  const ready: FileHistoryEntry[] = [];
  let finished = false;
  let closed = false;
  let failure: Error | null = null;
  /** Woken when more output, the end, or a close comes. */
  let wake: (() => void) | null = null;
  const woken = () => {
    const w = wake;
    wake = null;
    w?.();
  };

  /** Split off every record whose end has been read: one is whole once the
   *  next one's separator has come. */
  const split = () => {
    let at = text.indexOf(RS, 1);
    while (at !== -1) {
      records.push(text.slice(RS.length, at));
      text = text.slice(at);
      at = text.indexOf(RS, 1);
    }
  };
  git.onData((chunk) => {
    text += decoder.decode(chunk, { stream: true });
    split();
    // Enough for now: let git wait with the pipe full.
    if (records.length > 0) git.pause();
    woken();
  });
  const ended = git.ended.then((how) => {
    text += decoder.decode();
    if (text.startsWith(RS)) records.push(text.slice(RS.length));
    text = "";
    if ("error" in how) failure = how.error;
    else if (how.exitCode !== 0 && !closed) {
      failure = new Error(how.stderr.trim() || `git log exited ${String(how.exitCode)}`);
    }
    finished = true;
    woken();
  });

  /** One more entry made ready, or false once there are none to make. */
  const advance = async (): Promise<boolean> => {
    for (;;) {
      if (closed) throw new FileHistoryClosedError();
      const record = records.shift();
      if (record !== undefined) {
        const entry = parseRecord(record);
        if (entry === null) continue;
        // In order, one at a time: a page is the next entries, and only the
        // merges reached are checked.
        // eslint-disable-next-line no-await-in-loop -- see above
        if (entry.parents.length > 1 && !(await mergeChangesFile(source, entry, aborts.signal))) {
          continue;
        }
        ready.push(entry);
        return true;
      }
      if (finished) {
        if (failure !== null) throw failure;
        return false;
      }
      const more = new Promise<void>((resolve) => (wake = resolve));
      git.resume();
      await more; // eslint-disable-line no-await-in-loop -- each wait is for output the last did not bring
    }
  };

  let turn: Promise<unknown> = Promise.resolve();
  return {
    next(count) {
      const run = turn.then(async () => {
        // One past the page: whether there are more is whether it comes.
        // eslint-disable-next-line no-await-in-loop -- one entry after another, in order
        while (ready.length < count + 1 && (await advance()));
        return { entries: ready.splice(0, count), more: ready.length > 0 };
      });
      turn = run.catch(() => {});
      return run;
    },
    close() {
      if (closed) return;
      closed = true;
      aborts.abort();
      git.kill();
      woken();
    },
    ended
  };
}
