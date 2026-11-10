import { describe, expect, it } from "vitest";

import { openDocumentKeys } from "@ging/core/extension/openDocuments";

describe("openDocumentKeys", () => {
  it("counts a text tab's document as open", () => {
    expect(openDocumentKeys([{ kind: "text", uri: "file:///a.ts" }], [])).toEqual(
      new Set(["file:///a.ts"])
    );
  });

  it("counts both sides of a diff tab as open", () => {
    const tabs = [{ kind: "diff" as const, original: "git:/a.ts", modified: "file:///a.ts" }];
    expect(openDocumentKeys(tabs, [])).toEqual(new Set(["git:/a.ts", "file:///a.ts"]));
  });

  // Webviews, terminals, notebooks and custom editors hold no text document.
  it("counts nothing for a tab without a text document", () => {
    expect(openDocumentKeys([{ kind: "other" }], [])).toEqual(new Set());
  });

  // Tabs and visible editors are updated separately, so a visible editor whose
  // tab isn't listed (yet) still holds its document open.
  it("counts every visible editor's document as open too", () => {
    expect(
      openDocumentKeys([{ kind: "text", uri: "file:///a.ts" }], ["file:///b.ts", "file:///a.ts"])
    ).toEqual(new Set(["file:///a.ts", "file:///b.ts"]));
  });
});
