import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";

import { createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// A Force with lease push is refused when the remote tip was fetched but never
// integrated (ADR-0025). git's own line for that — "remote ref updated since
// checkout" — says nothing a user can act on, so the host reports the fact and
// the webview explains it: pull or rebase first, or choose the Force option to
// overwrite anyway. No one-click force: overwriting is a separate choice.

const L = getWebviewLocalizedStrings();

const GIT_LINE = "[rejected]        main -> main (remote ref updated since checkout)";

function dialogText(): string {
  return document.getElementById("dialog")?.textContent ?? "";
}

function dismiss() {
  document.getElementById("dialogDismiss")?.dispatchEvent(new MouseEvent("click"));
}

describe("a refused push", () => {
  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock();
    setupHtml(makeViewState());
    await import("@/webview/main");
  });

  afterEach(dismiss);

  it("explains a lease refused for an unintegrated remote tip, naming the Force option", () => {
    receive({
      command: "pushBranch",
      status: GIT_LINE,
      remoteUpdatedSinceCheckout: true
    });

    // English literals, not `L.dialogPushForceLeaseRefused`: rebuilding the
    // expectation from the same template the code uses could never disagree.
    const text = dialogText();
    expect(text).toContain("Pull or rebase first, then push again.");
    expect(text).toContain(`To overwrite anyway, choose ${L.dialogPushForceForce}.`);
    expect(text).not.toContain("{0}");
    expect(text, "git's own line is kept alongside the explanation").toContain(GIT_LINE);
    expect(document.getElementById("dialogAction"), "no one-click force").toBeNull();
  });

  it("shows any other push failure the way it always has", () => {
    const nonFastForward = "[rejected]        main -> main (non-fast-forward)";
    receive({
      command: "pushBranch",
      status: nonFastForward,
      remoteUpdatedSinceCheckout: false
    });

    const text = dialogText();
    expect(text).toContain(L.unableToPushBranch);
    expect(text).toContain(nonFastForward);
    expect(text).not.toContain("Pull or rebase first");
  });
});
