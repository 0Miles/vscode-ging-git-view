/* The main process's half of the diff viewer (#404): what a diff of a Tab is
 * made of — both sides' text, read here per the `defaultFileEncoding` setting
 * — sent to that Tab's page, which draws it over its graph
 * (packages/webview/src/desktop/diff/). The desktop `Opener` opens its two
 * diffs through here (ports/opener.ts); anything else of the app that shows
 * a diff of a Tab's repository — the working tree's files (#403), a file's
 * history (#408) — does too. */

import path from "node:path";

import type { DiffSide } from "@ging/core/extension/commitDiff";
import { readFileAtRevision, readWorkingFile } from "@ging/core/extension/fileContents";
import type { L10n } from "@ging/core/host/ports";
import type { DiffDocument, ShowDiffMessage } from "@ging/webview/desktop/diff/protocol";

/** One side of a diff: a file at a revision — a commit, or `:0` for the index
 *  — or the working tree's file, by its absolute path. */
export type DiffSource = { revision: DiffSide } | { workingFile: string; repo: string };

export type DiffRequest = {
  /** What the diff is of, as VS Code titles its diff editor. */
  title: string;
  /** Before, on the left. */
  original: DiffSource;
  /** After, on the right. */
  modified: DiffSource;
  /** A 1-based line of `modified` to reveal and put the cursor on. */
  revealLine?: number;
};

/** Show a diff in the Tab's page. Resolves to whether it reached the page —
 *  false when it is gone — and rejects when a side could not be read. */
export type ShowDiff = (request: DiffRequest) => Promise<boolean>;

type DiffViewerDeps = {
  gitPath: () => string;
  /** Read for each diff: a change to the setting reaches the next one. */
  fileEncoding: () => string;
  l10n: L10n;
  /** Hand the Tab's page a message; false when there is no page to take it. */
  post: (message: ShowDiffMessage) => boolean;
};

/** A `/`-separated path within its repository, which the page names the
 *  side by and the editor colours it by. */
function inRepo(repo: string, file: string): string {
  return path.relative(repo, file).split(path.sep).join("/");
}

export function createShowDiff({ gitPath, fileEncoding, l10n, post }: DiffViewerDeps): ShowDiff {
  const read = async (source: DiffSource, encoding: string): Promise<DiffDocument> =>
    "revision" in source
      ? {
          path: source.revision.filePath,
          content: await readFileAtRevision(gitPath(), source.revision, encoding)
        }
      : {
          path: inRepo(source.repo, source.workingFile),
          content: await readWorkingFile(source.workingFile, encoding)
        };

  return async ({ title, original, modified, revealLine }) => {
    const encoding = fileEncoding();
    const [left, right] = await Promise.all([read(original, encoding), read(modified, encoding)]);
    return post({
      command: "showDiff",
      title,
      original: left,
      modified: right,
      revealLine: revealLine ?? null,
      strings: {
        sideBySide: l10n.t("desktop.diff.sideBySide"),
        inline: l10n.t("desktop.diff.inline"),
        close: l10n.t("desktop.diff.close"),
        cannotShow: l10n.t("desktop.diff.cannotShow")
      }
    });
  };
}
