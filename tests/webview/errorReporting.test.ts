import { beforeAll, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY } from "@/backend/utils/contextMenuVisibility";
import type * as GG from "@/types";

import { createVscodeMock, receive, setupHtml } from "./setup";

const REPO = "/workspace/my-repo";

const viewState: GG.GitGraphViewState = {
  autoCenterCommitDetailsView: true,
  commitDetailsViewLocation: "Inline",
  referenceLabelAlignment: "Normal",
  combineLocalAndRemoteBranchLabels: false,
  dialogDeleteBranchForceDelete: false,
  dialogCherryPickNoCommit: false,
  dialogAddTagType: "annotated",
  dialogCreateBranchCheckOut: false,
  dialogMergeNoFastForward: true,
  dialogMergeSquash: false,
  dialogResetMode: "mixed",
  dialogMemory: {},
  contextMenuActionsVisibility: DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY,
  customBranchGlobPatterns: [],
  customEmojiShortcodeMappings: {},
  dateFormat: "Date & Time",
  dateCustomFormat: "DD MMM YYYY",
  defaultColumnVisibility: { date: true, author: true, commit: true },
  enhancedAccessibility: false,
  fetchAvatars: false,
  fileTreeCompactFolders: true,
  fileViewType: "File Tree",
  graphColours: ["#0085d9"],
  graphStyle: "rounded",
  initialLoadCommits: 300,
  issueLinkingRegex: "",
  issueLinkingUrl: "",
  keybindings: { find: "f", refresh: "r", scrollToHead: "h", scrollToStash: "s" },
  lastActiveRepo: null,
  loadMoreAutomatically: true,
  loadMoreCount: 100,
  markdown: false,
  muteCommitsNotAncestorsOfHead: false,
  muteMergeCommits: true,
  onLoadScrollToHead: false,
  referenceInputSpaceSubstitution: "None",
  repos: { [REPO]: { columnWidths: null } },
  scmMultiRepoSelection: true,
  showCurrentBranchByDefault: false,
  uncommittedChangesAtHead: false,
  showSpecificBranches: [],
  showRemoteBranches: true,
  showTags: true
};

/** A response whose payload breaks the handler applying it — the shape of the
 *  failure this suite is about: a handler that throws part-way through, leaving
 *  the view half-applied (issue #39). */
const brokenResponse = {
  command: "loadBranches",
  branches: null,
  head: null,
  hard: true,
  isRepo: true,
  filter: []
} as unknown as GG.ResponseMessage;

function reports(mock: ReturnType<typeof createVscodeMock>): GG.WebviewErrorReport[] {
  return mock.sentMessages
    .filter((m): m is GG.RequestReportError => m.command === "reportError")
    .map((m) => m.report);
}

describe("failures the webview cannot handle (issue #39)", () => {
  let mock: ReturnType<typeof createVscodeMock>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(viewState);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await import("@/webview/main");
  });

  it("reports the message it could not apply, with the stack", () => {
    mock.clearMessages();
    receive(brokenResponse);

    expect(reports(mock)).toHaveLength(1);
    const report = reports(mock)[0]!;
    expect(report.origin).toBe("message");
    // The command is what turns "something broke" into "this operation did not
    // complete" — the host shows the user nothing without it.
    expect(report.command).toBe("loadBranches");
    expect(report.message).toContain("TypeError");
    expect(report.stack).toBeTypeOf("string");
  });

  it("still hands the developer their console stack", () => {
    // Catching must not make an error that used to be obvious in the Webview
    // Developer Tools any harder to notice.
    expect(consoleError).toHaveBeenCalled();
  });

  it("reports every occurrence, leaving what to do about repeats to the host", () => {
    // Both surfaces the host owns treat repetition differently (ADR-0016), and
    // neither rule can be applied from here without pre-empting the other.
    mock.clearMessages();
    receive(brokenResponse);
    receive(brokenResponse);

    expect(reports(mock)).toHaveLength(2);
  });

  it("reports what escapes into a timer or an event handler", () => {
    mock.clearMessages();
    window.dispatchEvent(
      new ErrorEvent("error", { error: new Error("late boom"), message: "late boom" })
    );

    expect(reports(mock)).toEqual([
      {
        origin: "uncaught",
        // No message was being applied, so there is no operation to name.
        command: null,
        message: "Error: late boom",
        stack: expect.stringContaining("late boom")
      }
    ]);
  });

  it("reports a rejected promise nobody caught", () => {
    mock.clearMessages();
    // Built by hand: jsdom has no PromiseRejectionEvent constructor, but it
    // dispatches the event the same way the webview's browser does.
    const event = new Event("unhandledrejection");
    Object.defineProperty(event, "reason", { value: new Error("dangling") });
    window.dispatchEvent(event);

    expect(reports(mock)).toMatchObject([
      { origin: "unhandledRejection", command: null, message: "Error: dangling" }
    ]);
  });

  it("keeps listening after a failure, rather than dying with it", () => {
    mock.clearMessages();
    receive({
      command: "loadCommits",
      commits: null,
      head: null,
      moreCommitsAvailable: false,
      hard: true
    } as unknown as GG.ResponseMessage);

    // The catch swallowed the exception, not the listener: the next message is
    // still received, and its own failure still reported under its own name.
    expect(reports(mock)).toMatchObject([{ origin: "message", command: "loadCommits" }]);
  });
});
