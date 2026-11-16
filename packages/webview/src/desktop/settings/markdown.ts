import { escapeHtml, renderInlineMarkdown } from "@ging/webview/utils/html";

/** A link written `[text](target)`; the target has no spaces or parentheses. */
const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

/** `text` as HTML: escaped, then the inline markdown the settings use. */
const inline = (text: string) => renderInlineMarkdown(escapeHtml(text));

/** One link: to another setting's row (`#key`) in the page, or to the web in
 *  the user's browser — the host opens a link that asks for a new window there
 *  (`target="_blank"`), and lets nothing else leave the app. Any other target
 *  is left as its text. */
function link(text: string, target: string): string {
  if (target.startsWith("#")) {
    return `<a class="settingLink" href="${escapeHtml(target)}">${inline(text)}</a>`;
  }
  if (/^https?:\/\//.test(target)) {
    return `<a class="externalLink" href="${escapeHtml(target)}" target="_blank" rel="noopener">${inline(text)}</a>`;
  }
  return inline(text);
}

/**
 * A setting's markdown description as HTML (#397): its paragraphs, links, and
 * the inline markdown the extension's descriptions use. What VS Code's own
 * Settings editor renders is far more; this is what the descriptions written so
 * far need. Everything that is not markup is escaped.
 */
export function renderDescriptionMarkdown(markdown: string): string {
  return markdown
    .split(/\n\s*\n/)
    .map((paragraph) => {
      let html = "";
      let last = 0;
      for (const match of paragraph.matchAll(LINK)) {
        html += inline(paragraph.slice(last, match.index)) + link(match[1], match[2]);
        last = match.index + match[0].length;
      }
      return `<p>${html}${inline(paragraph.slice(last))}</p>`;
    })
    .join("");
}
