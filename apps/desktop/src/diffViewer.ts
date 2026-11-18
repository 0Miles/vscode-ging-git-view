/* The main process's half of the diff viewer (#404): what a diff of a Tab is
 * made of — both sides' text, read here per the `defaultFileEncoding` setting
 * — sent to that Tab's page, which draws it over its graph
 * (packages/webview/src/desktop/diff/). The desktop `Opener` opens its two
 * diffs through here (ports/opener.ts); anything else of the app that shows
 * a diff of a Tab's repository — the working tree's files (#403), a file's
 * history (#408) — does too. So does one file shown read-only (#405): read,
 * and refused, by the same rules as a diff's side, and offered to be blamed
 * (#409, fileBlame.ts). */

import path from "node:path";

import {
  type CommitDiffRequest,
  type DiffSide,
  commitDiffView
} from "@ging/core/extension/commitDiff";
import {
  FILE_TEXT_LIMIT,
  type FileText,
  readFileAtRevision,
  readWorkingFile
} from "@ging/core/extension/fileContents";
import type { L10n } from "@ging/core/host/ports";
import type { FileBlameOffer } from "@ging/webview/desktop/diff/blameProtocol";
import type {
  DiffHunks,
  ShowDiffMessage,
  ShowFileMessage
} from "@ging/webview/desktop/diff/protocol";

/** One side of a diff: a file at a revision — a commit by its hash, with
 *  `^`/`^N` for a parent, or `:0` for the index — or the working tree's file,
 *  by its absolute path; or no file at all, named by its path in the
 *  repository: what a branch with no commit yet has before the index (#460). */
export type DiffSource =
  | { revision: DiffSide }
  | { workingFile: string; repo: string }
  | { empty: string };

/** What a diff offers to stage or unstage one hunk at a time (#406): the
 *  hunks, or why there are none, in a line to say over the diff (`null`:
 *  nothing to say). */
export type HunkRead = { hunks: DiffHunks } | { why: string | null };

export type DiffRequest = {
  /** What the diff is of, as VS Code titles its diff editor. */
  title: string;
  /** Before, on the left. */
  original: DiffSource;
  /** After, on the right. */
  modified: DiffSource;
  /** A 1-based line of `modified` to reveal and put the cursor on. */
  revealLine?: number;
  /** The diff's hunks, for a diff of the working tree (#406). Read before
   *  and after the two sides: offered only when both reads name the same
   *  diff, so the hunks are placed on the very text shown. */
  hunks?: () => Promise<HunkRead>;
  /** A line to say over the diff: what became of the last hunk asked for. */
  said?: string;
  /** The page's diff the hunk was asked from (`DiffHunkRequest.asked`): the
   *  page shows this one only while that one is still shown. */
  answers?: number;
};

/** Show a diff in the Tab's page. Resolves to whether it reached the page —
 *  false when it is gone — and rejects when a side could not be read, or
 *  names what this Tab may not read (see `createShowDiff`). */
export type ShowDiff = (request: DiffRequest) => Promise<boolean>;

export type FileRequest = {
  /** What the file is, as a diff of it is titled: `file.txt (abc1234)`. */
  title: string;
  /** The file: at a revision, or the working tree's. */
  file: DiffSource;
  /** Show its blame at once (#409), whatever the page's toggle was left at. */
  showBlame?: boolean;
};

/** What a file shown offers its page to blame it by (#409): null when it
 *  cannot be blamed. Called for each file shown with text. */
export type OfferBlame = (
  file: DiffSource,
  shownPath: string,
  show: boolean
) => FileBlameOffer | null;

/** Show one file, read-only, in the Tab's page (#405). Resolves and rejects
 *  as `ShowDiff` does. */
export type ShowFile = (request: FileRequest) => Promise<boolean>;

type ViewerDeps<Message> = {
  gitPath: () => string;
  /** Read for each diff or file: a change to the setting reaches the next. */
  fileEncoding: () => string;
  l10n: L10n;
  /** The Tab's repository: the only one its diffs and files are read from. */
  repoRoot: () => string;
  /** Hand the Tab's page a message; false when there is no page to take it. */
  post: (message: Message) => boolean;
};

/** A commit by its hash, a parent of one by `^` or `^N`, or the index. The
 *  request names them from what the page sent: nothing else — no ref name,
 *  nothing git could read as an option — is run. */
const REVISION = /^(?:[0-9a-f]{4,64}(?:\^\d*)?|:0)$/i;

/** Whether `inner` is `outer` or inside it; both absolute. */
export function isWithin(outer: string, inner: string): boolean {
  const relative = path.relative(path.resolve(outer), path.resolve(inner));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** A commit's change to a file, as the diff viewer shows it: titled and
 *  labelled as VS Code's diff editor is, its line to reveal (if any) kept. */
export function commitDiffRequest(diff: CommitDiffRequest, l10n: Pick<L10n, "t">): DiffRequest {
  const view = commitDiffView(diff, {
    addedIn: (abbrevHash) => l10n.t("diff.addedIn", abbrevHash),
    deletedIn: (abbrevHash) => l10n.t("diff.deletedIn", abbrevHash)
  });
  return {
    title: view.title,
    original: { revision: view.left },
    modified: { revision: view.right },
    // The view counts from 0, as an editor does; the page from 1.
    ...(view.reveal === null ? {} : { revealLine: view.reveal + 1 })
  };
}

/** A `/`-separated path within its repository, which the page names the
 *  side by and the editor colours it by. */
function inRepo(repo: string, file: string): string {
  return path.relative(repo, file).split(path.sep).join("/");
}

/** Refuse what a Tab on `root` may not read: another repository's files, or
 *  a revision that is not one (`REVISION`). */
function check(root: string, source: DiffSource): void {
  if ("empty" in source) return;
  if ("revision" in source) {
    const { repo, commit } = source.revision;
    if (path.relative(path.resolve(root), path.resolve(repo)) !== "") {
      throw new Error(`${repo} is not this Tab's repository`);
    }
    if (!REVISION.test(commit)) throw new Error(`${commit} is not a revision a diff reads`);
  } else if (!isWithin(root, source.workingFile) || !isWithin(root, source.repo)) {
    throw new Error(`${source.workingFile} is not in this Tab's repository`);
  }
}

/** `source`'s text, decoded as `encoding`, and the path the page names it by. */
async function read(
  gitPath: string,
  source: DiffSource,
  encoding: string
): Promise<{ path: string; file: FileText }> {
  if ("empty" in source) return { path: source.empty, file: { kind: "text", text: "" } };
  return "revision" in source
    ? {
        path: source.revision.filePath,
        file: await readFileAtRevision(gitPath, source.revision, encoding)
      }
    : {
        path: inRepo(source.repo, source.workingFile),
        file: await readWorkingFile(source.workingFile, encoding)
      };
}

/** Why there is no text to show, in one line — a binary file said as
 *  `binaryKey` says it; null when there is. */
function whyNotShown(l10n: L10n, files: FileText[], binaryKey: string): string | null {
  if (files.some((file) => file.kind === "binary")) return l10n.t(binaryKey);
  if (files.some((file) => file.kind === "tooLarge")) {
    return l10n.t("desktop.diff.tooLarge", FILE_TEXT_LIMIT / (1024 * 1024));
  }
  return null;
}

export function createShowDiff(deps: ViewerDeps<ShowDiffMessage>): ShowDiff {
  const { gitPath, fileEncoding, l10n, repoRoot, post } = deps;

  /** The hunks to offer on `texts`, or why none are: only when the reads
   *  before and after the texts name the same diff — the file did not change
   *  between them — and the editor counts lines as git does. */
  const offer = (
    before: HunkRead | null,
    after: HunkRead | null,
    texts: string[] | null
  ): { hunks?: DiffHunks; said?: string } => {
    if (after === null) return {};
    if (!("hunks" in after)) return after.why === null ? {} : { said: after.why };
    // Binary, or too large: said already, in place of the editor.
    if (texts === null) return {};
    if (!(before !== null && "hunks" in before && before.hunks.token === after.hunks.token)) {
      return { said: l10n.t("desktop.diff.changing") };
    }
    // A carriage return alone ends a line for the editor and not for git:
    // the hunks would be drawn on the wrong lines.
    if (texts.some((text) => /\r(?!\n)/.test(text)))
      return { said: l10n.t("desktop.diff.noHunks") };
    return { hunks: after.hunks };
  };

  return async ({ title, original, modified, revealLine, hunks, said, answers }) => {
    check(repoRoot(), original);
    check(repoRoot(), modified);
    const encoding = fileEncoding();
    const before = hunks === undefined ? null : await hunks();
    const [left, right] = await Promise.all([
      read(gitPath(), original, encoding),
      read(gitPath(), modified, encoding)
    ]);
    const after = hunks === undefined ? null : await hunks();
    const notShown = whyNotShown(l10n, [left.file, right.file], "desktop.diff.binary");
    const text = (file: FileText) => (notShown === null && file.kind === "text" ? file.text : "");
    const offered = offer(
      before,
      after,
      notShown === null ? [text(left.file), text(right.file)] : null
    );
    const line = said ?? offered.said;
    return post({
      command: "showDiff",
      title,
      original: { path: left.path, content: text(left.file) },
      modified: { path: right.path, content: text(right.file) },
      revealLine: revealLine ?? null,
      notShown,
      strings: {
        sideBySide: l10n.t("desktop.diff.sideBySide"),
        inline: l10n.t("desktop.diff.inline"),
        close: l10n.t("desktop.diff.close"),
        cannotShow: l10n.t("desktop.diff.cannotShow")
      },
      ...(offered.hunks !== undefined && { hunks: offered.hunks }),
      ...(line !== undefined && { said: line }),
      ...(answers !== undefined && { answers })
    });
  };
}

export function createShowFile(
  deps: ViewerDeps<ShowFileMessage> & { offerBlame?: OfferBlame }
): ShowFile {
  const { gitPath, fileEncoding, l10n, repoRoot, post } = deps;

  return async ({ title, file, showBlame }) => {
    check(repoRoot(), file);
    const shown = await read(gitPath(), file, fileEncoding());
    const notShown = whyNotShown(l10n, [shown.file], "desktop.file.binary");
    // Only text has lines to blame.
    const blame =
      notShown === null ? (deps.offerBlame?.(file, shown.path, showBlame === true) ?? null) : null;
    return post({
      command: "showFile",
      title,
      file: {
        path: shown.path,
        content: notShown === null && shown.file.kind === "text" ? shown.file.text : ""
      },
      notShown,
      strings: {
        close: l10n.t("desktop.file.close"),
        cannotShow: l10n.t("desktop.file.cannotShow")
      },
      ...(blame !== null && { blame })
    });
  };
}
