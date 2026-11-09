import { describe, expect, it } from "vitest";

import type { BlameLine } from "@/backend/queries/blameFile";
import { blameAnnotationText } from "@/extension/blameAnnotation";

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const DAY = 86_400;
const nowSeconds = NOW / 1000;

function line(overrides: Partial<BlameLine> = {}): BlameLine {
  return {
    sha: "a".repeat(40),
    uncommitted: false,
    authorName: "Bea",
    authorEmail: "bea@example.com",
    authorTime: nowSeconds - 14 * DAY,
    summary: "Fix the thing",
    originalLine: 1,
    filename: "a.txt",
    previous: null,
    ...overrides
  };
}

const EN_LABELS = { you: "You", uncommitted: "Uncommitted changes" };

function text(
  l: BlameLine,
  opts: { locale?: string; userEmail?: string; labels?: typeof EN_LABELS } = {}
) {
  return blameAnnotationText(l, {
    now: NOW,
    locale: opts.locale ?? "en",
    userEmail: opts.userEmail ?? "",
    labels: opts.labels ?? EN_LABELS
  });
}

describe("blameAnnotationText", () => {
  it("shows author, relative time and summary", () => {
    expect(text(line())).toBe("Bea, 2 weeks ago • Fix the thing");
  });

  describe("You", () => {
    it("replaces the author when the user's email matches, ignoring case", () => {
      expect(text(line({ authorEmail: "Bea@Example.COM" }), { userEmail: "bea@example.com" })).toBe(
        "You, 2 weeks ago • Fix the thing"
      );
    });

    it("keeps the author's name when the emails differ", () => {
      expect(text(line(), { userEmail: "someone@example.com" })).toBe(
        "Bea, 2 weeks ago • Fix the thing"
      );
    });

    it("keeps the author's name when the user has no email set, even for an author without one", () => {
      expect(text(line({ authorEmail: "" }), { userEmail: "" })).toBe(
        "Bea, 2 weeks ago • Fix the thing"
      );
    });
  });

  it("shows an uncommitted line as the user's own uncommitted change", () => {
    expect(text(line({ uncommitted: true, authorName: "Not Committed Yet" }))).toBe(
      "You • Uncommitted changes"
    );
  });

  it("uses the localised labels it is given", () => {
    const labels = { you: "你", uncommitted: "尚未提交的變更" };
    expect(text(line(), { locale: "zh-tw", userEmail: "bea@example.com", labels })).toBe(
      "你, 2 週前 • Fix the thing"
    );
    expect(text(line({ uncommitted: true }), { labels })).toBe("你 • 尚未提交的變更");
  });

  describe("summary", () => {
    it("keeps a summary of exactly 50 characters whole", () => {
      const summary = "x".repeat(50);
      expect(text(line({ summary }))).toBe(`Bea, 2 weeks ago • ${summary}`);
    });

    it("cuts a longer summary to 50 characters, ending in an ellipsis", () => {
      const summary = "0123456789".repeat(6);
      expect(text(line({ summary }))).toBe(
        `Bea, 2 weeks ago • ${"0123456789".repeat(4)}012345678…`
      );
    });

    it("never splits an emoji when cutting", () => {
      const summary = "x".repeat(48) + "🎉🎉🎉";
      expect(text(line({ summary }))).toBe(`Bea, 2 weeks ago • ${"x".repeat(48)}🎉…`);
    });
  });

  describe("relative time", () => {
    it.each([
      [45, "45 seconds ago"],
      [3 * 3600, "3 hours ago"],
      [2 * DAY, "2 days ago"],
      [14 * DAY, "2 weeks ago"],
      [150 * DAY, "5 months ago"],
      [400 * DAY, "1 year ago"]
    ])("picks the unit for %i seconds ago", (age, expected) => {
      expect(text(line({ authorTime: nowSeconds - age }))).toBe(`Bea, ${expected} • Fix the thing`);
    });

    it("follows the UI language", () => {
      expect(text(line(), { locale: "zh-tw" })).toBe("Bea, 2 週前 • Fix the thing");
      expect(text(line(), { locale: "zh-cn" })).toBe("Bea, 2周前 • Fix the thing");
      expect(text(line({ authorTime: nowSeconds - 3 * 3600 }), { locale: "zh-tw" })).toBe(
        "Bea, 3 小時前 • Fix the thing"
      );
    });

    it("falls back to English for a language Intl does not accept", () => {
      expect(text(line(), { locale: "not a locale!" })).toBe("Bea, 2 weeks ago • Fix the thing");
    });
  });
});
