import { describe, expect, it } from "vitest";

import { formatGitError } from "@/backend/utils/gitError";

describe("formatGitError", () => {
  it("surfaces remote-provided reasons and strips the 'remote:' prefix", () => {
    const raw = [
      "remote: ====================",
      "remote: Pushing to a protected branch is not allowed.",
      "To github.com:acme/repo.git",
      "! [remote rejected] main -> main (protected branch hook declined)",
      "error: failed to push some refs to 'github.com:acme/repo.git'"
    ].join("\n");
    expect(formatGitError(new Error(raw))).toBe("Pushing to a protected branch is not allowed.");
  });

  it("falls back to the rejection reason when there is no remote message", () => {
    const raw = [
      "To github.com:acme/repo.git",
      " ! [rejected]        main -> main (non-fast-forward)",
      "error: failed to push some refs to 'github.com:acme/repo.git'",
      "hint: Updates were rejected because the tip of your current branch is behind"
    ].join("\n");
    expect(formatGitError(new Error(raw))).toBe(
      "[rejected]        main -> main (non-fast-forward)"
    );
  });

  it("strips the 'fatal:'/'error:' prefix from git's primary line", () => {
    expect(formatGitError(new Error("fatal: couldn't find remote ref nope"))).toBe(
      "couldn't find remote ref nope"
    );
  });

  it("returns the first meaningful line when nothing is recognised", () => {
    expect(formatGitError(new Error("\n\nsomething unexpected happened\n"))).toBe(
      "something unexpected happened"
    );
  });

  it("handles non-Error inputs", () => {
    expect(formatGitError("plain string failure")).toBe("plain string failure");
  });

  it("returns the trimmed raw text when there are no non-empty lines", () => {
    expect(formatGitError(new Error("   \n  \n"))).toBe("");
  });
});
