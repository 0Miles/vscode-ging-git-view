import { describe, expect, it } from "vitest";

import {
  escapeHtml,
  firstIssueUrl,
  linkifyCommitHashes,
  linkifyIssues,
  linkifyUrls,
  preserveLeadingWhitespace,
  renderInlineMarkdown,
  unescapeHtml
} from "@/webview/utils/html";

describe("escapeHtml", () => {
  // 1. Passthrough — safe content is not mangled
  it("returns an empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("returns plain ASCII text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  it("returns a numeric string unchanged", () => {
    expect(escapeHtml("42")).toBe("42");
  });

  it("returns unicode and emoji unchanged", () => {
    expect(escapeHtml("héllo 🌍")).toBe("héllo 🌍");
  });

  // 2. No raw HTML-breaking characters survive in the output
  it("produces no literal < in the output", () => {
    expect(escapeHtml("a < b")).not.toMatch(/</);
  });

  it("produces no literal > in the output", () => {
    expect(escapeHtml("a > b")).not.toMatch(/>/);
  });

  it("produces no bare & in the output", () => {
    // A bare & is one not immediately followed by #, alphanumerics, and ;
    expect(escapeHtml("a & b")).not.toMatch(/&(?![#a-zA-Z0-9]+;)/);
  });

  // 3. Attribute context — cannot break out of a quoted attribute value
  it("produces no literal double-quote in the output", () => {
    expect(escapeHtml('" onmouseover="evil')).not.toMatch(/"/);
  });

  it("produces no literal single-quote in the output", () => {
    expect(escapeHtml("' onmouseover='evil")).not.toMatch(/'/);
  });

  // 4. Tag injection — cannot form executable markup
  it("neutralises a script-tag XSS payload", () => {
    const result = escapeHtml("<script>alert(1)</script>");
    expect(result).not.toMatch(/</);
    expect(result).not.toMatch(/>/);
  });

  it("neutralises a self-closing img XSS payload", () => {
    const result = escapeHtml("<img src=x onerror=alert(1)/>");
    expect(result).not.toMatch(/</);
    expect(result).not.toMatch(/>/);
  });

  // 5. Round-trip consistency
  it("is lossless: unescapeHtml(escapeHtml(str)) === str", () => {
    const hazardous = `<>"'&/hello & <world> "test" 'value' end/`;
    expect(unescapeHtml(escapeHtml(hazardous))).toBe(hazardous);
  });

  // 6. Double-escaping — function is a raw escaper, not an HTML normaliser
  it("re-escapes the & in an already-escaped entity", () => {
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });

  // 7. Forward-slash escaping — closes inline script contexts
  it("escapes / to &#x2F;", () => {
    expect(escapeHtml("</script>")).toBe("&lt;&#x2F;script&gt;");
  });
});

describe("unescapeHtml", () => {
  // 1. Passthrough — content without entities is not mangled
  it("returns an empty string unchanged", () => {
    expect(unescapeHtml("")).toBe("");
  });

  it("returns plain text unchanged", () => {
    expect(unescapeHtml("hello world")).toBe("hello world");
  });

  // 2. Each known entity decodes correctly
  it("decodes &amp; to &", () => {
    expect(unescapeHtml("&amp;")).toBe("&");
  });

  it("decodes &lt; to <", () => {
    expect(unescapeHtml("&lt;")).toBe("<");
  });

  it("decodes &gt; to >", () => {
    expect(unescapeHtml("&gt;")).toBe(">");
  });

  it('decodes &quot; to "', () => {
    expect(unescapeHtml("&quot;")).toBe('"');
  });

  it("decodes &#x27; to '", () => {
    expect(unescapeHtml("&#x27;")).toBe("'");
  });

  it("decodes &#x2F; to /", () => {
    expect(unescapeHtml("&#x2F;")).toBe("/");
  });

  // 3. Single-level only — does not double-decode
  it("decodes &amp;amp; to &amp;, not &", () => {
    expect(unescapeHtml("&amp;amp;")).toBe("&amp;");
  });

  // 4. Unknown entities pass through unchanged
  it("leaves unknown entities like &nbsp; unchanged", () => {
    expect(unescapeHtml("&nbsp;")).toBe("&nbsp;");
  });

  // 5. Malformed entities (no trailing ;) pass through unchanged
  it("leaves malformed &amp without semicolon unchanged", () => {
    expect(unescapeHtml("&amp")).toBe("&amp");
  });
});

describe("linkifyUrls", () => {
  it("escapes plain text with no URLs", () => {
    expect(linkifyUrls("a < b & c")).toBe("a &lt; b &amp; c");
  });

  it("wraps an http(s) URL in an anchor", () => {
    expect(linkifyUrls("see https://example.com now")).toBe(
      'see <a class="commitBodyLink" href="https:&#x2F;&#x2F;example.com">https:&#x2F;&#x2F;example.com</a> now'
    );
  });

  it("keeps trailing punctuation outside the link", () => {
    const out = linkifyUrls("visit https://example.com.");
    expect(out).toContain('<a class="commitBodyLink" href="https:&#x2F;&#x2F;example.com">');
    expect(out.endsWith("</a>.")).toBe(true);
  });

  it("does not create a link for non-URL text", () => {
    expect(linkifyUrls("not a url: ftp://x")).not.toContain("<a ");
  });

  it("escapes a URL so it cannot inject markup", () => {
    // The closing quote/bracket are escaped, so no attribute break-out.
    const out = linkifyUrls('http://x/"><img>');
    expect(out).not.toContain('"><img>');
    expect(out).toContain("&quot;");
  });
});

describe("linkifyCommitHashes", () => {
  const full = "abcdef1234567890abcdef1234567890abcdef12";
  const resolve = (token: string) => (full.startsWith(token) ? full : null);

  it("wraps a known abbreviated hash with the resolved full hash", () => {
    const out = linkifyCommitHashes("see abcdef1 for details", resolve);
    expect(out).toBe(
      'see <span class="commitBodyHash" data-hash="' + full + '">abcdef1</span> for details'
    );
  });

  it("leaves unknown hex tokens as escaped text", () => {
    expect(linkifyCommitHashes("deadbeef0 < x", () => null)).toBe("deadbeef0 &lt; x");
  });

  it("ignores tokens shorter than 7 chars", () => {
    expect(linkifyCommitHashes("abc123 here", resolve)).toBe("abc123 here");
  });
});

describe("preserveLeadingWhitespace", () => {
  it("converts leading spaces on each line to non-breaking spaces", () => {
    expect(preserveLeadingWhitespace("a\n  b\n    c")).toBe(
      "a\n&nbsp;&nbsp;b\n&nbsp;&nbsp;&nbsp;&nbsp;c"
    );
  });

  it("expands a leading tab to four non-breaking spaces", () => {
    expect(preserveLeadingWhitespace("\titem")).toBe("&nbsp;&nbsp;&nbsp;&nbsp;item");
  });

  it("leaves interior whitespace untouched", () => {
    expect(preserveLeadingWhitespace("a  b\n  c  d")).toBe("a  b\n&nbsp;&nbsp;c  d");
  });

  it("returns text without leading whitespace unchanged", () => {
    expect(preserveLeadingWhitespace("no indent here")).toBe("no indent here");
  });

  it("returns the empty string unchanged", () => {
    expect(preserveLeadingWhitespace("")).toBe("");
  });
});

describe("linkifyIssues", () => {
  const pattern = "#(\\d+)";
  const url = "https://example.com/issues/$1";

  it("links issue references using the capture group", () => {
    expect(linkifyIssues("fixes #123 now", pattern, url)).toBe(
      'fixes <a class="commitBodyLink" href="https:&#x2F;&#x2F;example.com&#x2F;issues&#x2F;123">#123</a> now'
    );
  });

  it("escapes non-issue text", () => {
    expect(linkifyIssues("a < b", pattern, url)).toBe("a &lt; b");
  });

  it("is disabled when the pattern is empty", () => {
    expect(linkifyIssues("see #1", "", url)).toBe("see #1");
  });

  it("is disabled when the url is empty", () => {
    expect(linkifyIssues("see #1", pattern, "")).toBe("see #1");
  });

  it("falls back to escaped text for an invalid regex", () => {
    expect(linkifyIssues("a < (", "(", url)).toBe("a &lt; (");
  });

  it("substitutes multiple capturing groups in the url template", () => {
    // e.g. JIRA-style "PROJ-123" -> https://example.com/PROJ/123
    expect(linkifyIssues("see ABC-42 today", "([A-Z]+)-(\\d+)", "https://example.com/$1/$2")).toBe(
      'see <a class="commitBodyLink" href="https:&#x2F;&#x2F;example.com&#x2F;ABC&#x2F;42">ABC-42</a> today'
    );
  });

  it("substitutes $0 with the whole match", () => {
    expect(linkifyIssues("GH-7", "GH-(\\d+)", "https://example.com/$0")).toBe(
      '<a class="commitBodyLink" href="https:&#x2F;&#x2F;example.com&#x2F;GH-7">GH-7</a>'
    );
  });
});

describe("firstIssueUrl", () => {
  const pattern = "[A-Z]+-\\d+";
  const url = "https://example.com/browse/$0";

  it("returns the URL for the first issue match in a branch name", () => {
    expect(firstIssueUrl("feature/PROJ-42", pattern, url)).toBe(
      "https://example.com/browse/PROJ-42"
    );
  });

  it("substitutes capture groups", () => {
    expect(firstIssueUrl("bug/123-x", "(\\d+)", "https://e.com/issues/$1")).toBe(
      "https://e.com/issues/123"
    );
  });

  it("returns null when the branch name has no issue", () => {
    expect(firstIssueUrl("just-a-branch", pattern, url)).toBeNull();
  });

  it("returns null when issue linking is unconfigured", () => {
    expect(firstIssueUrl("PROJ-1", "", url)).toBeNull();
    expect(firstIssueUrl("PROJ-1", pattern, "")).toBeNull();
  });

  it("returns null for an invalid pattern", () => {
    expect(firstIssueUrl("PROJ-1", "(", url)).toBeNull();
  });
});

describe("renderInlineMarkdown", () => {
  it("renders bold, italic, code and strikethrough", () => {
    expect(renderInlineMarkdown("a **b** c")).toBe("a <b>b</b> c");
    expect(renderInlineMarkdown("a *b* c")).toBe("a <i>b</i> c");
    expect(renderInlineMarkdown("a `b` c")).toBe("a <code>b</code> c");
    expect(renderInlineMarkdown("a ~~b~~ c")).toBe("a <del>b</del> c");
  });

  it("does not treat markdown chars inside a code span as formatting", () => {
    expect(renderInlineMarkdown("`a*b*c`")).toBe("<code>a*b*c</code>");
  });

  it("leaves plain text (incl. spaced digits) untouched", () => {
    expect(renderInlineMarkdown("step 3 of 5 done")).toBe("step 3 of 5 done");
  });

  it("leaves a lone asterisk alone", () => {
    expect(renderInlineMarkdown("2 * 3 = 6")).toBe("2 * 3 = 6");
  });
});
