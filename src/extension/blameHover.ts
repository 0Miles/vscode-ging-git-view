import { type HunkExcerpt, hunkWindow } from "@/backend/queries/blameCommitChange";
import type { BlameLine } from "@/backend/queries/blameFile";
import { abbrevCommit } from "@/backend/utils/string";

import { type BlameAnnotationContext, isUser, relativeTime } from "./blameAnnotation";

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
  /** The annotation's labels, plus `changes` before the SHAs and `copyHash`,
   *  their tooltip. */
  labels: BlameAnnotationContext["labels"] & { changes: string; copyHash: string };
  /** The command a SHA link runs, given the full SHA. */
  copyShaCommand: string;
};

/**
 * The hover card of a blamed line, as Markdown with theme icons: the author's
 * avatar (or the account icon), the author or `labels.you`, relative and
 * absolute time, the full commit message, the commit's hunk holding the line,
 * and `Changes <previous> ↔ <commit>` with each SHA a link that copies it —
 * only the commit for one without a previous. A line not committed yet says
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
    `${encodeURIComponent(JSON.stringify([sha]))} "${labels.copyHash.replace(/"/g, "'")}")`;
  const shas =
    line.previous === null
      ? shaLink(line.sha)
      : `${shaLink(line.previous.sha)} ↔ ${shaLink(line.sha)}`;
  sections.push(`${escapeText(labels.changes)} ${shas}`);
  return sections.join("\n\n");
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
  return typeof arg === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(arg) ? arg : null;
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
