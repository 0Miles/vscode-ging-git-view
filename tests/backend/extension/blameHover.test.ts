import { describe, expect, it } from "vitest";

import type { BlameLine } from "@/backend/queries/blameFile";
import {
  type BlameHoverDetails,
  blameHoverMarkdown,
  copyableSha,
  createLastHoverDetails
} from "@/extension/blameHover";

const NOW = Date.UTC(2026, 10, 9, 9, 30, 0);
const DAY = 86_400;
const SHA = "a".repeat(40);
const PARENT = "b".repeat(40);

function line(overrides: Partial<BlameLine> = {}): BlameLine {
  return {
    sha: SHA,
    uncommitted: false,
    authorName: "Bea",
    authorEmail: "bea@example.com",
    authorTime: NOW / 1000 - 14 * DAY,
    summary: "Fix the thing",
    originalLine: 3,
    filename: "a.txt",
    previous: { sha: PARENT, filename: "a.txt" },
    ...overrides
  };
}

const EN_LABELS = {
  you: "You",
  uncommitted: "Uncommitted changes",
  changes: "Changes",
  copyHash: "Copy commit hash"
};

const NO_DETAILS: BlameHoverDetails = { message: null, hunk: null, avatar: null };

function hover(
  l: BlameLine,
  details: Partial<BlameHoverDetails> = {},
  opts: { locale?: string; userEmail?: string; labels?: typeof EN_LABELS } = {}
) {
  return blameHoverMarkdown(
    l,
    { ...NO_DETAILS, ...details },
    {
      now: NOW,
      locale: opts.locale ?? "en",
      timeZone: "UTC",
      userEmail: opts.userEmail ?? "",
      labels: opts.labels ?? EN_LABELS,
      copyShaCommand: "ext.copySha"
    }
  );
}

/** The command link that copies `sha`, as the hover writes it. */
const copyLink = (sha: string) =>
  `[\`${sha.slice(0, 8)}\`](command:ext.copySha?${encodeURIComponent(JSON.stringify([sha]))} "Copy commit hash")`;

/** The lines inside the hover's diff block. */
function diffBody(markdown: string) {
  const lines = markdown.split("\n");
  return lines.slice(lines.indexOf("```diff") + 1, lines.indexOf("```"));
}

/** Some ICU versions put a narrow no-break space before AM/PM. */
const plainSpaces = (text: string) => text.replace(/\u202f/g, " ");

describe("blameHoverMarkdown", () => {
  it("shows avatar, author, both times, message, the hunk and the commit's changes", () => {
    const markdown = hover(line(), {
      message: "Fix the thing\n\nIt was broken.",
      hunk: { lines: [" two", "-three", "+three fixed", " four"], index: 2 }
    });
    expect(plainSpaces(markdown)).toBe(
      [
        "$(account) **Bea**, 2 weeks ago (October 26, 2026 at 9:30 AM)",
        "",
        "Fix the thing  \n  \nIt was broken\\.",
        "",
        "```diff",
        " two",
        "-three",
        "+three fixed",
        " four",
        "```",
        "",
        "---",
        "",
        `Changes ${copyLink(PARENT)} ↔ ${copyLink(SHA)}`
      ].join("\n")
    );
  });

  it("falls back to the summary, and leaves the diff out, until the details arrive", () => {
    expect(plainSpaces(hover(line()))).toBe(
      [
        "$(account) **Bea**, 2 weeks ago (October 26, 2026 at 9:30 AM)",
        "",
        "Fix the thing",
        "",
        "---",
        "",
        `Changes ${copyLink(PARENT)} ↔ ${copyLink(SHA)}`
      ].join("\n")
    );
  });

  it("lists only the commit itself when it has no parent", () => {
    const markdown = hover(line({ previous: null }));
    expect(markdown.split("\n").at(-1)).toBe(`Changes ${copyLink(SHA)}`);
    expect(markdown).not.toContain("↔");
  });

  it("says only that an uncommitted line isn't committed", () => {
    const markdown = hover(line({ uncommitted: true, sha: "0".repeat(40), previous: null }), {
      avatar: "data:image/png;base64,AAAA"
    });
    expect(markdown).toBe("Uncommitted changes");
  });

  describe("avatar", () => {
    it("shows the cached image when there is one", () => {
      const markdown = hover(line(), { avatar: "data:image/png;base64,AAAA" });
      expect(markdown.split("\n")[0]).toMatch(
        /^!\[\]\(data:image\/png;base64,AAAA\|width=16,height=16\) \*\*Bea\*\*, /
      );
      expect(markdown).not.toContain("$(account)");
    });

    it("shows the account icon when there is none", () => {
      expect(hover(line()).split("\n")[0]).toMatch(/^\$\(account\) \*\*Bea\*\*, /);
    });
  });

  describe("hunk", () => {
    const fifteen = Array.from({ length: 15 }, (_, i) => ` line ${i}`);

    it("keeps a hunk of up to 10 lines whole", () => {
      const ten = fifteen.slice(0, 10);
      expect(diffBody(hover(line(), { hunk: { lines: ten, index: 9 } }))).toEqual(ten);
    });

    it("cuts a longer hunk to 10 lines, the … marking the cut among them", () => {
      expect(diffBody(hover(line(), { hunk: { lines: fifteen, index: 1 } }))).toEqual([
        ...fifteen.slice(0, 9),
        "…"
      ]);
    });

    it("keeps the blamed line among the 10 shown", () => {
      expect(diffBody(hover(line(), { hunk: { lines: fifteen, index: 13 } }))).toEqual([
        "…",
        ...fifteen.slice(6, 15)
      ]);
      expect(diffBody(hover(line(), { hunk: { lines: fifteen, index: 8 } }))).toEqual([
        "…",
        ...fifteen.slice(4, 12),
        "…"
      ]);
    });

    it("shows a line rather than a … standing for it alone", () => {
      const eleven = fifteen.slice(0, 11);
      // Line 0 is the only one before the window: shown, not cut.
      expect(diffBody(hover(line(), { hunk: { lines: eleven, index: 5 } }))).toEqual([
        ...eleven.slice(0, 9),
        "…"
      ]);
    });

    it("never shows more than 10 lines, wherever the blamed line is", () => {
      for (let index = 0; index < fifteen.length; index++) {
        const shown = diffBody(hover(line(), { hunk: { lines: fifteen, index } }));
        expect(shown.length).toBeLessThanOrEqual(10);
        expect(shown).toContain(fifteen[index]);
      }
    });

    it("fences a hunk that itself holds backticks", () => {
      const markdown = hover(line(), { hunk: { lines: ["+```js"], index: 0 } });
      expect(markdown).toContain("````diff\n+```js\n````");
    });
  });

  describe("You", () => {
    it("names the user You when the emails match, ignoring case", () => {
      const markdown = hover(
        line({ authorEmail: "Bea@Example.COM" }),
        {},
        {
          userEmail: "bea@example.com"
        }
      );
      expect(markdown.split("\n")[0]).toMatch(/^\$\(account\) \*\*You\*\*, /);
    });

    it("keeps the author's name for someone else, or with no user email set", () => {
      expect(hover(line(), {}, { userEmail: "me@example.com" })).toContain("**Bea**");
      expect(hover(line({ authorEmail: "" }), {}, { userEmail: "" })).toContain("**Bea**");
    });
  });

  it("formats both times in the UI language", () => {
    const first = (locale: string) => plainSpaces(hover(line(), {}, { locale }).split("\n")[0]);
    expect(first("zh-tw")).toBe("$(account) **Bea**, 2 週前 (2026年10月26日 上午9:30)");
    expect(first("zh-cn")).toBe("$(account) **Bea**, 2周前 (2026年10月26日 09:30)");
    expect(first("de")).toBe("$(account) **Bea**, vor 2 Wochen (26\\. Oktober 2026 um 09:30)");
  });

  it("falls back to English for a language Intl doesn't know", () => {
    expect(plainSpaces(hover(line(), {}, { locale: "not a locale!" }).split("\n")[0])).toBe(
      "$(account) **Bea**, 2 weeks ago (October 26, 2026 at 9:30 AM)"
    );
  });

  it("shows block syntax at the start of a message line as text", () => {
    const markdown = hover(line(), {
      message: [
        "Title",
        "===",
        "# h",
        "> q",
        "* a",
        "+ b",
        "- c",
        "1. d",
        "2) e",
        "| a | b |",
        "---"
      ].join("\n")
    });
    expect(markdown.split("\n\n")[1]).toBe(
      [
        "Title",
        "\\=\\=\\=",
        "\\# h",
        "\\> q",
        "\\* a",
        "\\+ b",
        "\\- c",
        "1\\. d",
        "2\\) e",
        "\\| a \\| b \\|",
        "\\-\\-\\-"
      ].join("  \n")
    );
  });

  it("shows the author and message as text, never as markdown or icons", () => {
    const markdown = hover(line({ authorName: "*Bo* $(zap)" }), {
      message: "[link](command:evil) <b>x</b>\n    indented"
    });
    expect(markdown).toContain("**\\*Bo\\* \\$\\(zap\\)**");
    expect(markdown).toContain(
      "\\[link\\]\\(command:evil\\) \\<b\\>x\\</b\\>  \n&nbsp;&nbsp;&nbsp;&nbsp;indented"
    );
  });
});

describe("createLastHoverDetails", () => {
  const DETAILS: BlameHoverDetails = { message: "full", hunk: null, avatar: "data:x" };

  it("hands back what was last drawn for the same blamed line", () => {
    const last = createLastHoverDetails();
    last.remember("/repo", line(), DETAILS);
    expect(last.for("/repo", line())).toBe(DETAILS);
  });

  it("starts from nothing for any other line, commit, file or repository", () => {
    const last = createLastHoverDetails();
    last.remember("/repo", line(), DETAILS);
    expect(last.for("/repo", line({ originalLine: 4 }))).toEqual(NO_DETAILS);
    expect(last.for("/repo", line({ sha: PARENT }))).toEqual(NO_DETAILS);
    expect(last.for("/repo", line({ filename: "b.txt" }))).toEqual(NO_DETAILS);
    expect(last.for("/other", line())).toEqual(NO_DETAILS);
  });

  it("starts from nothing before anything was drawn", () => {
    expect(createLastHoverDetails().for("/repo", line())).toEqual(NO_DETAILS);
  });
});

describe("copyableSha", () => {
  it("accepts a full SHA-1 or SHA-256 commit hash", () => {
    expect(copyableSha(SHA)).toBe(SHA);
    expect(copyableSha("c".repeat(64))).toBe("c".repeat(64));
  });

  it("refuses anything else a command link could be handed", () => {
    expect(copyableSha(undefined)).toBeNull();
    expect(copyableSha(42)).toBeNull();
    expect(copyableSha([SHA])).toBeNull();
    expect(copyableSha(SHA.slice(0, 8))).toBeNull();
    expect(copyableSha(SHA.toUpperCase())).toBeNull();
    expect(copyableSha(SHA + "\nrm -rf")).toBeNull();
  });
});
