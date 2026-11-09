import { describe, expect, it } from "vitest";

import { blameToggle } from "@/extension/blameToggle";

describe("blameToggle", () => {
  it("turns blame off when it is on, with no workspace value in the way", () => {
    expect(blameToggle({ effective: true, workspaceValue: undefined })).toEqual({
      next: false,
      overriddenByWorkspace: false
    });
  });

  it("turns blame on when it is off", () => {
    expect(blameToggle({ effective: false, workspaceValue: undefined })).toEqual({
      next: true,
      overriddenByWorkspace: false
    });
  });

  // The user sees blame off because the workspace says so. Pressing toggle means
  // "turn it on": the user value becomes true, and the workspace still wins.
  it("flips what the user sees, and reports the workspace value still winning", () => {
    expect(blameToggle({ effective: false, workspaceValue: false })).toEqual({
      next: true,
      overriddenByWorkspace: true
    });
  });

  it("reports the override the other way round too", () => {
    expect(blameToggle({ effective: true, workspaceValue: true })).toEqual({
      next: false,
      overriddenByWorkspace: true
    });
  });
});
