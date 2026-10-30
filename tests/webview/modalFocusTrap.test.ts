import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

import { clickItem, createVscodeMock, makeViewState, receive, setupHtml } from "./setup";

// A modal dialog is modal to the keyboard too (#141), on the WAI-ARIA APG's
// modal dialog pattern: everything behind it is `inert`, focus moves into it
// and Tab cycles there, Enter keeps meaning "confirm" without pressing a
// focused button twice, and focus goes back where it came from on close.
//
// jsdom moves no focus on Tab and implements no `inert`, so what is pinned
// here is the attributes and what the handlers do; that the browser then
// honours them — Tab really skipping the background, a click on it really
// landing nowhere — was measured in Chromium, as ADR-0019 records.

const L = getWebviewLocalizedStrings();
const E = "…"; // the rendered form of the ELLIPSIS entity

const commits: GitCommitNode[] = [
  {
    hash: "aaa111",
    parentHashes: ["bbb222"],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000100,
    message: "Tip commit",
    refs: [{ hash: "aaa111", name: "main", type: "head" }]
  },
  {
    hash: "bbb222",
    parentHashes: [],
    author: "Bob",
    email: "bob@example.com",
    date: 1700000000,
    message: "Base commit",
    refs: []
  }
];

function commitsResponse(list: GitCommitNode[]): GG.ResponseMessage {
  return {
    command: "loadCommits",
    token: 0,
    commits: list,
    head: "aaa111",
    moreCommitsAvailable: false,
    hard: true
  };
}

const dialog = () => document.getElementById("dialog")!;
const dialogShown = () => dialog().classList.contains("active");
const row = (hash: string) =>
  document.querySelector<HTMLElement>(`#commitTable tr.commit[data-hash="${hash}"]`);

/** An action's error, which the host raises as a dialog with only a Dismiss. */
const raiseError = () => receive({ command: "fetch", status: "fatal: unable to access remote" });

/** A Yes/Cancel question with a listener on Yes, raised from a row's menu. */
function raiseConfirmation() {
  row("aaa111")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  clickItem(L.revert + E);
}

/** A form dialog — a branch name, then a checkbox — raised from a row's menu. */
function raiseForm() {
  row("aaa111")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  clickItem(L.createBranch + E);
}

/** Press a key the way the browser delivers it: at whatever holds focus. */
function press(key: string, init: KeyboardEventInit = {}) {
  const target = document.activeElement ?? document.body;
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

let mock: ReturnType<typeof createVscodeMock>;
const sent = (command: string) => mock.sentMessages.filter((m) => m.command === command);

describe("a modal dialog and the keyboard", () => {
  beforeAll(async () => {
    vi.resetModules();
    mock = createVscodeMock();
    setupHtml(makeViewState());
    await import("@/webview/main");
    receive({
      command: "loadBranches",
      token: 0,
      branches: ["main"],
      head: "main",
      hard: true,
      isRepo: true,
      filter: []
    });
    receive(commitsResponse(commits));
  });

  beforeEach(() => {
    if (dialogShown()) document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape" }));
    mock.sentMessages.length = 0;
  });

  describe("the background", () => {
    it("is inert while a dialog is up — every body child but the dialog and its backing", () => {
      raiseError();
      const children = Array.from(document.body.children);
      const background = children.filter((c) => c.id !== "dialog" && c.id !== "dialogBacking");
      expect(background.map((c) => c.id)).toEqual(
        expect.arrayContaining(["controls", "content", "footer", "findWidget", "contextMenu"])
      );
      for (const child of background) expect(child.hasAttribute("inert"), child.id).toBe(true);
      expect(dialog().hasAttribute("inert")).toBe(false);
      expect(document.getElementById("dialogBacking")!.hasAttribute("inert")).toBe(false);
    });

    it("takes in what arrives behind an open dialog, such as a docked Commit Details View", async () => {
      raiseError();
      const late = document.createElement("div");
      late.id = "commitDetails";
      document.body.appendChild(late);
      await Promise.resolve();
      expect(late.hasAttribute("inert")).toBe(true);
      late.remove();
    });

    it("is live again once the dialog closes", () => {
      raiseError();
      document.getElementById("dialogDismiss")!.click();
      for (const child of Array.from(document.body.children)) {
        expect(child.hasAttribute("inert"), child.id).toBe(false);
      }
    });
  });

  describe("the buttons", () => {
    it("are real buttons, keeping their ids", () => {
      raiseConfirmation();
      for (const id of ["dialogAction", "dialogDismiss"]) {
        const button = document.getElementById(id)!;
        expect(button.tagName, id).toBe("BUTTON");
        expect(button.getAttribute("type"), id).toBe("button");
      }
    });
  });

  describe("focus on opening", () => {
    it("goes to the dialog itself when it asks for nothing", () => {
      raiseConfirmation();
      expect(dialog().getAttribute("tabindex")).toBe("-1");
      expect(document.activeElement).toBe(dialog());
    });

    it("goes to the dialog itself for a progress dialog", () => {
      document.getElementById("fetchBtn")!.click();
      expect(document.getElementById("actionRunning")).not.toBeNull();
      expect(document.activeElement).toBe(dialog());
    });

    it("goes to the first input of a form dialog", () => {
      raiseForm();
      expect(document.activeElement).toBe(document.getElementById("dialogInput0"));
    });
  });

  describe("Tab", () => {
    it("steps forward through the dialog and wraps from the last control to the first", () => {
      raiseForm();
      const order = ["dialogInput0", "dialogInput1", "dialogAction", "dialogDismiss"];
      for (let i = 1; i <= order.length; i++) {
        const event = press("Tab");
        expect(event.defaultPrevented).toBe(true);
        expect(document.activeElement?.id).toBe(order[i % order.length]);
      }
    });

    it("steps backward with Shift and wraps from the first control to the last", () => {
      raiseForm();
      const event = press("Tab", { shiftKey: true });
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement?.id).toBe("dialogDismiss");
      press("Tab", { shiftKey: true });
      expect(document.activeElement?.id).toBe("dialogAction");
    });

    it("enters at either end from the dialog itself", () => {
      raiseConfirmation();
      press("Tab");
      expect(document.activeElement?.id).toBe("dialogAction");
      dialog().focus();
      press("Tab", { shiftKey: true });
      expect(document.activeElement?.id).toBe("dialogDismiss");
    });
  });

  describe("Enter", () => {
    it("confirms an untouched dialog, once", () => {
      raiseConfirmation();
      const event = press("Enter");
      expect(event.defaultPrevented).toBe(true);
      expect(sent("revertCommit")).toHaveLength(1);
    });

    it("leaves a focused button to the browser, so Dismiss dismisses rather than confirming too", () => {
      raiseConfirmation();
      document.getElementById("dialogDismiss")!.focus();
      const event = press("Enter");
      // The browser's own activation is what presses the button; the handler
      // must neither press Action nor cancel the key that would.
      expect(event.defaultPrevented).toBe(false);
      expect(sent("revertCommit")).toHaveLength(0);
      expect(dialogShown()).toBe(true);
    });

    it("still confirms from a checkbox, without the browser also toggling it", () => {
      raiseForm();
      const input = <HTMLInputElement>document.getElementById("dialogInput0");
      input.value = "topic";
      input.dispatchEvent(new KeyboardEvent("keyup", { key: "c" }));
      const checkbox = <HTMLInputElement>document.getElementById("dialogInput1");
      checkbox.focus();
      const event = press("Enter");
      expect(event.defaultPrevented).toBe(true);
      expect(sent("createBranch")).toHaveLength(1);
    });

    it("still confirms from a text input", () => {
      raiseForm();
      const input = <HTMLInputElement>document.getElementById("dialogInput0");
      input.value = "topic";
      input.dispatchEvent(new KeyboardEvent("keyup", { key: "c" }));
      const event = press("Enter");
      expect(event.defaultPrevented).toBe(true);
      expect(sent("createBranch")).toHaveLength(1);
    });

    it("leaves a link to the browser", () => {
      raiseConfirmation();
      const link = document.createElement("a");
      link.href = "mailto:alice@example.com";
      dialog().prepend(link);
      link.focus();
      const event = press("Enter");
      expect(event.defaultPrevented).toBe(false);
      expect(sent("revertCommit")).toHaveLength(0);
    });
  });

  describe("Space", () => {
    it("is left to the focused control: the handler presses nothing", () => {
      raiseConfirmation();
      document.getElementById("dialogDismiss")!.focus();
      const event = press(" ");
      expect(event.defaultPrevented).toBe(false);
      expect(sent("revertCommit")).toHaveLength(0);
    });
  });

  describe("focus on closing", () => {
    it("goes back to the element that held it when the dialog opened", () => {
      const opener = row("bbb222")!;
      opener.focus();
      raiseError();
      expect(document.activeElement).not.toBe(opener);
      document.getElementById("dialogDismiss")!.click();
      expect(document.activeElement).toBe(opener);
    });

    it("goes back the same way when Escape closes it", () => {
      const opener = row("bbb222")!;
      opener.focus();
      raiseError();
      document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape" }));
      expect(dialogShown()).toBe(false);
      expect(document.activeElement).toBe(opener);
    });

    it("goes back the same way when the dialog is answered", () => {
      const opener = row("aaa111")!;
      opener.focus();
      raiseConfirmation();
      press("Enter");
      expect(sent("revertCommit")).toHaveLength(1);
      expect(dialogShown()).toBe(false);
      expect(document.activeElement).toBe(opener);
    });

    it("finds the opener's row again when a redraw replaced it in the meantime", () => {
      row("bbb222")!.focus();
      raiseError();
      expect(document.activeElement, "the dialog took focus").toBe(dialog());
      receive(commitsResponse(commits));
      document.getElementById("dialogDismiss")!.click();
      expect(document.activeElement).toBe(row("bbb222"));
    });

    it("comes back across a dialog replaced by another, to the first one's opener", () => {
      const opener = row("bbb222")!;
      opener.focus();
      raiseError();
      raiseError();
      expect(document.activeElement, "the dialog took focus").toBe(dialog());
      document.getElementById("dialogDismiss")!.click();
      expect(document.activeElement).toBe(opener);
    });

    it("falls back to the commit table when the opener's row is gone", () => {
      row("bbb222")!.focus();
      raiseError();
      receive(commitsResponse([{ ...commits[0], parentHashes: [] }]));
      expect(row("bbb222")).toBeNull();
      document.getElementById("dialogDismiss")!.click();
      expect(document.activeElement).toBe(document.getElementById("commitTable"));
      receive(commitsResponse(commits));
    });
  });
});
