import { describe, expect, it } from "vitest";

import { fileChangeRevision } from "@ging/core/backend/utils/fileChangeRevision";

const SHA = "a".repeat(40);

describe("fileChangeRevision", () => {
  it("reads a file change from its commit", () => {
    expect(fileChangeRevision(SHA, undefined)).toBe(SHA);
  });

  it("reads a stash's untracked file from the stash's third parent", () => {
    expect(fileChangeRevision(SHA, "untracked")).toBe(`${SHA}^3`);
  });
});
