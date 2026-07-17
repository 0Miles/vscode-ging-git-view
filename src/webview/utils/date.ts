// English month abbreviations, kept locale-independent so the `MMM` token
// always renders (e.g. "Nov") regardless of the active VS Code display
// language — matching the default `dates.customFormat` of "DD MMM YYYY".
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function pad2(i: number) {
  return i > 9 ? i : "0" + i;
}

/**
 * Render a date using a token pattern, e.g. "DD MMM YYYY" → "19 Nov 2026".
 * Tokens (longest match wins): YYYY, YY, MMM, MM, M, DD, D. Any other text in
 * the pattern is emitted verbatim.
 */
export function formatDate(date: Date, pattern: string): string {
  return pattern.replace(/YYYY|YY|MMM|MM|M|DD|D/g, (token) => {
    switch (token) {
      case "YYYY":
        return String(date.getFullYear());
      case "YY":
        return String(pad2(date.getFullYear() % 100));
      case "MMM":
        return MONTHS[date.getMonth()];
      case "MM":
        return String(pad2(date.getMonth() + 1));
      case "M":
        return String(date.getMonth() + 1);
      case "DD":
        return String(pad2(date.getDate()));
      case "D":
        return String(date.getDate());
      default:
        return token;
    }
  });
}
