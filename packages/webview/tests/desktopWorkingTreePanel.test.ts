import { afterEach, describe, expect, it, vi } from "vitest";

import type { AmendBasis, WorkingTreeStatus } from "@ging/shared/backend/types";
import type {
  WorkingTreeStatusMessage,
  WorkingTreeStrings
} from "@ging/webview/desktop/workingTree/protocol";

import { createVscodeMock } from "./setup";

// The working tree panel on a desktop graph page (#403): opened by the host,
// drawing the status each answer brings, asking the host to stage, unstage and
// commit, and reading itself anew when the graph is told to refresh. The
// desktop Electron E2E (apps/desktop/e2e/workingTree.spec.ts) drives it with
// real git behind it.

const STRINGS: WorkingTreeStrings = {
  title: "Source Control",
  close: "Close",
  message: "Commit message",
  commit: "Commit",
  staged: "Staged Changes",
  unstaged: "Changes",
  conflicted: "Merge Conflicts",
  stage: "Stage",
  stageAll: "Stage All",
  unstage: "Unstage",
  unstageAll: "Unstage All",
  clean: "No changes.",
  more: "{0} more files",
  submodule: "A submodule.",
  changes: {
    added: "Added",
    modified: "Modified",
    deleted: "Deleted",
    renamed: "Renamed",
    copied: "Copied",
    typeChanged: "Type changed",
    untracked: "Untracked",
    conflicted: "Conflicted"
  },
  amend: "Amend last commit",
  amendCommit: "Amend Commit",
  signOff: "Sign off",
  signOffDetail: "Add a Signed-off-by line.",
  cannotAmend: {
    unborn: "No commit yet.",
    merge: "A merge is in progress.",
    rebase: "A rebase is in progress.",
    cherrypick: "A cherry-pick is in progress.",
    revert: "A revert is in progress."
  },
  amendPushed: "Already on {0}. Amend <it> anyway?",
  amendPushedConfirm: "Amend",
  identityUnknown: "Git does not know who you are.",
  openMergeTool: "Open in Merge Tool",
  markResolved: "Mark Resolved",
  inProgress: "{0} in progress",
  operations: { merge: "Merge", rebase: "Rebase", cherrypick: "Cherry-pick", revert: "Revert" },
  continue: "Continue",
  abort: "Abort"
};

/** An amend refused for HEAD, commit `head`, being on origin/main. */
const pushedAs = (head: string) => ({
  refused: { kind: "pushed" as const, head, remoteBranches: ["origin/main"] }
});

/** HEAD as an amend would start from it. */
const HEAD_MESSAGE = "Last commit\n\nIts body.";
const AMENDABLE: AmendBasis = { possible: true, message: HEAD_MESSAGE };

const STATUS: WorkingTreeStatus = {
  branch: "main",
  staged: [{ path: "src/moved name.ts", oldPath: "src/old.ts", change: "renamed" }],
  unstaged: [
    { path: "README.md", change: "modified" },
    { path: "docs/<new>.md", change: "untracked" },
    { path: "vendor/lib", change: "modified", submodule: true }
  ],
  conflicted: [{ path: "both.txt", change: "conflicted" }]
};

/** What the panel asked in the page's dialog, and how to answer it. */
type Asked = { html: string; actionName: string; confirmed: () => void };

async function load(open = false, options: { confirm?: boolean } = { confirm: true }) {
  vi.resetModules();
  localStorage.clear();
  if (open) localStorage.setItem("ging.workingTree.open", "true");
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.body.className = "";
  const mock = createVscodeMock();
  const asked: Asked[] = [];
  const { startWorkingTreePanel } =
    await import("@ging/webview/desktop/workingTree/workingTreePanel");
  startWorkingTreePanel(
    options.confirm === true
      ? { confirm: (html, actionName, confirmed) => asked.push({ html, actionName, confirmed }) }
      : {}
  );
  return Object.assign(mock, { asked });
}

afterEach(() => localStorage.clear());

function hear(data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { data }));
}

const answer = (
  request: WorkingTreeStatusMessage["request"],
  status: WorkingTreeStatus | null = STATUS,
  error: string | null = null,
  more: Partial<Pick<WorkingTreeStatusMessage, "amend" | "refused">> = {}
): WorkingTreeStatusMessage => ({
  command: "workingTreeStatus",
  request,
  status,
  amend: AMENDABLE,
  error,
  strings: STRINGS,
  ...more
});

const panel = () => document.getElementById("workingTree")!;
const rows = (area: string) =>
  Array.from(panel().querySelectorAll<HTMLElement>(`.wtFile[data-area="${area}"]`));
const button = (selector: string) => panel().querySelector<HTMLButtonElement>(selector)!;
const box = () => panel().querySelector("textarea")!;
const type = (text: string) => {
  box().value = text;
  box().dispatchEvent(new Event("input", { bubbles: true }));
};

describe("the working tree panel", () => {
  it("stays closed until the host opens it, then reads the working tree", async () => {
    const mock = await load();
    expect(panel().hidden).toBe(true);
    expect(mock.sentMessages).toEqual([]);

    hear({ command: "workingTreeShow" });

    expect(panel().hidden).toBe(false);
    expect(document.body.classList.contains("workingTreeOpen")).toBe(true);
    expect(mock.sentMessages).toEqual([{ command: "workingTreeLoad" }]);
  });

  it("opens as the viewer left it", async () => {
    const mock = await load(true);

    expect(panel().hidden).toBe(false);
    expect(mock.sentMessages).toEqual([{ command: "workingTreeLoad" }]);
  });

  it("draws each list from the status, a submodule with no button of its own", async () => {
    await load(true);
    hear(answer("workingTreeLoad"));

    expect(rows("staged").map((row) => row.querySelector(".wtName")!.textContent)).toEqual([
      "moved name.ts"
    ]);
    expect(rows("staged")[0].title).toBe("src/old.ts → src/moved name.ts");
    expect(rows("unstaged").map((row) => row.dataset.path)).toEqual([
      "README.md",
      "docs/<new>.md",
      "vendor/lib"
    ]);
    expect(rows("unstaged")[1].querySelector(".wtLetter")!.textContent).toBe("U");
    expect(rows("unstaged")[2].querySelector("button")).toBeNull();
    expect(rows("unstaged")[2].title).toBe("vendor/lib\nA submodule.");
    expect(panel().querySelector(".wtBranch")!.textContent).toBe("main");
  });

  it("asks to stage and unstage whole files, each named: a rename by both its paths, no submodule, no conflict", async () => {
    const mock = await load(true);
    hear(answer("workingTreeLoad"));
    mock.sentMessages.length = 0;

    rows("unstaged")[0].querySelector<HTMLButtonElement>("[data-action=stage]")!.click();
    hear(answer("workingTreeStage"));
    rows("staged")[0].querySelector<HTMLButtonElement>("[data-action=unstage]")!.click();
    hear(answer("workingTreeUnstage"));
    button("[data-action=stageAll]").click();
    hear(answer("workingTreeStage"));
    button("[data-action=unstageAll]").click();

    expect(mock.sentMessages).toEqual([
      { command: "workingTreeStage", paths: ["README.md"] },
      { command: "workingTreeUnstage", paths: ["src/moved name.ts", "src/old.ts"] },
      { command: "workingTreeStage", paths: ["README.md", "docs/<new>.md"] },
      { command: "workingTreeUnstage", paths: ["src/moved name.ts", "src/old.ts"] }
    ]);
  });

  it("asks nothing more while a request is out", async () => {
    const mock = await load(true);
    hear(answer("workingTreeLoad"));
    mock.sentMessages.length = 0;

    button("[data-action=stageAll]").click();
    button("[data-action=stageAll]").click();

    expect(mock.sentMessages).toEqual([
      { command: "workingTreeStage", paths: ["README.md", "docs/<new>.md"] }
    ]);
    expect(button("[data-action=stageAll]").getAttribute("aria-disabled")).toBe("true");
  });

  it("commits only with something staged and a message, and clears the message once done", async () => {
    const mock = await load(true);
    hear(answer("workingTreeLoad", { ...STATUS, staged: [] }));
    type("Subject\n\nBody");
    expect(button(".wtCommitButton").getAttribute("aria-disabled")).toBe("true");

    hear(answer("workingTreeStage"));
    expect(box().value).toBe("Subject\n\nBody");
    type("   ");
    expect(button(".wtCommitButton").getAttribute("aria-disabled")).toBe("true");
    type("Subject\n\nBody");
    expect(button(".wtCommitButton").hasAttribute("aria-disabled")).toBe(false);
    mock.sentMessages.length = 0;

    button(".wtCommitButton").click();
    expect(mock.sentMessages).toEqual([
      { command: "workingTreeCommit", message: "Subject\n\nBody" }
    ]);

    hear(answer("workingTreeCommit", { ...STATUS, staged: [] }));
    expect(box().value).toBe("");
  });

  it("commits on Ctrl+Enter in the message, and keeps the keys from the graph", async () => {
    const mock = await load(true);
    hear(answer("workingTreeLoad"));
    type("Keyboard");
    mock.sentMessages.length = 0;
    const heardByDocument = vi.fn();
    document.addEventListener("keydown", heardByDocument);

    box().dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Enter", ctrlKey: true })
    );
    box().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));

    document.removeEventListener("keydown", heardByDocument);
    expect(mock.sentMessages).toEqual([{ command: "workingTreeCommit", message: "Keyboard" }]);
    expect(heardByDocument).not.toHaveBeenCalled();
  });

  it("keeps the message and says why when a commit fails", async () => {
    await load(true);
    hear(answer("workingTreeLoad"));
    type("Refused");
    button(".wtCommitButton").click();

    hear(answer("workingTreeCommit", STATUS, "pre-commit hook refused it"));

    expect(box().value).toBe("Refused");
    expect(panel().querySelector("[role=alert]")!.textContent).toBe("pre-commit hook refused it");
  });

  it("reads itself anew when the graph refreshes, once the request out is answered", async () => {
    const mock = await load(true);
    hear(answer("workingTreeLoad"));
    mock.sentMessages.length = 0;

    hear({ command: "refresh" });
    expect(mock.sentMessages).toEqual([{ command: "workingTreeLoad" }]);

    // A refresh while a request is out waits for its answer.
    hear({ command: "refresh" });
    expect(mock.sentMessages).toHaveLength(1);
    hear(answer("workingTreeLoad"));
    expect(mock.sentMessages).toEqual([
      { command: "workingTreeLoad" },
      { command: "workingTreeLoad" }
    ]);
  });

  it("says so when nothing has changed", async () => {
    await load(true);
    hear(answer("workingTreeLoad", { branch: "main", staged: [], unstaged: [], conflicted: [] }));

    expect(panel().querySelector(".wtClean")!.textContent).toBe("No changes.");
  });

  it("keeps the keyboard, caret and selection in the message box when an answer redraws the panel mid-sentence (#479)", async () => {
    const mock = await load(true);
    hear(answer("workingTreeLoad"));
    box().focus();
    type("Half a sentence");
    box().setSelectionRange(5, 9, "backward");
    const blurred = vi.fn();
    box().addEventListener("blur", blurred);

    // The watcher woke the graph (#451): a refresh, the panel's read, its answer.
    hear({ command: "refresh" });
    expect(mock.sentMessages.at(-1)).toEqual({ command: "workingTreeLoad" });
    hear(answer("workingTreeLoad"));

    expect(document.activeElement).toBe(box());
    expect(blurred).not.toHaveBeenCalled();
    expect([box().selectionStart, box().selectionEnd, box().selectionDirection]).toEqual([
      5,
      9,
      "backward"
    ]);
    // What is typed next still goes where the user was typing.
    box().setRangeText(" more", box().selectionEnd, box().selectionEnd, "end");
    box().dispatchEvent(new Event("input", { bubbles: true }));
    expect(box().value).toBe("Half a se morentence");
  });

  it("lets the keyboard reach a file's button, and keeps it there across redraws", async () => {
    const mock = await load(true);
    hear(answer("workingTreeLoad"));
    mock.sentMessages.length = 0;
    const stageReadme = () =>
      rows("unstaged")[0].querySelector<HTMLButtonElement>("[data-action=stage]")!;

    // Focusable, as no button is that is hidden from view rather than faded.
    stageReadme().focus();
    expect(document.activeElement).toBe(stageReadme());

    // A redraw with nothing moved: back on the same button of the same file.
    hear({ command: "refresh" });
    expect(document.activeElement).toBe(stageReadme());
    hear(answer("workingTreeLoad"));
    expect(document.activeElement).toBe(stageReadme());

    // Pressed, it waits for the answer without losing the keyboard.
    stageReadme().click();
    expect(document.activeElement).toBe(stageReadme());
    expect(stageReadme().getAttribute("aria-disabled")).toBe("true");

    // Staged, README.md leaves the list: the keyboard goes to the file that
    // took its place.
    hear(
      answer("workingTreeStage", {
        ...STATUS,
        staged: [...STATUS.staged, { path: "README.md", change: "modified" }],
        unstaged: STATUS.unstaged.slice(1)
      })
    );
    const next = rows("unstaged")[0];
    expect(next.dataset.path).toBe("docs/<new>.md");
    expect(document.activeElement).toBe(next.querySelector("[data-action=stage]"));
  });

  it("draws a long list cut short, says how many it left out, and still stages them all", async () => {
    const mock = await load(true);
    const many = Array.from({ length: 503 }, (_, i) => ({
      path: `out/file-${i}.js`,
      change: "untracked" as const
    }));
    hear(answer("workingTreeLoad", { ...STATUS, unstaged: many }));
    mock.sentMessages.length = 0;

    expect(rows("unstaged")).toHaveLength(500);
    expect(panel().querySelector(".wtMore")!.textContent).toBe("3 more files");
    expect(panel().querySelector('[data-area="unstaged"] .wtCount')!.textContent).toBe("503");

    button("[data-action=stageAll]").click();
    expect(mock.sentMessages).toEqual([
      { command: "workingTreeStage", paths: many.map((file) => file.path) }
    ]);
  });

  // A conflict (#410).
  it("offers a conflicted file to the merge tool and to be marked resolved, and nothing to stage", async () => {
    const mock = await load(true);
    hear(answer("workingTreeLoad"));
    mock.sentMessages.length = 0;
    const conflict = rows("conflicted")[0];

    expect(
      Array.from(conflict.querySelectorAll("button")).map((b) => b.getAttribute("aria-label"))
    ).toEqual(["Open in Merge Tool", "Mark Resolved"]);
    expect(conflict.querySelector("[data-action=stage]")).toBeNull();

    conflict.querySelector<HTMLButtonElement>("[data-action=mergeTool]")!.click();
    hear(answer("workingTreeMergeTool"));
    rows("conflicted")[0].querySelector<HTMLButtonElement>("[data-action=resolve]")!.click();

    expect(mock.sentMessages).toEqual([
      { command: "workingTreeMergeTool", path: "both.txt" },
      { command: "workingTreeResolve", paths: ["both.txt"] }
    ]);
  });

  it("names the operation in progress, continued only once no conflict is left, or aborted", async () => {
    const mock = await load(true);
    hear(answer("workingTreeLoad", { ...STATUS, operation: "cherrypick" }));
    mock.sentMessages.length = 0;
    const bar = () => panel().querySelector<HTMLElement>(".wtOperation")!;

    expect(bar().querySelector(".wtOperationTitle")!.textContent).toBe("Cherry-pick in progress");
    expect(button("[data-action=continue]").getAttribute("aria-disabled")).toBe("true");
    button("[data-action=continue]").click();
    expect(mock.sentMessages).toEqual([]);

    hear(answer("workingTreeResolve", { ...STATUS, conflicted: [], operation: "cherrypick" }));
    expect(button("[data-action=continue]").hasAttribute("aria-disabled")).toBe(false);
    button("[data-action=continue]").click();
    expect(mock.sentMessages).toEqual([{ command: "workingTreeContinue" }]);
    hear(answer("workingTreeContinue", { ...STATUS, conflicted: [], operation: "cherrypick" }));
    button("[data-action=abort]").click();
    expect(mock.sentMessages).toEqual([
      { command: "workingTreeContinue" },
      { command: "workingTreeAbort" }
    ]);

    // Done with, it goes.
    hear(answer("workingTreeAbort", { ...STATUS, conflicted: [] }));
    expect(panel().querySelector(".wtOperation")).toBeNull();
  });

  it("closes, gives back the graph's width, and stays closed", async () => {
    const mock = await load(true);
    hear(answer("workingTreeLoad"));
    mock.sentMessages.length = 0;

    button("[data-action=close]").click();
    hear({ command: "refresh" });

    expect(panel().hidden).toBe(true);
    expect(document.body.classList.contains("workingTreeOpen")).toBe(false);
    expect(localStorage.getItem("ging.workingTree.open")).toBe("false");
    expect(mock.sentMessages).toEqual([]);
  });
});

// Amend and sign-off (#407): two tick boxes under the message. The host's
// answers say what an amend would start from, and refuse an amend of a pushed
// HEAD until the user says to go on, asked in the page's own dialog.
describe("the working tree panel's amend and sign-off", () => {
  const tick = (action: "amend" | "signOff", on = true) => {
    const input = panel().querySelector<HTMLInputElement>(`input[data-action="${action}"]`)!;
    input.checked = on;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const tickBox = (action: string) =>
    panel().querySelector<HTMLInputElement>(`input[data-action="${action}"]`)!;
  const commitButton = () => button(".wtCommitButton");
  const alert = () => panel().querySelector("[role=alert]")!.textContent;

  it("starts unticked, Amend filling an empty message box with HEAD's message and taking it back untouched", async () => {
    await load(true);
    hear(answer("workingTreeLoad"));
    expect(tickBox("amend").checked).toBe(false);
    expect(tickBox("signOff").checked).toBe(false);
    expect(commitButton().textContent).toBe("Commit");

    tick("amend");
    expect(box().value).toBe(HEAD_MESSAGE);
    expect(commitButton().textContent).toBe("Amend Commit");

    tick("amend", false);
    expect(box().value).toBe("");
    expect(commitButton().textContent).toBe("Commit");
  });

  it("keeps what the user wrote, before Amend is ticked or after", async () => {
    await load(true);
    hear(answer("workingTreeLoad"));

    type("Mine");
    tick("amend");
    expect(box().value).toBe("Mine");
    tick("amend", false);
    expect(box().value).toBe("Mine");

    type("");
    tick("amend");
    type(`${HEAD_MESSAGE} (reworded)`);
    tick("amend", false);
    expect(box().value).toBe(`${HEAD_MESSAGE} (reworded)`);
  });

  it("amends with nothing staged, the message alone, and says which flags it asks for", async () => {
    const mock = await load(true);
    hear(answer("workingTreeLoad", { ...STATUS, staged: [] }));
    expect(commitButton().getAttribute("aria-disabled")).toBe("true");

    tick("amend");
    tick("signOff");
    expect(commitButton().hasAttribute("aria-disabled")).toBe(false);
    mock.sentMessages.length = 0;
    commitButton().click();

    expect(mock.sentMessages).toEqual([
      { command: "workingTreeCommit", message: HEAD_MESSAGE, amend: true, signOff: true }
    ]);
  });

  it("signs a plain commit off, and keeps Sign off ticked while Amend unticks once done", async () => {
    const mock = await load(true);
    hear(answer("workingTreeLoad"));
    tick("signOff");
    type("Signed");
    mock.sentMessages.length = 0;
    commitButton().click();
    expect(mock.sentMessages).toEqual([
      { command: "workingTreeCommit", message: "Signed", signOff: true }
    ]);
    hear(answer("workingTreeCommit"));

    tick("amend");
    commitButton().click();
    hear(answer("workingTreeCommit"));

    expect(tickBox("amend").checked).toBe(false);
    expect(tickBox("signOff").checked).toBe(true);
    expect(box().value).toBe("");
  });

  it("offers no amend when HEAD cannot be amended, saying why, and unticks it when that comes about", async () => {
    await load(true);
    hear(answer("workingTreeLoad", STATUS, null, { amend: { possible: false, reason: "unborn" } }));
    expect(tickBox("amend").disabled).toBe(true);
    expect(tickBox("amend").closest("label")!.title).toBe("No commit yet.");

    hear(answer("workingTreeLoad"));
    tick("amend");
    expect(box().value).toBe(HEAD_MESSAGE);

    // A merge stopped on a conflict, as the next read finds.
    hear({ command: "refresh" });
    hear(answer("workingTreeLoad", STATUS, null, { amend: { possible: false, reason: "merge" } }));

    expect(tickBox("amend").checked).toBe(false);
    expect(tickBox("amend").disabled).toBe(true);
    expect(tickBox("amend").closest("label")!.title).toBe("A merge is in progress.");
    expect(box().value).toBe("");
  });

  it("asks before amending a pushed HEAD, and asks the host again only once told to go on", async () => {
    const mock = await load(true);
    hear(answer("workingTreeLoad"));
    tick("amend");
    commitButton().click();
    const refused = {
      refused: {
        kind: "pushed" as const,
        head: "c0ffee",
        remoteBranches: ["origin/main", "up<stream>/main", "fork/a", "fork/b"]
      }
    };
    mock.sentMessages.length = 0;

    hear(answer("workingTreeCommit", STATUS, null, refused));

    // Nothing failed, nothing is sent yet: a question, in the page's dialog,
    // naming the first three branches, each escaped.
    expect(alert()).toBe("");
    expect(mock.sentMessages).toEqual([]);
    expect(mock.asked).toHaveLength(1);
    expect(mock.asked[0].html).toBe(
      "Already on <b>origin&#x2F;main</b>, <b>up&lt;stream&gt;&#x2F;main</b>, <b>fork&#x2F;a</b>, …. Amend &lt;it&gt; anyway?"
    );
    expect(mock.asked[0].actionName).toBe("Amend");
    // The message stays while the question stands.
    expect(box().value).toBe(HEAD_MESSAGE);

    mock.asked[0].confirmed();

    expect(mock.sentMessages).toEqual([
      {
        command: "workingTreeCommit",
        message: HEAD_MESSAGE,
        amend: true,
        rewritePushed: "c0ffee"
      }
    ]);
  });

  it("asks again about the new HEAD when HEAD moved before the yes reached the host", async () => {
    const mock = await load(true);
    hear(answer("workingTreeLoad"));
    tick("amend");
    commitButton().click();
    hear(answer("workingTreeCommit", STATUS, null, pushedAs("aaa111")));
    mock.asked[0].confirmed();
    expect(mock.sentMessages.at(-1)).toEqual(
      expect.objectContaining({ amend: true, rewritePushed: "aaa111" })
    );

    // The host found HEAD elsewhere by then: refused again, for that commit.
    hear(answer("workingTreeCommit", STATUS, null, pushedAs("bbb222")));

    expect(mock.asked).toHaveLength(2);
    mock.asked[1].confirmed();
    expect(mock.sentMessages.at(-1)).toEqual({
      command: "workingTreeCommit",
      message: HEAD_MESSAGE,
      amend: true,
      rewritePushed: "bbb222"
    });
  });

  it("follows HEAD with a message left as Amend put it, and keeps Amend through a read that failed", async () => {
    await load(true);
    hear(answer("workingTreeLoad"));
    tick("amend");
    expect(box().value).toBe(HEAD_MESSAGE);

    // Committed elsewhere: the untouched box takes the new HEAD's message.
    hear({ command: "refresh" });
    hear(answer("workingTreeLoad", STATUS, null, { amend: { possible: true, message: "Newer" } }));
    expect(box().value).toBe("Newer");

    // The basis could not be read this time: Amend stays as it was.
    hear({ command: "refresh" });
    hear(answer("workingTreeLoad", STATUS, "could not read", { amend: null }));
    expect(tickBox("amend").checked).toBe(true);
    expect(box().value).toBe("Newer");

    // Once edited, the box is the user's: HEAD moving again leaves it.
    type("Newer, edited");
    hear({ command: "refresh" });
    hear(answer("workingTreeLoad", STATUS, null, { amend: { possible: true, message: "Newest" } }));
    expect(box().value).toBe("Newer, edited");
  });

  it("leaves a pushed HEAD alone, its message kept, when the question is not answered yes", async () => {
    const mock = await load(true);
    hear(answer("workingTreeLoad"));
    tick("amend");
    commitButton().click();
    mock.sentMessages.length = 0;

    hear(
      answer("workingTreeCommit", STATUS, null, {
        refused: { kind: "pushed", head: "c0ffee", remoteBranches: ["origin/main"] }
      })
    );

    expect(mock.asked).toHaveLength(1);
    expect(mock.sentMessages).toEqual([]);
    expect(box().value).toBe(HEAD_MESSAGE);
    expect(tickBox("amend").checked).toBe(true);
  });

  it("says the warning instead, and amends nothing, with no dialog to ask in", async () => {
    const mock = await load(true, {});
    hear(answer("workingTreeLoad"));
    tick("amend");
    commitButton().click();
    mock.sentMessages.length = 0;

    hear(
      answer("workingTreeCommit", STATUS, null, {
        refused: { kind: "pushed", head: "c0ffee", remoteBranches: ["origin/main"] }
      })
    );

    expect(alert()).toBe("Already on origin/main. Amend <it> anyway?");
    expect(mock.sentMessages).toEqual([]);
  });

  it("says why the host declined a commit, in its own words", async () => {
    await load(true);
    hear(answer("workingTreeLoad"));
    type("Anonymous");
    commitButton().click();

    hear(answer("workingTreeCommit", STATUS, null, { refused: { kind: "identityUnknown" } }));
    expect(alert()).toBe("Git does not know who you are.");
    expect(box().value).toBe("Anonymous");

    tick("amend");
    commitButton().click();
    hear(
      answer("workingTreeCommit", STATUS, null, {
        refused: { kind: "cannotAmend", reason: "rebase" }
      })
    );
    expect(alert()).toBe("A rebase is in progress.");
  });

  it("keeps the keyboard on a tick box across the redraw it makes", async () => {
    await load(true);
    hear(answer("workingTreeLoad"));
    tickBox("signOff").focus();

    tick("signOff");

    expect(document.activeElement).toBe(tickBox("signOff"));
    expect(tickBox("signOff").checked).toBe(true);
  });
});
