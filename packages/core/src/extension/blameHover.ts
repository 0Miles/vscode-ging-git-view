import { type HunkExcerpt, hunkWindow } from "@ging/core/backend/queries/blameCommitChange";
import type { BlameLine } from "@ging/core/backend/queries/blameFile";
import { abbrevCommit, isCommitHash } from "@ging/core/backend/utils/string";

import { type BlameAnnotationContext, isUser, relativeTime } from "./blameAnnotation";
import { lineChangeOf } from "./blameLineChange";
import type { CommitLocation } from "./blameLocate";

const AVATAR_SIZE = 16;

/** What the hover knows beyond the blame itself, each part null until (or
 *  unless) it is there. */
export type BlameHoverDetails = {
  /** The commit's full message; the blame's summary stands in until then. */
  message: string | null;
  /** The commit's hunk holding the line, shown cut to its excerpt (see
   *  `hunkWindow`). */
  hunk: HunkExcerpt | null;
  /** An image URI of the author's avatar; the account icon stands in without. */
  avatar: string | null;
};

/** What the annotation is drawn with, and the rest the hover needs. */
export type BlameHoverContext = BlameAnnotationContext & {
  /** The time zone to show the absolute time in; the system's by default. */
  timeZone?: string;
  /** The annotation's labels, plus `changes` before the SHAs, `copyHash`,
   *  their tooltip, `openLineChange`, the link to the line's change, and
   *  `locateCommit`, the link to the commit's place in the graph. */
  labels: BlameAnnotationContext["labels"] & {
    changes: string;
    copyHash: string;
    openLineChange: string;
    locateCommit: string;
  };
  /** The known repository the line is blamed in. */
  repo: string;
  /** The command a SHA link runs, given the full SHA. */
  copyShaCommand: string;
  /** The command the line's change link runs, given its `LineChange`. */
  openLineChangeCommand: string;
  /** The command the graph link runs, given its `CommitLocation`. */
  locateCommitCommand: string;
};

/**
 * The hover card of a blamed line, as Markdown with theme icons: the author's
 * avatar (or the account icon), the author or `labels.you`, relative and
 * absolute time, the full commit message, the commit's hunk holding the line,
 * `Changes <previous> ↔ <commit>` with each SHA a link that copies it — only
 * the commit for one without a previous — a link that opens the line's change
 * in a diff editor (see `lineChangeDiff`), and one that locates the commit in
 * the GING graph of that repository. A line not committed yet says
 * just that. Author and message are shown as text: nothing in them is read as
 * Markdown, HTML or an icon.
 */
export function blameHoverMarkdown(
  line: BlameLine,
  details: BlameHoverDetails,
  context: BlameHoverContext
): string {
  const { labels } = context;
  if (line.uncommitted) return escapeText(labels.uncommitted);

  const avatar =
    details.avatar === null
      ? "$(account)"
      : `![](${details.avatar}|width=${AVATAR_SIZE},height=${AVATAR_SIZE})`;
  const author = isUser(line.authorEmail, context.userEmail) ? labels.you : line.authorName;
  const relative = relativeTime(context.now / 1000 - line.authorTime, context.locale);
  const absolute = dateTimeFormat(context.locale, context.timeZone).format(
    new Date(line.authorTime * 1000)
  );
  const sections = [
    `${avatar} **${escapeText(author)}**, ${escapeText(relative)} (${escapeText(absolute)})`,
    escapeText(details.message ?? line.summary)
  ];
  if (details.hunk !== null) sections.push(diffBlock(hunkWindow(details.hunk).lines));
  sections.push("---");

  const shaLink = (sha: string) =>
    `[\`${abbrevCommit(sha)}\`](command:${context.copyShaCommand}?` +
    `${commandArgs(sha)} "${labels.copyHash.replace(/"/g, "'")}")`;
  const shas =
    line.previous === null
      ? shaLink(line.sha)
      : `${shaLink(line.previous.sha)} ↔ ${shaLink(line.sha)}`;
  sections.push(`${escapeText(labels.changes)} ${shas}`);
  sections.push(
    `$(diff) [${escapeText(labels.openLineChange)}](command:${context.openLineChangeCommand}?` +
      `${commandArgs(lineChangeOf(context.repo, line))})`
  );
  const location: CommitLocation = { repo: context.repo, sha: line.sha };
  sections.push(
    `$(git-commit) [${escapeText(labels.locateCommit)}](command:${context.locateCommitCommand}?` +
      `${commandArgs(location)})`
  );
  return sections.join("\n\n");
}

/** A command link's argument, as the query of its URI. Parentheses are escaped
 *  too, or one in a path would end the Markdown link early. */
function commandArgs(arg: unknown): string {
  return encodeURIComponent(JSON.stringify([arg])).replace(
    /[()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** A fenced diff block, its fence longer than any run of backticks inside. */
function diffBlock(lines: string[]): string {
  const longest = Math.max(
    0,
    ...lines.map((l) => Math.max(0, ...(l.match(/`+/g) ?? []).map((r) => r.length)))
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`${fence}diff`, ...lines, fence].join("\n");
}

/**
 * `text` as Markdown that shows exactly it: every character Markdown, HTML or
 * a theme icon (`$(name)`) could read is escaped — block syntax at a line's
 * start too (headings, setext `===` / `---` underlines, quotes, lists, tables)
 * — leading whitespace is kept (rather than turning the line into a code
 * block), and each line break stays one.
 */
function escapeText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/[\\`*_{}[\]()#+\-.!|<>~$&=]/g, "\\$&")
        .replace(/^[ \t]+/, (indent) => "&nbsp;".repeat(indent.length))
    )
    .join("  \n");
}

/**
 * The SHA a hover's copy link handed its command — a full SHA-1 or SHA-256
 * commit hash, as the hover writes them; null for anything else a command
 * link could be handed.
 */
export function copyableSha(arg: unknown): string | null {
  return isCommitHash(arg) ? arg : null;
}

const NO_DETAILS: BlameHoverDetails = { message: null, hunk: null, avatar: null };

/**
 * The details last drawn into a hover, for the blamed line they are of: a
 * redraw of that line (the cursor moved along it, say) starts from them rather
 * than from the bare blame, while they are looked up again. Any other line
 * starts from nothing.
 */
export function createLastHoverDetails() {
  let last: { of: string; details: BlameHoverDetails } | undefined;
  return {
    for(repo: string, line: BlameLine): BlameHoverDetails {
      return last?.of === blamedLineKey(repo, line) ? last.details : NO_DETAILS;
    },
    remember(repo: string, line: BlameLine, details: BlameHoverDetails) {
      last = { of: blamedLineKey(repo, line), details };
    }
  };
}

/** Which blamed line: the line of the file in the commit, in the repository. */
const blamedLineKey = (repo: string, line: BlameLine) =>
  JSON.stringify([repo, line.sha, line.filename, line.originalLine]);

function dateTimeFormat(locale: string, timeZone: string | undefined): Intl.DateTimeFormat {
  const options: Intl.DateTimeFormatOptions = { dateStyle: "long", timeStyle: "short", timeZone };
  try {
    return new Intl.DateTimeFormat(locale, options);
  } catch {
    return new Intl.DateTimeFormat("en", options);
  }
}
