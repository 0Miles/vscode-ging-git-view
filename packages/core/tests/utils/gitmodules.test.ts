import { describe, expect, it } from "vitest";

import { submodulePathsFromGitmodules } from "@/backend/utils/gitmodules";

describe("submodulePathsFromGitmodules", () => {
  it("extracts path values from submodule sections", () => {
    const content = [
      '[submodule "libs/foo"]',
      "\tpath = libs/foo",
      "\turl = https://example.com/foo.git",
      '[submodule "bar"]',
      "\tpath = vendor/bar",
      "\turl = ../bar.git"
    ].join("\n");
    expect(submodulePathsFromGitmodules(content)).toEqual(["libs/foo", "vendor/bar"]);
  });

  it("ignores non-submodule sections and unrelated properties", () => {
    const content = [
      "[core]",
      "\tpath = should-be-ignored",
      '[submodule "a"]',
      "\turl = https://example.com/a.git",
      "\tpath = sub/a",
      "\tbranch = main"
    ].join("\n");
    expect(submodulePathsFromGitmodules(content)).toEqual(["sub/a"]);
  });

  it("returns an empty array when there are no submodules", () => {
    expect(submodulePathsFromGitmodules("[core]\n\tbare = false\n")).toEqual([]);
    expect(submodulePathsFromGitmodules("")).toEqual([]);
  });

  it("tolerates CRLF line endings and extra whitespace", () => {
    const content = '[submodule "x"]\r\n   path =  spaced/x  \r\n';
    expect(submodulePathsFromGitmodules(content)).toEqual(["spaced/x"]);
  });
});
