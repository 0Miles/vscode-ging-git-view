import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { GitCommitNode } from "@/backend/types";
import { getWebviewLocalizedStrings } from "@/extension/webviewL10n";
import type * as GG from "@/types";

import {
  clickItem,
  createVscodeMock,
  makeViewState,
  receive,
  rightClick,
  setupHtml
} from "./setup";

// A ref name is free text to `String.prototype.replace`. Handed over as the
// replacement *string*, `$&` in it expands to the placeholder it replaced, and
// `` $` `` and `$'` to the template before and after it; `escapeHtml` leaves
// `$` alone, and turns `'` into `&#x27;`, which makes `$'` a `$&` (#264). And a template filled one `.replace` at a time lets the
// second placeholder land inside the first value, when the name contains
// `{1}`. git allows both in a branch name, so each is put through a dialog
// that names a branch and the branch checked out.

const L = getWebviewLocalizedStrings();
const E = "…"; // the rendered form of the ELLIPSIS entity

const HEAD = "main$'";
const OTHER = "fix/$&-$1-{1}";

const commits: GitCommitNode[] = [
  {
    hash: "aaa111",
    parentHashes: ["bbb222"],
    author: "Alice",
    email: "alice@example.com",
    date: 1700000000,
    message: "Tip",
    refs: [{ hash: "aaa111", name: HEAD, type: "head" }]
  },
  {
    hash: "bbb222",
    parentHashes: [],
    author: "Bob",
    email: "bob@example.com",
    date: 1699000000,
    message: "Base",
    refs: [{ hash: "bbb222", name: OTHER, type: "head" }]
  }
];

function dialogText(): string {
  return document.getElementById("dialog")?.textContent ?? "";
}

/** The bold names the dialog shows, in order. */
function boldNames(): string[] {
  return Array.from(document.querySelectorAll("#dialog b i"), (i) => i.textContent ?? "");
}

describe("a ref name holding replacement patterns", () => {
  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock();
    setupHtml(makeViewState());
    await import("@/webview/main");
    receive({
      command: "loadBranches",
      token: 0,
      branches: [HEAD, OTHER],
      head: HEAD,
      hard: true,
      isRepo: true,
      filter: []
    } satisfies GG.ResponseMessage);
    receive({
      command: "loadCommits",
      token: 0,
      commits,
      head: "aaa111",
      moreCommitsAvailable: false,
      hard: true
    } satisfies GG.ResponseMessage);
  });

  afterEach(() => {
    document.getElementById("dialogCancel")?.dispatchEvent(new MouseEvent("click"));
  });

  function openRefMenu() {
    const chip = Array.from(document.querySelectorAll<HTMLElement>("#commitTable .gitRef")).find(
      (elem) => elem.dataset.name === OTHER
    );
    expect(chip, OTHER).toBeDefined();
    rightClick(chip!);
  }

  it("is shown as written in a one-placeholder dialog", () => {
    openRefMenu();
    clickItem(L.renameBranch + E);
    expect(boldNames()).toEqual([OTHER]);
  });

  it("is shown as written, beside the checked-out branch, in a two-placeholder dialog", () => {
    openRefMenu();
    clickItem(L.merge + E);
    // Filled one placeholder at a time, the checked-out branch landed on the
    // "{1}" inside the other branch's name.
    expect(boldNames()).toEqual([OTHER, HEAD]);
  });

  it("is shown as written after a localized label, in the delete dialog", () => {
    openRefMenu();
    clickItem(L.deleteBranch + E);
    expect(boldNames()).toEqual([OTHER]);
    expect(dialogText()).toContain(L.labelBranch);
  });
});
