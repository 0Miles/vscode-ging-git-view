import { describe, expect, it } from "vitest";

import { formatDate, pad2 } from "@/webview/utils/date";

// 19 Nov 2026 11:24:05 (local time)
const date = new Date(2026, 10, 19, 11, 24, 5);
// 5 Mar 2007 — single-digit day/month exercise the padding tokens.
const early = new Date(2007, 2, 5, 9, 6, 7);

describe("formatDate", () => {
  it("renders the default 'DD MMM YYYY' as English day/month/year", () => {
    expect(formatDate(date, "DD MMM YYYY")).toBe("19 Nov 2026");
  });

  it("uses English month abbreviations regardless of locale", () => {
    // getMonth() === 0 → Jan, 11 → Dec
    expect(formatDate(new Date(2026, 0, 1), "MMM")).toBe("Jan");
    expect(formatDate(new Date(2026, 11, 1), "MMM")).toBe("Dec");
  });

  it("zero-pads DD/MM and leaves D/M bare", () => {
    expect(formatDate(early, "DD/MM/YYYY")).toBe("05/03/2007");
    expect(formatDate(early, "D/M/YYYY")).toBe("5/3/2007");
  });

  it("supports a 2-digit year and prefers longest tokens", () => {
    expect(formatDate(date, "YY")).toBe("26");
    expect(formatDate(early, "YY")).toBe("07");
    // MMM must win over MM/M, YYYY over YY, DD over D at the same position.
    expect(formatDate(date, "YYYY-MM-DD")).toBe("2026-11-19");
  });

  it("emits non-token text verbatim", () => {
    expect(formatDate(date, "DD MMM YYYY")).toContain(" ");
    expect(formatDate(date, "[DD] MMM")).toBe("[19] Nov");
  });
});

describe("pad2", () => {
  it("pads values below 10", () => {
    expect(String(pad2(5))).toBe("05");
    expect(String(pad2(10))).toBe("10");
  });
});
