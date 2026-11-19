import * as fs from "node:fs";
import * as path from "node:path";

import { type GitCommandHandler, spawnGit } from "@ging/core/backend/gitSpawn";

/** The repository `cloneRepository` made. */
export type ClonedRepo = {
  /** Its top folder, as git spells it (forward slashes): how every repository
   *  the graph knows is spelled. */
  repo: string;
};

/** Where git says a clone has got to: one of its progress lines. */
export type CloneProgress = {
  /** The line as git wrote it, without the `remote: ` it puts before what the
   *  remote reports: `Receiving objects:  45% (9/20), 1.20 MiB | 1.00 MiB/s`. */
  text: string;
  /** How far through that stage, 0 to 100. */
  percent: number;
};

/** Why a text is no URL to clone; see `cloneUrlProblem`. */
export type CloneUrlProblem =
  | "empty"
  /** Starts with `-`, or its host or user does: git would read it as an
   *  option, or hand it to ssh as one (`ssh://-oProxyCommand=…`). */
  | "option"
  /** `<transport>::<address>`: git hands it to a program of that name
   *  (`git-remote-<transport>`), `ext::` running any command it is given. */
  | "transport"
  /** A control character: a newline would split git's credential requests. */
  | "control"
  /** A URL of a scheme other than git's own network ones and `file`. */
  | "scheme"
  /** Neither a URL, nor `host:path`, nor a full path: a relative path would
   *  be read against wherever git happens to run. */
  | "relative"
  /** No folder name can be made from it. */
  | "noName";

/** The URL schemes a clone may name: git's own, its ssh spellings, and the
 *  local `file` one. Anything else reaches a remote helper of that name. */
const SCHEMES: ReadonlySet<string> = new Set([
  "http",
  "https",
  "ssh",
  "git",
  "file",
  "git+ssh",
  "ssh+git"
]);
const SCHEME_URL = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;
/** git's `<transport>::<address>`: the transport is what git allows in a scheme. */
const TRANSPORT = /^[A-Za-z][A-Za-z0-9+.-]*::/;
/** A full path on this computer: a drive's, a share's, or from `/`. */
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;
/** git's scp-like `[user@]host:path`: a colon before any slash, after a host
 *  of more than one letter (one letter is a Windows drive). */
const SCP_LIKE = /^(?:[^@/\\:]+@)?[^@/\\:]{2,}:/;
// eslint-disable-next-line no-control-regex -- control characters are what it finds
const CONTROL = /[\u0000-\u001f\u007f]/;

/** `text` with its %-escapes undone, as git undoes them in a URL's host and
 *  user; as it is when they do not decode. */
function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The user and host `url` names, when it names any: a URL's authority, or
 *  scp-like `[user@]host:`. */
function userAndHost(url: string): string[] {
  const scheme = SCHEME_URL.exec(url);
  if (scheme !== null) {
    const rest = url.slice(scheme[0].length);
    const authority = rest.slice(0, rest.search(/[\\/]|$/));
    const at = authority.lastIndexOf("@");
    const user = at === -1 ? [] : [authority.slice(0, at).split(":")[0]];
    return [...user, authority.slice(at + 1)];
  }
  const scp = /^(?:([^@/\\:]+)@)?([^@/\\:]+):/.exec(url);
  return scp === null ? [] : [scp[1] ?? "", scp[2]];
}

/** A host or user that ssh would take for an option: git turns most of them
 *  away itself ("strange hostname", git 2.14.1 on), but nothing here counts
 *  on the git a user happens to have. */
const optionLike = (url: string) =>
  userAndHost(url).some((part) => decoded(part).trimStart().startsWith("-"));

/**
 * Why `url` is not one to clone, or `null` when it is: a URL of git's own
 * network schemes or `file://`, git's scp-like `host:path`, or a full path on
 * this computer, which names a folder to put the clone in (`cloneFolderName`).
 * What is turned away either runs something other than git's own transports
 * (`ext::sh -c …`, a `fd::` or any other remote helper) or would be read as
 * something it is not (`--upload-pack=…` as an option, a relative path
 * against wherever git runs).
 */
export function cloneUrlProblem(url: string): CloneUrlProblem | null {
  if (url === "") return "empty";
  if (CONTROL.test(url)) return "control";
  if (url.startsWith("-") || optionLike(url)) return "option";
  if (TRANSPORT.test(url)) return "transport";
  const scheme = SCHEME_URL.exec(url)?.[1];
  if (scheme !== undefined) {
    if (!SCHEMES.has(scheme.toLowerCase())) return "scheme";
  } else if (!ABSOLUTE_PATH.test(url) && !SCP_LIKE.test(url)) {
    return "relative";
  }
  return cloneFolderName(url) === null ? "noName" : null;
}

/** What Windows will not have in a file name, and what no name should have. */
// eslint-disable-next-line no-control-regex -- control characters are among them
const NOT_IN_A_NAME = /[<>:"|?*\u0000-\u001f\u007f]+/g;

/**
 * The folder git would clone `url` into when given none (git's
 * `git_url_basename`, as far as a URL `cloneUrlProblem` takes goes): the
 * last part of its path, without a trailing `/`, `/.git` or `.git`; with no
 * path, the host's name. `null` when that leaves no name.
 */
export function cloneFolderName(url: string): string | null {
  let rest = url
    .trim()
    .replace(/[\\/]+$/, "")
    .replace(/[\\/]\.git$/, "")
    .replace(/[\\/]+$/, "");
  const scheme = SCHEME_URL.exec(rest);
  if (scheme !== null) {
    rest = rest.slice(scheme[0].length);
    // Only an authority: the host is the name, without who and which port.
    if (!/[\\/]/.test(rest)) rest = rest.replace(/^.*@/, "").replace(/:\d*$/, "");
  }
  const last = rest.split(/[\\/:]/).at(-1) ?? "";
  const name = last
    .replace(/\.git$/, "")
    .replace(NOT_IN_A_NAME, "-")
    // Windows drops a name's trailing dots and spaces.
    .replace(/[. ]+$/, "");
  return name === "" || name === "." || name === ".." ? null : name;
}

/** A scheme URL split at the `@` that ends its authority's user info: the
 *  `scheme://` before it, the scheme's name, the user info and all after the
 *  `@`. `null` for a URL with no scheme or no `@` in its authority. */
function splitUserInfo(
  url: string
): { prefix: string; scheme: string; userInfo: string; afterAt: string } | null {
  const scheme = SCHEME_URL.exec(url);
  if (scheme === null) return null;
  const rest = url.slice(scheme[0].length);
  const slash = rest.search(/[\\/]/);
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const at = authority.lastIndexOf("@");
  if (at === -1) return null;
  return {
    prefix: scheme[0],
    scheme: scheme[1],
    userInfo: authority.slice(0, at),
    afterAt: rest.slice(at + 1)
  };
}

/** `url` with any user name and password taken out, to be shown or logged:
 *  `https://user:token@host/repo` must not end up in a log file. */
export function urlWithoutCredentials(url: string): string {
  const parts = splitUserInfo(url);
  return parts === null ? url : parts.prefix + parts.afterAt;
}

/**
 * Whether `url` carries a secret git would save as it is in the clone's
 * `.git/config` (#471): over http(s), any user name and password at all,
 * since a token may stand alone in the user field; over any other scheme,
 * only a password (`ssh://git:secret@`), an ssh user name being no secret.
 * git's scp-like `user@host:path` and a path name none.
 */
export function urlHasCredentials(url: string): boolean {
  const parts = splitUserInfo(url);
  if (parts === null || parts.userInfo === "") return false;
  return /^https?$/i.test(parts.scheme) || parts.userInfo.includes(":");
}

/**
 * Point `repo`'s `origin` at `url` without its user name and password
 * (`urlWithoutCredentials`), so that they are no longer in its
 * `.git/config` (#471). Answers whether git did; what it said is not
 * answered, lest it repeat the URL.
 */
export async function removeCredentialsFromRemote({
  gitPath,
  repo,
  url,
  onCommand
}: {
  gitPath: string;
  repo: string;
  url: string;
  onCommand?: GitCommandHandler;
}): Promise<boolean> {
  const result = await spawnGit({
    gitPath,
    cwd: repo,
    args: ["remote", "set-url", "--", "origin", urlWithoutCredentials(url)],
    onCommand
  });
  return result.kind === "ok" && result.exitCode === 0;
}

/** A progress line: a stage, then how far through it in percent. */
const PROGRESS_LINE = /^(?:remote: )?([^:]+):\s+(\d{1,3})%/;
/** What git and the remote say of a clone along the way that is no failure. */
const NOT_A_FAILURE = [PROGRESS_LINE, /^Cloning into /, /^remote: (?:Enumerating objects|Total) /];

/** The progress lines in `lines`, as `CloneProgress`. */
function progressIn(lines: readonly string[]): CloneProgress[] {
  return lines.flatMap((line) => {
    const match = PROGRESS_LINE.exec(line);
    return match === null
      ? []
      : [{ text: line.replace(/^remote: /, "").trim(), percent: Number(match[2]) }];
  });
}

/** `stderr` without the lines that tell how the clone was going, which say
 *  nothing about why it failed (`formatGitError` would pick a `remote:`
 *  progress line over git's own `fatal:`). */
function failureText(stderr: string): string {
  return stderr
    .split(/\r\n|\r|\n/)
    .filter((line) => !NOT_A_FAILURE.some((pattern) => pattern.test(line)))
    .join("\n");
}

/** A URL `cloneUrlProblem` turns away. */
export class CloneUrlError extends Error {
  constructor(
    readonly url: string,
    readonly problem: CloneUrlProblem
  ) {
    super(`${urlWithoutCredentials(url)} is not a URL to clone (${problem})`);
    this.name = "CloneUrlError";
  }
}

/** A folder no clone goes into: one that is there and is not an empty
 *  folder, or one whose parent folder is not there. */
export class CloneFolderError extends Error {
  constructor(
    readonly folder: string,
    readonly why: "notEmpty" | "noParent"
  ) {
    super(`cannot clone into ${folder} (${why})`);
    this.name = "CloneFolderError";
  }
}

/** git failed, or could not be started. The message is what it said, without
 *  its progress, for `formatGitError` to read. */
export class CloneFailedError extends Error {
  constructor(
    message: string,
    /** What the clone made could not all be removed: it is still there. */
    readonly leftBehind: boolean
  ) {
    super(message);
    this.name = "CloneFailedError";
  }
}

/** The clone was cancelled: git was sent a kill, and what it made removed. */
export class CloneCancelledError extends Error {
  constructor(
    /** What the clone made could not all be removed: it is still there. */
    readonly leftBehind: boolean
  ) {
    super("the clone was cancelled");
    this.name = "CloneCancelledError";
  }
}

export type CloneOptions = {
  gitPath: string;
  /** Checked first (`cloneUrlProblem`); passed to git as it is. */
  url: string;
  /** Where the repository goes: a folder that is not there yet, or an empty
   *  one, in a folder that is there. */
  folder: string;
  /** Cancels the clone: git is sent a kill (best-effort, ADR-0028) and what
   *  it made is removed. */
  signal?: AbortSignal;
  /** Told each progress line git writes, as it writes it. */
  onProgress?: (progress: CloneProgress) => void;
  /** Layered over git's environment: the askpass route of whoever asks for
   *  the credentials. */
  gitEnv?: NodeJS.ProcessEnv;
  onCommand?: GitCommandHandler;
};

/** What `folder` holds now: `null` when it is not there, `[]` when it is an
 *  empty folder, and the entries of a folder or a file's name otherwise. */
async function contentsOf(folder: string): Promise<string[] | null> {
  try {
    return await fs.promises.readdir(folder);
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    // A file, or something unreadable: nothing to clone into either way.
    return [path.basename(folder)];
  }
}

/** Remove `target` and everything in it. A git that was just sent a kill may
 *  still hold a file a moment longer, or write one more (Windows refuses to
 *  remove a file that is open): `fs.rm` tries again for a few seconds. git
 *  makes its objects read-only, which on Windows some Node builds do not
 *  remove: those are made writable and tried once more. */
async function removeAll(target: string): Promise<boolean> {
  const rm = () =>
    fs.promises.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  try {
    await rm();
    return true;
  } catch {
    await makeWritable(target);
    return rm().then(
      () => true,
      () => false
    );
  }
}

async function makeWritable(target: string): Promise<void> {
  const entries = await fs.promises.readdir(target, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries.map((entry) => {
      const full = path.join(target, entry.name);
      // A link is followed by chmod: out of the clone, perhaps.
      if (entry.isSymbolicLink()) return undefined;
      if (entry.isDirectory()) return makeWritable(full);
      return fs.promises.chmod(full, 0o666).catch(() => {});
    })
  );
}

/** Take away what a clone that did not finish made in `folder`: the folder
 *  itself when it was not there before, or else what is in it now. Answers
 *  whether all of it went. */
async function removeWhatCloneMade(folder: string, existed: boolean): Promise<boolean> {
  if (!existed) return removeAll(folder);
  const entries = (await contentsOf(folder)) ?? [];
  await Promise.all(entries.map((entry) => removeAll(path.join(folder, entry))));
  // Looked at again rather than taken from the removals: whatever came after
  // the listing is still there, and is not to be said gone.
  return ((await contentsOf(folder)) ?? []).length === 0;
}

/** How long a cancelled clone's git is given to be gone before what it made
 *  is removed: a process that escaped the kill (ADR-0028) is not waited for
 *  past it. */
export const CANCELLED_GIT_GRACE_MS = 5000;

/**
 * Clone `url` into `folder` (#395): `git clone --progress -- <url> <folder>`,
 * run in the folder `folder` goes in. The URL is checked first
 * (`cloneUrlProblem`), and so is the folder, before git runs: it must not be
 * there yet, or be an empty folder, and its parent must be there. git's
 * `ext::` transport is turned off on the command line as well, whatever the
 * user's config says.
 *
 * A clone that fails or is cancelled leaves nothing behind it made: git
 * cleans up after its own failures, but not after a kill. So whatever it
 * made is removed here — the folder when it was not there before, or else
 * what is in it — and only that.
 *
 * Answers the repository; throws `CloneUrlError`, `CloneFolderError`,
 * `CloneCancelledError` or `CloneFailedError`.
 */
export async function cloneRepository({
  gitPath,
  url,
  folder,
  signal,
  onProgress,
  gitEnv,
  onCommand
}: CloneOptions): Promise<ClonedRepo> {
  const problem = cloneUrlProblem(url);
  if (problem !== null) throw new CloneUrlError(url, problem);
  const parent = path.dirname(folder);
  if (!(await contentsOf(parent))) throw new CloneFolderError(folder, "noParent");
  const before = await contentsOf(folder);
  if (before !== null && before.length > 0) throw new CloneFolderError(folder, "notEmpty");

  // A line can come in two pieces: the part after the last line end waits.
  let pending = "";
  const result = await spawnGit({
    gitPath,
    cwd: parent,
    args: ["-c", "protocol.ext.allow=never", "clone", "--progress", "--", url, folder],
    signal,
    // A cancel must reach the remote helper too, or its connection stays.
    ownProcessGroup: true,
    gitEnv,
    onCommand,
    onStderr: (text) => {
      const lines = (pending + text).split(/\r\n|\r|\n/);
      pending = lines.pop() ?? "";
      for (const progress of progressIn(lines)) onProgress?.(progress);
    }
  });

  if (result.kind === "ok" && result.exitCode === 0) {
    const top = await spawnGit({
      gitPath,
      cwd: folder,
      args: ["rev-parse", "--show-toplevel"],
      gitEnv,
      onCommand
    });
    if (top.kind === "ok" && top.exitCode === 0) return { repo: top.stdout.toString().trim() };
    // Cloned, and yet no working tree git will say the top of: whatever it
    // is, it is not what was asked for, so it goes too.
  }
  if (result.kind === "aborted") {
    // Sent a kill, settled at once (ADR-0028): git, or index-pack under it,
    // may still be writing. Removing now would miss what comes after.
    let grace: NodeJS.Timeout | undefined;
    await Promise.race([
      result.exited,
      new Promise((done) => {
        grace = setTimeout(done, CANCELLED_GIT_GRACE_MS);
      })
    ]);
    clearTimeout(grace);
  }
  const removed = await removeWhatCloneMade(folder, before !== null);
  switch (result.kind) {
    case "aborted":
      throw new CloneCancelledError(!removed);
    case "error":
      throw new CloneFailedError(result.error.message, !removed);
    case "timeout":
      // No timeout is given: a clone takes as long as it takes.
      throw new CloneFailedError("git timed out", !removed);
    case "ok":
      throw new CloneFailedError(
        failureText(result.stderr) || "git made no working tree",
        !removed
      );
  }
}
