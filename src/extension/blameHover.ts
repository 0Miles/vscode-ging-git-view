import type { BlameLine } from "@/backend/queries/blameFile";

import { isUser, relativeTime } from "./blameAnnotation";

/** Hunks longer than this are cut to a window around the blamed line. */
const HUNK_MAX_LINES = 10;
/** How many of the window's lines come before the blamed line, room allowing. */
const HUNK_LINES_BEFORE = 4;
const AVATAR_SIZE = 16;
const SHORT_SHA = 7;

/** What the hover knows beyond the blame itself, each part null until (or
 *  unless) it is there. */
export type BlameHoverDetails = {
  /** The commit's full message; the blame's summary stands in until then. */
  message: string | null;
  /** The commit's hunk holding the line, and the index in it of the line. */
  hunk: { lines: string[]; index: number } | null;
  /** An image URI of the author's avatar; the account icon stands in without. */
  avatar: string | null;
};

export type BlameHoverContext = {
  /** The current time, in milliseconds since the epoch. */
  now: number;
  /** VS Code's UI language (`vscode.env.language`), e.g. `en` or `zh-tw`. */
  locale: string;
  /** The time zone to show the absolute time in; the system's by default. */
  timeZone?: string;
  /** The repository's effective `user.email`; "" when unset. */
  userEmail: string;
  /** Localised labels: `you` for the user's own name, `uncommitted` for a line
   *  not committed yet, `changes` before the SHAs, `copySha` their tooltip. */
  labels: { you: string; uncommitted: string; changes: string; copySha: string };
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
  if (details.hunk !== null) sections.push(codeBlock(hunkWindow(details.hunk), "diff"));
  sections.push("---");

  const shaLink = (sha: string) =>
    `[\`${sha.slice(0, SHORT_SHA)}\`](command:${context.copyShaCommand}?` +
    `${encodeURIComponent(JSON.stringify([sha]))} "${labels.copySha.replace(/"/g, "'")}")`;
  const shas =
    line.previous === null
      ? shaLink(line.sha)
      : `${shaLink(line.previous.sha)} ↔ ${shaLink(line.sha)}`;
  // A link to open this line's change in a diff editor goes on this line too.
  sections.push(`${escapeText(labels.changes)} ${shas}`);
  return sections.join("\n\n");
}

/** At most `HUNK_MAX_LINES` of the hunk, the blamed line among them, with "…"
 *  where lines were cut. */
function hunkWindow({ lines, index }: { lines: string[]; index: number }): string[] {
  if (lines.length <= HUNK_MAX_LINES) return lines;
  const start = Math.max(0, Math.min(index - HUNK_LINES_BEFORE, lines.length - HUNK_MAX_LINES));
  const end = start + HUNK_MAX_LINES;
  return [
    ...(start > 0 ? ["…"] : []),
    ...lines.slice(start, end),
    ...(end < lines.length ? ["…"] : [])
  ];
}

/** A fenced code block, its fence longer than any run of backticks inside. */
function codeBlock(lines: string[], language: string): string {
  const longest = Math.max(
    0,
    ...lines.map((l) => Math.max(0, ...(l.match(/`+/g) ?? []).map((r) => r.length)))
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`${fence}${language}`, ...lines, fence].join("\n");
}

/**
 * `text` as Markdown that shows exactly it: every character Markdown, HTML or
 * a theme icon (`$(name)`) could read is escaped, leading whitespace is kept
 * (rather than turning the line into a code block), and each line break stays
 * one.
 */
function escapeText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/[\\`*_{}[\]()#+\-.!|<>~$&]/g, "\\$&")
        .replace(/^[ \t]+/, (indent) => "&nbsp;".repeat(indent.length))
    )
    .join("  \n");
}

function dateTimeFormat(locale: string, timeZone: string | undefined): Intl.DateTimeFormat {
  const options: Intl.DateTimeFormatOptions = { dateStyle: "long", timeStyle: "short", timeZone };
  try {
    return new Intl.DateTimeFormat(locale, options);
  } catch {
    return new Intl.DateTimeFormat("en", options);
  }
}
