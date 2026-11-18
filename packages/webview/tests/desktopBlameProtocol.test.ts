import { describe, expect, it } from "vitest";

import {
  isFileBlameHostMessage,
  isFileBlameRequest
} from "@ging/webview/desktop/diff/blameProtocol";

// What the blame view (#409) takes from the host, and what the host takes
// from the page: a message of the wrong shape is no blame view's.

describe("the blame view's protocol", () => {
  const blame = {
    repo: "/repo",
    commits: [{ sha: "a".repeat(40), uncommitted: false, text: "Al, 1 day ago • add" }],
    lines: [0, 0]
  };

  it("takes the host's blame, hover and words, each of a file by its number", () => {
    expect(isFileBlameHostMessage({ command: "fileBlame", file: 1, blame })).toBe(true);
    expect(isFileBlameHostMessage({ command: "fileBlame", file: 1, blame: null })).toBe(true);
    expect(
      isFileBlameHostMessage({ command: "fileBlameHover", file: 1, line: 0, markdown: "x" })
    ).toBe(true);
    expect(isFileBlameHostMessage({ command: "fileBlameSaid", file: 1, text: "Copied" })).toBe(
      true
    );
  });

  it.each([
    ["no file", { command: "fileBlame", blame }],
    ["a line naming no commit", { command: "fileBlame", file: 1, blame: { ...blame, lines: [1] } }],
    [
      "a commit with no hash",
      {
        command: "fileBlame",
        file: 1,
        blame: { ...blame, commits: [{ text: "", uncommitted: false }] }
      }
    ],
    ["a negative line", { command: "fileBlameHover", file: 1, line: -1, markdown: "" }],
    ["the graph's", { command: "loadCommits", file: 1 }]
  ])("takes no host message with %s", (_what, data) => {
    expect(isFileBlameHostMessage(data)).toBe(false);
  });

  it("takes the page's requests, and no link it does not know", () => {
    expect(isFileBlameRequest({ command: "fileBlameOpen", file: 1 })).toBe(true);
    expect(isFileBlameRequest({ command: "fileBlameClose", file: 1 })).toBe(true);
    expect(isFileBlameRequest({ command: "fileBlameHoverOf", file: 1, line: 3 })).toBe(true);
    expect(
      isFileBlameRequest({ command: "fileBlameRun", file: 1, link: "copySha", arg: "x" })
    ).toBe(true);
    expect(
      isFileBlameRequest({ command: "fileBlameRun", file: 1, link: "runAnything", arg: "x" })
    ).toBe(false);
    expect(isFileBlameRequest({ command: "fileBlameOpen", file: "1" })).toBe(false);
  });
});
