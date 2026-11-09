import { describe, expect, it } from "vitest";

import { blameToggle } from "@/extension/blameToggle";

const noOverrides = { workspaceValue: undefined, workspaceFolderValue: undefined };

describe("blameToggle", () => {
  it("turns blame off when it is on, with no workspace value in the way", () => {
    expect(blameToggle({ effective: true, ...noOverrides })).toEqual({
      next: false,
      overriddenByWorkspace: false
    });
  });

  it("turns blame on when it is off", () => {
    expect(blameToggle({ effective: false, ...noOverrides })).toEqual({
      next: true,
      overriddenByWorkspace: false
    });
  });

  // The user sees blame off because the workspace says so. Pressing toggle means
  // "turn it on": the user value becomes true, and the workspace still wins.
  it("flips what the user sees, and reports the workspace value still winning", () => {
    expect(
      blameToggle({ effective: false, workspaceValue: false, workspaceFolderValue: undefined })
    ).toEqual({ next: true, overriddenByWorkspace: true });
  });

  it("reports the override the other way round too", () => {
    expect(
      blameToggle({ effective: true, workspaceValue: true, workspaceFolderValue: undefined })
    ).toEqual({ next: false, overriddenByWorkspace: true });
  });

  it("reports a folder-level value overriding the user setting", () => {
    expect(
      blameToggle({ effective: false, workspaceValue: undefined, workspaceFolderValue: false })
    ).toEqual({ next: true, overriddenByWorkspace: true });
  });

  // The folder value is the one in effect for the file, so the workspace value
  // under it does not matter.
  it("judges by the folder value when the folder and the workspace disagree", () => {
    expect(
      blameToggle({ effective: true, workspaceValue: false, workspaceFolderValue: true })
    ).toEqual({ next: false, overriddenByWorkspace: true });
  });
});
