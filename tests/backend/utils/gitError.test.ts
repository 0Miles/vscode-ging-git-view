import { describe, expect, it } from "vitest";

import { formatGitError, isRemoteUpdatedSinceCheckoutError } from "@/backend/utils/gitError";

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

/** git's output for a push refused with `reason`, hints included. */
function rejectedPush(reason: string, hints: string[] = []): Error {
  return new Error(
    [
      "To github.com:acme/repo.git",
      ` ! [rejected]        main -> main (${reason})`,
      "error: failed to push some refs to 'github.com:acme/repo.git'",
      ...hints.map((hint) => `hint: ${hint}`)
    ].join("\n")
  );
}

describe("isRemoteUpdatedSinceCheckoutError", () => {
  it("recognises a lease refused because the remote tip was never integrated", () => {
    const error = rejectedPush("remote ref updated since checkout", [
      "Updates were rejected because the tip of the remote-tracking",
      "branch has been updated since the last checkout."
    ]);
    expect(isRemoteUpdatedSinceCheckoutError(error)).toBe(true);
  });

  it("does not claim a non-fast-forward rejection", () => {
    expect(isRemoteUpdatedSinceCheckoutError(rejectedPush("non-fast-forward"))).toBe(false);
  });

  it("does not claim a lease refused for stale info", () => {
    expect(isRemoteUpdatedSinceCheckoutError(rejectedPush("stale info"))).toBe(false);
  });

  it("does not claim an unrelated failure", () => {
    expect(
      isRemoteUpdatedSinceCheckoutError(
        new Error("fatal: 'nope' does not appear to be a git repository")
      )
    ).toBe(false);
    expect(isRemoteUpdatedSinceCheckoutError("plain string failure")).toBe(false);
  });
});
