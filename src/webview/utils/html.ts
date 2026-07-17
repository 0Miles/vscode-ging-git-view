const htmlEscapes: { [key: string]: string } = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
  "/": "&#x2F;"
};
const htmlUnescapes: { [key: string]: string } = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&#x2F;": "/"
};
const htmlEscaper = /[&<>"'/]/g;
const htmlUnescaper = /&lt;|&gt;|&amp;|&quot;|&#x27;|&#x2F;/g;

export function escapeHtml(str: string) {
  return str.replace(htmlEscaper, (match) => htmlEscapes[match]);
}
export function unescapeHtml(str: string) {
  return str.replace(htmlUnescaper, (match) => htmlUnescapes[match]);
}

/**
 * Convert the leading whitespace of each line to non-breaking spaces (a tab
 * expands to four) so that commit/tag message indentation — bullet lists,
 * quoted code, etc. — survives HTML's collapsing of runs of whitespace. Must
 * run while newlines are still present (before they become <br>).
 */
export function preserveLeadingWhitespace(html: string): string {
  return html.replace(/^[ \t]+/gm, (ws) => ws.replace(/\t/g, "    ").replace(/ /g, "&nbsp;"));
}

const urlMatcher = /https?:\/\/[^\s]+/g;
// Punctuation that commonly trails a URL in prose but isn't part of it.
const trailingPunctuation = /[.,;:!?)\]}>'"]+$/;

/** HTML-escape `text` and turn http/https URLs within it into clickable
 *  anchors. Non-URL text is passed through `escapeText` (escapeHtml by default,
 *  but callers may supply a transform that does further safe linkification);
 *  each URL is escaped for both its href and display text, so the result is
 *  always safe to insert as HTML. */
export function linkifyUrls(text: string, escapeText: (s: string) => string = escapeHtml): string {
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  urlMatcher.lastIndex = 0;
  while ((match = urlMatcher.exec(text)) !== null) {
    let url = match[0];
    const trail = url.match(trailingPunctuation);
    const trailing = trail ? trail[0] : "";
    if (trailing !== "") url = url.slice(0, url.length - trailing.length);

    result += escapeText(text.slice(lastIndex, match.index));
    result +=
      '<a class="commitBodyLink" href="' + escapeHtml(url) + '">' + escapeHtml(url) + "</a>";
    result += escapeText(trailing);
    lastIndex = match.index + match[0].length;
  }
  result += escapeText(text.slice(lastIndex));
  return result;
}

const hashMatcher = /\b[0-9a-f]{7,40}\b/gi;

/** HTML-escape `text` and wrap any hex token that `resolveHash` maps to a known
 *  full commit hash in a clickable span (data-hash = the full hash). Tokens that
 *  don't resolve to a loaded commit are left as plain (escaped) text. */
export function linkifyCommitHashes(
  text: string,
  resolveHash: (token: string) => string | null,
  escapeText: (s: string) => string = escapeHtml
): string {
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  hashMatcher.lastIndex = 0;
  while ((match = hashMatcher.exec(text)) !== null) {
    const full = resolveHash(match[0].toLowerCase());
    if (full !== null) {
      result += escapeText(text.slice(lastIndex, match.index));
      result +=
        '<span class="commitBodyHash" data-hash="' + full + '">' + escapeHtml(match[0]) + "</span>";
      lastIndex = match.index + match[0].length;
    }
  }
  result += escapeText(text.slice(lastIndex));
  return result;
}

/** HTML-escape `text` and turn substrings matching `pattern` (a user-configured
 *  issue regex) into links to `urlTemplate`, where `$0`/`$1`/… are replaced by
 *  the match and its capture groups. Disabled (plain escape) when either the
 *  pattern or template is empty, or the pattern is invalid. */
export function linkifyIssues(
  text: string,
  pattern: string,
  urlTemplate: string,
  escapeText: (s: string) => string = escapeHtml
): string {
  if (pattern === "" || urlTemplate === "") return escapeText(text);
  let re: RegExp;
  try {
    re = new RegExp(pattern, "g");
  } catch {
    return escapeText(text);
  }
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match[0] === "") {
      re.lastIndex++; // guard against zero-width matches looping forever
      continue;
    }
    const url = urlTemplate.replace(/\$(\d)/g, (_, n: string) => match![Number(n)] ?? "");
    result += escapeText(text.slice(lastIndex, match.index));
    result +=
      '<a class="commitBodyLink" href="' + escapeHtml(url) + '">' + escapeHtml(match[0]) + "</a>";
    lastIndex = match.index + match[0].length;
  }
  result += escapeText(text.slice(lastIndex));
  return result;
}

/** Resolve the issue URL for the first match of `pattern` in `text` (e.g. a
 *  branch name like "feature/PROJ-42"), substituting $0..$9 capture groups into
 *  `urlTemplate`. Returns null when issue linking is unconfigured, the pattern
 *  is invalid, or there is no match. */
export function firstIssueUrl(text: string, pattern: string, urlTemplate: string): string | null {
  if (pattern === "" || urlTemplate === "") return null;
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return null;
  }
  const match = re.exec(text);
  if (match === null || match[0] === "") return null;
  return urlTemplate.replace(/\$(\d)/g, (_, n: string) => match[Number(n)] ?? "");
}

/**
 * Render a small subset of inline Markdown — `` `code` ``, `**bold**`,
 * `~~strike~~`, `*italic*` — in an already-HTML-escaped string. Code spans are
 * protected first (placeholdered) so their contents aren't treated as bold or
 * italic. Intended to run as the outermost transform over linkified text.
 */
export function renderInlineMarkdown(html: string): string {
  const codeSpans: string[] = [];
  let out = html.replace(/`([^`]+)`/g, (_, code: string) => {
    codeSpans.push(code);
    return "\u0000" + (codeSpans.length - 1) + "\u0000";
  });
  out = out
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/(^|[^*])\*(?!\s)([^*]+?)\*/g, "$1<i>$2</i>");
  return out.replace(
    // eslint-disable-next-line no-control-regex -- NUL is the code-span placeholder
    /\u0000(\d+)\u0000/g,
    (_, i: string) => "<code>" + codeSpans[Number(i)] + "</code>"
  );
}
