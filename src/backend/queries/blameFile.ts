import * as fs from "node:fs";
import * as path from "node:path";

import { type GitRunOptions, runWithin } from "@/backend/gitRun";

/** What `git blame` says about one line of a file. */
export type BlameLine = {
  sha: string;
  /** The line is not in any commit yet — git reports it under the all-zero SHA. */
  uncommitted: boolean;
  authorName: string;
  authorEmail: string;
  /** Author time, in seconds since the epoch. */
  authorTime: number;
  summary: string;
  /** The line's 1-based number in `filename` as of `sha`. */
  originalLine: number;
  /** The file's path in `sha` — differs from today's after a rename. */
  filename: string;
  /** The commit before `sha` that touched the file, and its path there; null
   *  for a root commit. */
  previous: { sha: string; filename: string } | null;
};

type CommitDetails = Omit<BlameLine, "sha" | "uncommitted" | "originalLine">;

const HEADER = /^([0-9a-f]{40}|[0-9a-f]{64}) (\d+) (\d+)(?: \d+)?$/;

/**
 * Parse `git blame --porcelain` output into one entry per line of the blamed
 * file, in order. Git prints a commit's details only the first time the commit
 * appears, so they are remembered per SHA and carried onto the later lines that
 * repeat only the SHA.
 */
export function parseBlamePorcelain(output: string): BlameLine[] {
  const commits = new Map<string, CommitDetails>();
  const result: BlameLine[] = [];
  // The line group being read: its header, and the details of its commit.
  let group: { sha: string; originalLine: number; details: CommitDetails } | undefined;

  for (const line of output.split("\n")) {
    const header = HEADER.exec(line);
    if (header !== null) {
      const sha = header[1];
      const details = commits.get(sha) ?? emptyDetails();
      commits.set(sha, details);
      group = { sha, originalLine: Number(header[2]), details };
    } else if (group !== undefined && line.startsWith("\t")) {
      result.push({
        sha: group.sha,
        uncommitted: /^0+$/.test(group.sha),
        ...group.details,
        originalLine: group.originalLine
      });
    } else if (group !== undefined) {
      readDetail(group.details, line);
    }
  }
  return result;
}

function emptyDetails(): CommitDetails {
  return {
    authorName: "",
    authorEmail: "",
    authorTime: 0,
    summary: "",
    filename: "",
    previous: null
  };
}

/** Record one `key value` header line of a commit's details. */
function readDetail(details: CommitDetails, line: string) {
  const space = line.indexOf(" ");
  const key = space === -1 ? line : line.slice(0, space);
  const value = space === -1 ? "" : line.slice(space + 1);
  switch (key) {
    case "author":
      details.authorName = value;
      break;
    case "author-mail":
      details.authorEmail = value.replace(/^<(.*)>$/, "$1");
      break;
    case "author-time":
      details.authorTime = Number(value);
      break;
    case "summary":
      details.summary = value;
      break;
    case "filename":
      details.filename = value;
      break;
    case "previous": {
      const gap = value.indexOf(" ");
      details.previous = { sha: value.slice(0, gap), filename: value.slice(gap + 1) };
      break;
    }
    default:
      break;
  }
}

/** Files bigger than this are never blamed. Fixed, not a setting. */
export const BLAME_MAX_BYTES = 1024 * 1024;
/** How long one blame lookup may take, every git run in it together. */
export const BLAME_TIMEOUT_MS = 5000;

/** The git runs of one blame lookup share one deadline, which defaults to
 *  `BLAME_TIMEOUT_MS` from the call. */
export type BlameFileOptions = GitRunOptions & {
  /** The file, relative to `repoPath`, with "/" separators. */
  filePath: string;
  /** Blame these contents (an editor's text) instead of the file on disk;
   *  they are passed to git on stdin, as UTF-8. */
  contents?: string;
  /** When `contents` can't be turned back into the saved file's bytes (see
   *  `asSavedText`), blame the file on disk rather than give no result. Right
   *  for an editor without unsaved edits, whose text is what is saved. */
  fallBackToDisk?: boolean;
};

const UTF8_BOM = "\uFEFF";

/**
 * An editor's text as the bytes git should compare with the committed file,
 * judged by the copy saved on disk (null when there is none): the UTF-8 BOM
 * VS Code strips from the text goes back in front, and null when the saved
 * file isn't UTF-8, since the text can't be turned back into its bytes and
 * every line with a non-ASCII character would look changed. VS Code 1.98,
 * the oldest this extension supports, has no `workspace.encode` to do it with
 * the document's own encoding.
 */
function asSavedText(text: string, saved: Buffer | null): string | null {
  if (saved === null) return text;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(saved);
  } catch {
    return null;
  }
  const hasBom = saved[0] === 0xef && saved[1] === 0xbb && saved[2] === 0xbf;
  return hasBom && !text.startsWith(UTF8_BOM) ? UTF8_BOM + text : text;
}

/**
 * Blame a whole file: one entry per line, in order. Resolves null — never
 * rejects — when there is nothing to show: the file is over 1 MB, git counts it
 * as binary, git doesn't track it (ignored or not), the deadline passes, or git
 * fails.
 */
export async function blameFile(options: BlameFileOptions): Promise<BlameLine[] | null> {
  const deadline = options.deadline ?? Date.now() + BLAME_TIMEOUT_MS;
  const onDisk = path.join(options.repoPath, options.filePath);
  const diskSize = await fileSize(onDisk);
  // The saved copy is read whole to judge the contents' encoding, so it is
  // held to the same limit either way.
  if (diskSize !== null && diskSize > BLAME_MAX_BYTES) return null;
  let contents: string | undefined;
  if (options.contents !== undefined) {
    const saved = diskSize === null ? null : await readFileOrNull(onDisk);
    const text = asSavedText(options.contents, saved);
    if (text === null && options.fallBackToDisk !== true) return null;
    if (text !== null) {
      if (Buffer.byteLength(text) > BLAME_MAX_BYTES) return null;
      // git's own test for binary: a NUL in the first 8000 bytes (buffer_is_binary).
      if (text.slice(0, 8000).includes("\0")) return null;
      contents = text;
    }
  }
  if (contents === undefined && diskSize === null) return null;

  // One listing answers both questions: no output means git doesn't track the
  // file, and `i/-text` / `w/-text` is git's verdict that the index or working
  // tree copy is binary. `attr/-text` is not: that attribute only switches off
  // EOL conversion, and a binary file shows as `-text` in the content columns
  // whatever its attributes say.
  const listed = await runWithin(options, deadline, ["ls-files", "--eol", "--", options.filePath]);
  if (listed?.kind !== "ok" || listed.exitCode !== 0) return null;
  const listing = listed.stdout.toString().split("\t")[0];
  if (listing.trim() === "" || /(?:^|\s)[iw]\/-text(?:\s|$)/.test(listing)) return null;

  const contentsArgs = contents === undefined ? [] : ["--contents", "-"];
  const blamed = await runWithin(
    options,
    deadline,
    ["blame", "--porcelain", ...contentsArgs, "--", options.filePath],
    contents
  );
  if (blamed?.kind !== "ok" || blamed.exitCode !== 0) return null;
  return parseBlamePorcelain(blamed.stdout.toString());
}

/**
 * The repository's effective `user.email`, for telling the user's own lines
 * apart; "" when unset, when git fails, or past the deadline. Read through
 * `spawnGit` rather than the simple-git client so it shares the blame lookup's
 * deadline.
 */
export async function readUserEmail(git: GitRunOptions): Promise<string> {
  const deadline = git.deadline ?? Date.now() + BLAME_TIMEOUT_MS;
  const result = await runWithin(git, deadline, ["config", "--get", "user.email"]);
  return result?.kind === "ok" && result.exitCode === 0 ? result.stdout.toString().trim() : "";
}

function readFileOrNull(filePath: string): Promise<Buffer | null> {
  return fs.promises.readFile(filePath).then(
    (bytes) => bytes,
    () => null
  );
}

function fileSize(filePath: string): Promise<number | null> {
  return fs.promises.stat(filePath).then(
    (stat) => stat.size,
    () => null
  );
}
