import type { GitRunOptions } from "@ging/core/backend/gitRun";
import type { GitCommandHandler } from "@ging/core/backend/gitSpawn";
import {
  BLAME_TIMEOUT_MS,
  type BlameLine,
  blameFile,
  blameFileAtRevision,
  readUserEmail
} from "@ging/core/backend/queries/blameFile";
import type { L10n } from "@ging/core/host/ports";

import { type BlameAnnotationContext, blameAnnotationText } from "./blameAnnotation";
import { type BlameHoverIcon, blameHoverMarkdown, copyableSha } from "./blameHover";
import { createBlameHoverLookups } from "./blameHoverDetails";
import { lineChangeArgs, lineChangeDiff } from "./blameLineChange";
import { commitLocationArgs } from "./blameLocate";
import type { CommitDiffRequest } from "./commitDiff";
import { FILE_TEXT_LIMIT } from "./fileContents";

/** How long blaming one file may take, every git run in it together, before
 *  it is stopped and said to have failed. Longer than the inline blame's
 *  `BLAME_TIMEOUT_MS`: this one was asked for, and is waited for on screen. */
export const FILE_BLAME_MS = 60_000;

/** Which file to blame, by its `/`-separated path in the repository: as a
 *  commit has it (`revision`: a hash, `hash^`…), or the working tree's file
 *  on disk (`revision` null), whose lines not committed yet are said so. */
export type FileBlameTarget = { filePath: string; revision: string | null };

/** One commit a blamed file's lines come from, as its annotation reads. */
export type BlameAnnotationCommit = {
  /** The full hash; all zeros for lines not committed yet. */
  sha: string;
  uncommitted: boolean;
  /** `author, relative time • summary`, as `blameAnnotationText` writes it. */
  text: string;
};

/** A blamed file, as its annotations are drawn. */
export type BlameAnnotations = {
  /** The repository it is blamed in. */
  repo: string;
  /** Each commit of its lines, in the order of the line it first blames. */
  commits: BlameAnnotationCommit[];
  /** Each line of the file, in order: the index in `commits` of its commit. */
  lines: number[];
};

/** What a hover's links run, as the host names its commands; and the icons
 *  it draws, as the host's Markdown writes one. */
export type FileBlameHoverLinks = {
  copyShaCommand: string;
  openLineChangeCommand: string;
  locateCommitCommand: string;
  icon: (name: BlameHoverIcon) => string;
};

export type FileBlameServiceDeps = {
  gitPath: () => string;
  /** The repository its files are blamed in. */
  repo: () => string;
  gitEnv?: () => NodeJS.ProcessEnv;
  onCommand?: GitCommandHandler;
  l10n: L10n;
  /** The UI's language, for relative and absolute times (`en`, `zh-tw`). */
  locale: string;
  links: FileBlameHoverLinks;
  /** The current time, in milliseconds since the epoch; `Date.now` unless a
   *  test says. */
  now?: () => number;
  /** `FILE_BLAME_MS` and `FILE_TEXT_LIMIT`, unless a test says less. */
  timeoutMs?: number;
  maxBytes?: number;
};

/** What a file's blame came to: its annotations, or why there are none
 *  (`failed`: git could not blame it — too big, too slow, not there). */
export type FileBlameAnswer =
  | { kind: "blamed"; annotations: BlameAnnotations }
  | { kind: "failed" };

export type FileBlameService = {
  /** Blame `target`, in place of any file blamed before — stopping its git.
   *  Null when another was opened, or `close` called, before it was done:
   *  nobody waits for it. */
  open(target: FileBlameTarget): Promise<FileBlameAnswer | null>;
  /** The hover of line `line` (0-based) of the file blamed last, as Markdown
   *  with the host's commands and icons (`blameHoverMarkdown`); null when
   *  there is no such line, or another file is blamed by the time its
   *  details are in. */
  hover(line: number): Promise<string | null>;
  /** The diff a hover's "open this line's change" link asks for, its
   *  argument checked to be of the repository blamed in (`lineChangeArgs`);
   *  null for any other. */
  lineChange(arg: unknown): CommitDiffRequest | null;
  /** The commit a hover's "locate in the graph" link, or a click on an
   *  annotation, asks for, checked as `commitLocationArgs` does; null for
   *  any other. */
  locate(arg: unknown): string | null;
  /** The full hash a hover's SHA link asks to copy; null for anything else. */
  copySha(arg: unknown): string | null;
  /** Stop blaming, and looking anything up: nothing is shown any more. */
  close(): void;
};

/**
 * A file's blame as one screen shows it (#409): one file at a time, blamed
 * whole, each line's annotation the inline blame's (`blameAnnotationText`)
 * and its hover the inline blame's too (`blameHoverMarkdown`), only drawn by
 * another host. Opening another file, or closing, stops the git of the one
 * before.
 */
export function createFileBlameService(deps: FileBlameServiceDeps): FileBlameService {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? FILE_BLAME_MS;
  const maxBytes = deps.maxBytes ?? FILE_TEXT_LIMIT;
  /** The file blamed last, and what stops its git. */
  let open: { abort: AbortController; repo: string; blame: FileBlame | null } | null = null;

  /** Where and how a git run happens in `repo`, ending within `ms`. */
  const gitIn = (repo: string, ms: number, signal?: AbortSignal): GitRunOptions => ({
    gitPath: deps.gitPath(),
    repoPath: repo,
    deadline: Date.now() + ms,
    onCommand: deps.onCommand,
    gitEnv: deps.gitEnv?.(),
    signal
  });
  const lookups = createBlameHoverLookups({ gitIn: (repo) => gitIn(repo, BLAME_TIMEOUT_MS) });

  const labels = () => ({
    you: deps.l10n.t("blame.you"),
    uncommitted: deps.l10n.t("blame.uncommitted")
  });
  const context = (userEmail: string): BlameAnnotationContext => ({
    now: now(),
    locale: deps.locale,
    userEmail,
    labels: labels()
  });

  function stop() {
    open?.abort.abort();
    open = null;
    lookups.cancel();
  }

  return {
    async open(target) {
      stop();
      const repo = deps.repo();
      const mine = { abort: new AbortController(), repo, blame: null as FileBlame | null };
      open = mine;
      // One deadline for every git run of it, user.email included.
      const git = gitIn(repo, timeoutMs, mine.abort.signal);
      const [lines, userEmail] = await Promise.all([
        target.revision === null
          ? blameFile({ ...git, filePath: target.filePath, maxBytes })
          : blameFileAtRevision({
              ...git,
              filePath: target.filePath,
              revision: target.revision,
              maxBytes
            }),
        readUserEmail(git)
      ]);
      if (open !== mine) return null;
      if (lines === null) return { kind: "failed" };
      mine.blame = { lines, userEmail };
      return { kind: "blamed", annotations: annotate(repo, lines, context(userEmail)) };
    },
    async hover(index) {
      const shown = open;
      const line = shown?.blame?.lines[index];
      if (shown === null || shown.blame === null || line === undefined) return null;
      const details = line.uncommitted
        ? { message: null, hunk: null, avatar: null }
        : await lookups.details(line, shown.repo);
      if (open !== shown) return null;
      const t = (key: string) => deps.l10n.t(key);
      return blameHoverMarkdown(line, details, {
        ...context(shown.blame.userEmail),
        labels: {
          ...labels(),
          changes: t("blame.hover.changes"),
          copyHash: t("blame.hover.copyHash"),
          openLineChange: t("blame.hover.openLineChange"),
          locateCommit: t("blame.hover.locateCommit")
        },
        repo: shown.repo,
        ...deps.links
      });
    },
    // Checked against the repository, not the file open: a click that closes
    // the view as it locates the commit must still be taken.
    lineChange(arg) {
      const change = lineChangeArgs(arg, [deps.repo()]);
      return change === null ? null : lineChangeDiff(change);
    },
    locate(arg) {
      return commitLocationArgs(arg, [deps.repo()])?.sha ?? null;
    },
    copySha: copyableSha,
    close: stop
  };
}

type FileBlame = { lines: BlameLine[]; userEmail: string };

/** Each line's commit, by its index among the commits' annotations. */
function annotate(repo: string, lines: BlameLine[], context: BlameAnnotationContext) {
  const commits: BlameAnnotationCommit[] = [];
  const index = new Map<string, number>();
  const at = lines.map((line) => {
    let i = index.get(line.sha);
    if (i === undefined) {
      i = commits.length;
      index.set(line.sha, i);
      commits.push({
        sha: line.sha,
        uncommitted: line.uncommitted,
        text: blameAnnotationText(line, context)
      });
    }
    return i;
  });
  return { repo, commits, lines: at };
}
