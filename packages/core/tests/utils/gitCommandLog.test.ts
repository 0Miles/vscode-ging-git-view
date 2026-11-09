import { describe, expect, it } from "vitest";

import { formatGitCommandArgs } from "@/backend/utils/gitCommandLog";

describe("formatGitCommandArgs", () => {
  it("joins plain arguments with spaces", () => {
    expect(formatGitCommandArgs(["log", "--oneline", "HEAD"])).toBe("log --oneline HEAD");
  });

  it("renders empty-string arguments as a pair of quotes", () => {
    expect(formatGitCommandArgs(["diff", "", "HEAD"])).toBe('diff "" HEAD');
  });

  it("truncates noisy --format= arguments", () => {
    expect(formatGitCommandArgs(["log", "--format=%H%n%an%n%s"])).toBe("log --format=<…>");
  });

  it("double-quotes arguments containing spaces, escaping inner quotes", () => {
    expect(formatGitCommandArgs(["commit", "-m", "a b c"])).toBe('commit -m "a b c"');
    expect(formatGitCommandArgs(["-m", 'say "hi" now'])).toBe('-m "say \\"hi\\" now"');
  });

  it("returns an empty string for no arguments", () => {
    expect(formatGitCommandArgs([])).toBe("");
  });
});
