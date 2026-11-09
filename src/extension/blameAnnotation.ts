import type { BlameLine } from "@/backend/queries/blameFile";

/** Summaries longer than this are cut, the ellipsis included. */
const SUMMARY_MAX = 50;

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type BlameAnnotationContext = {
  /** The current time, in milliseconds since the epoch. */
  now: number;
  /** VS Code's UI language (`vscode.env.language`), e.g. `en` or `zh-tw`. */
  locale: string;
  /** The repository's effective `user.email`; "" when unset. */
  userEmail: string;
  /** Localised labels: `you` stands in for the user's own name, `uncommitted`
   *  describes a line not committed yet. */
  labels: { you: string; uncommitted: string };
};

/**
 * The end-of-line text for one blamed line: `author, relative time • summary`,
 * with `labels.you` for the user's own commits and `<you> • <uncommitted>` for
 * a line not committed yet.
 */
export function blameAnnotationText(line: BlameLine, context: BlameAnnotationContext): string {
  const { you, uncommitted } = context.labels;
  if (line.uncommitted) return `${you} • ${uncommitted}`;
  const author = isUser(line.authorEmail, context.userEmail) ? you : line.authorName;
  const when = relativeTime(context.now / 1000 - line.authorTime, context.locale);
  return `${author}, ${when} • ${truncate(line.summary, SUMMARY_MAX)}`;
}

/** Without a configured email nobody is the user — an author with no email
 *  must not match an unset one. */
export function isUser(authorEmail: string, userEmail: string): boolean {
  const user = userEmail.trim().toLowerCase();
  return user !== "" && authorEmail.trim().toLowerCase() === user;
}

/** How long ago something `ageSeconds` old was, in `locale` (English when
 *  Intl doesn't know it), e.g. "2 weeks ago". */
export function relativeTime(ageSeconds: number, locale: string): string {
  const age = Math.max(0, ageSeconds);
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
    age < MINUTE
      ? [age, "second"]
      : age < HOUR
        ? [age / MINUTE, "minute"]
        : age < DAY
          ? [age / HOUR, "hour"]
          : age < 7 * DAY
            ? [age / DAY, "day"]
            : age < 30 * DAY
              ? [age / (7 * DAY), "week"]
              : age < 365 * DAY
                ? [age / (30 * DAY), "month"]
                : [age / (365 * DAY), "year"];
  return relativeTimeFormat(locale).format(-Math.floor(value), unit);
}

function relativeTimeFormat(locale: string): Intl.RelativeTimeFormat {
  try {
    return new Intl.RelativeTimeFormat(locale);
  } catch {
    return new Intl.RelativeTimeFormat("en");
  }
}

/** Cut by code point, so an emoji is never split in half. */
function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max - 1).join("") + "…";
}
