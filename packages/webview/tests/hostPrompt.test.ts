import { describe, expect, it } from "vitest";

import {
  isHostPromptMessage,
  isHostPromptReply,
  matchingItems
} from "@ging/webview/desktop/hostPrompt";

// The host prompt protocol of the desktop entry (#390): which messages on the
// page's channel are prompts, and which rows a pick's filter keeps. The
// overlay that draws them runs in a real browser, in e2e/webview.

const items = [
  { label: "origin", description: "github.com/alice/repo" },
  { label: "upstream", description: "github.com/team/repo" },
  { label: "Fork", description: "gitlab.com/bob/upstream-fork" }
];

describe("a pick's filter", () => {
  it("keeps every row for an empty query", () => {
    expect(matchingItems(items, "  ", false)).toEqual([0, 1, 2]);
  });

  it("keeps the rows whose label holds the query, ignoring case, in their order", () => {
    expect(matchingItems(items, "R", false)).toEqual([0, 1, 2]);
    expect(matchingItems(items, "fork", false)).toEqual([2]);
    expect(matchingItems(items, " up ", false)).toEqual([1]);
  });

  it("reads the descriptions only when asked to", () => {
    expect(matchingItems(items, "gitlab", false)).toEqual([]);
    expect(matchingItems(items, "gitlab", true)).toEqual([2]);
    expect(matchingItems(items, "upstream", true)).toEqual([1, 2]);
  });
});

describe("the protocol's guards", () => {
  it("takes a well-formed prompt, and nothing that only shares its command", () => {
    const prompt = {
      command: "hostPrompt",
      id: 1,
      prompt: { kind: "input", prompt: "Username", password: false },
      labels: { ok: "OK", cancel: "Cancel" }
    };
    expect(isHostPromptMessage(prompt)).toBe(true);
    expect(isHostPromptMessage({ command: "hostPrompt" })).toBe(false);
    expect(isHostPromptMessage({ ...prompt, prompt: { kind: "quiz" } })).toBe(false);
    expect(isHostPromptMessage({ command: "loadCommits", id: 1 })).toBe(false);
    expect(isHostPromptMessage(null)).toBe(false);
  });

  it("tells the page's replies from its requests", () => {
    expect(isHostPromptReply({ command: "hostPromptReady" })).toBe(true);
    expect(isHostPromptReply({ command: "hostPromptAnswer", id: 2, answer: null })).toBe(true);
    expect(isHostPromptReply({ command: "hostPromptAnswer", id: 2 })).toBe(false);
    expect(isHostPromptReply({ command: "loadBranches", hard: true, token: 1 })).toBe(false);
  });
});
