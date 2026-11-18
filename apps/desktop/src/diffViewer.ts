/* The main process's half of the diff viewer (#404): what a diff of a Tab is
 * made of — both sides' text, read here per the `defaultFileEncoding` setting
 * — sent to that Tab's page, which draws it over its graph
 * (packages/webview/src/desktop/diff/). The desktop `Opener` opens its two
 * diffs through here (ports/opener.ts); anything else of the app that shows
 * a diff of a Tab's repository — the working tree's files (#403), a file's
 * history (#408) — does too. */

import path from "node:path";

import type { DiffSide } from "@ging/core/extension/commitDiff";
import {
  FILE_TEXT_LIMIT,
  type FileText,
  readFileAtRevision,
  readWorkingFile
} from "@ging/core/extension/fileContents";
import type { L10n } from "@ging/core/host/ports";
import type { DiffHunks, ShowDiffMessage } from "@ging/webview/desktop/diff/protocol";

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

type DiffViewerDeps = {
  gitPath: () => string;
  /** Read for each diff: a change to the setting reaches the next one. */
  fileEncoding: () => string;
  l10n: L10n;
  /** The Tab's repository: the only one its diffs are read from. */
  repoRoot: () => string;
  /** Hand the Tab's page a message; false when there is no page to take it. */
  post: (message: ShowDiffMessage) => boolean;
};

/** A commit by its hash, a parent of one by `^` or `^N`, or the index. The
 *  request names them from what the page sent: nothing else — no ref name,
 *  nothing git could read as an option — is run. */
const REVISION = /^(?:[0-9a-f]{4,64}(?:\^\d*)?|:0)$/i;

/** Whether `inner` is `outer` or inside it; both absolute. */
function isWithin(outer: string, inner: string): boolean {
  const relative = path.relative(path.resolve(outer), path.resolve(inner));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** A `/`-separated path within its repository, which the page names the
 *  side by and the editor colours it by. */
function inRepo(repo: string, file: string): string {
  return path.relative(repo, file).split(path.sep).join("/");
}

export function createShowDiff(deps: DiffViewerDeps): ShowDiff {
  const { gitPath, fileEncoding, l10n, repoRoot, post } = deps;

  /** Refuse what this Tab may not read: another repository's files, or a
   *  revision that is not one (`REVISION`). */
  const check = (source: DiffSource): void => {
    const root = repoRoot();
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
  };

  const read = async (
    source: DiffSource,
    encoding: string
  ): Promise<{ path: string; file: FileText }> =>
    "empty" in source
      ? { path: source.empty, file: { kind: "text", text: "" } }
      : "revision" in source
        ? {
            path: source.revision.filePath,
            file: await readFileAtRevision(gitPath(), source.revision, encoding)
          }
        : {
            path: inRepo(source.repo, source.workingFile),
            file: await readWorkingFile(source.workingFile, encoding)
          };

  /** Why there is no text to compare, in one line; null when there is. */
  const whyNotShown = (files: FileText[]): string | null => {
    if (files.some((file) => file.kind === "binary")) return l10n.t("desktop.diff.binary");
    if (files.some((file) => file.kind === "tooLarge")) {
      return l10n.t("desktop.diff.tooLarge", FILE_TEXT_LIMIT / (1024 * 1024));
    }
    return null;
  };

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
    check(original);
    check(modified);
    const encoding = fileEncoding();
    const before = hunks === undefined ? null : await hunks();
    const [left, right] = await Promise.all([read(original, encoding), read(modified, encoding)]);
    const after = hunks === undefined ? null : await hunks();
    const notShown = whyNotShown([left.file, right.file]);
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
