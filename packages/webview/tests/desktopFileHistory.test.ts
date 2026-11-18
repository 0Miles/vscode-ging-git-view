import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FileHistoryEntry } from "@ging/shared/backend/types";
import type {
  FileHistoryMessage,
  FileHistoryStrings
} from "@ging/webview/desktop/fileHistory/protocol";
import type { CdvFileMenuTarget } from "@ging/webview/gitGraphView";

import { createVscodeMock } from "./setup";

// The file history panel (#408) on a desktop graph page, with the graph faked
// down to the one seam it uses — the Commit Details View's file menu — and the
// host played by posting its messages. The Electron E2E
// (apps/desktop/e2e/fileHistory.spec.ts) drives it with real git behind it;
// the CDV's own side of the seam is cdvFileMenuItems.test.ts's.

const STRINGS: FileHistoryStrings = {
  menuItem: "View File History",
  title: "History of {0}",
  upTo: "up to {0}",
  close: "Close File History",
  loadMore: "Load More",
  empty: "No commit changed this file.",
  renamedFrom: "Renamed from {0}",
  copiedFrom: "Copied from {0}",
  asPath: "As {0}",
  added: "Added",
  deleted: "Deleted",
  merge: "Merge",
  submodule: "Submodule {0} → {1}"
};

const START = "f".repeat(40);

function entry(n: number, more: Partial<FileHistoryEntry> = {}): FileHistoryEntry {
  return {
    hash: String(n).repeat(40).slice(0, 40),
    parents: [
      String(n + 1)
        .repeat(40)
        .slice(0, 40)
    ],
    author: "Alice",
    authorEmail: "alice@example.com",
    date: 1_700_000_000 + n,
    subject: `commit ${n}`,
    change: "M",
    path: "src/new.ts",
    oldPath: "src/new.ts",
    submodule: null,
    ...more
  };
}

const ENTRIES = [
  entry(1),
  entry(2, { parents: ["a".repeat(40), "b".repeat(40)], subject: "Merge side" }),
  entry(3, { change: "R", oldPath: "src/old.ts" }),
  entry(4, { path: "src/old.ts", oldPath: "src/old.ts" }),
  entry(5, { change: "A", path: "src/old.ts", oldPath: "src/old.ts" })
];

const page = (more: Partial<FileHistoryMessage> = {}): FileHistoryMessage => ({
  command: "fileHistory",
  path: "src/new.ts",
  // The host opened it itself (the menu), unless a test says which request.
  request: null,
  start: START,
  first: true,
  entries: ENTRIES,
  more: false,
  error: null,
  strings: STRINGS,
  ...more
});

function hear(data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { data }));
}

let menu: ((file: CdvFileMenuTarget) => ContextMenuElement[]) | null;
let mock: ReturnType<typeof createVscodeMock>;

async function load() {
  vi.resetModules();
  document.head.innerHTML = "";
  document.body.innerHTML = '<button id="graphThing">graph</button>';
  document.body.className = "";
  mock = createVscodeMock();
  menu = null;
  const { startFileHistoryPanel } =
    await import("@ging/webview/desktop/fileHistory/fileHistoryPanel");
  return startFileHistoryPanel(
    { addCdvFileMenuItems: (items) => (menu = items) },
    { formatDate: (seconds) => `day ${seconds - 1_700_000_000}` }
  );
}

const panel = () => document.getElementById("fileHistory")!;
const rows = () => Array.from(panel().querySelectorAll<HTMLElement>(".fhEntry"));
const sent = () => mock.sentMessages as unknown[];
const key = (target: Element, name: string, type: "keydown" | "keyup" = "keydown") =>
  target.dispatchEvent(new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true }));

const cdvFile = (more: Partial<CdvFileMenuTarget> = {}): CdvFileMenuTarget => ({
  repo: "/repo",
  commitHash: "c".repeat(40),
  filePath: "src/new.ts",
  oldFilePath: "src/new.ts",
  type: "M",
  ...more
});

describe("the file history panel", () => {
  beforeEach(async () => {
    await load();
  });

  it("tells the host it listens, and offers nothing in the CDV's menu until it has the words", () => {
    expect(sent()).toEqual([{ command: "fileHistoryReady" }]);
    expect(menu!(cdvFile())).toEqual([]);

    hear({ command: "fileHistoryStrings", strings: STRINGS });

    expect(menu!(cdvFile())).toEqual([
      expect.objectContaining({ title: "View File History", icon: "history" })
    ]);
    // Nothing opened by the words alone.
    expect(document.getElementById("fileHistory")).toBeNull();
  });

  it("opens from a CDV file on its history up to that commit, asking the host for it", () => {
    hear({ command: "fileHistoryStrings", strings: STRINGS });
    mock.clearMessages();

    (menu!(cdvFile())[0] as ContextMenuItem).onClick();

    expect(panel().hidden).toBe(false);
    expect(panel().getAttribute("aria-busy")).toBe("true");
    expect(document.body.classList.contains("fileHistoryOpen")).toBe(true);
    expect(sent()).toEqual([
      { command: "fileHistoryOpen", request: 1, path: "src/new.ts", start: "c".repeat(40) }
    ]);
  });

  it("reads the uncommitted changes' file from HEAD, and offers a stash's untracked file nothing", () => {
    hear({ command: "fileHistoryStrings", strings: STRINGS });
    mock.clearMessages();

    (menu!(cdvFile({ commitHash: "*" }))[0] as ContextMenuItem).onClick();

    expect(sent()).toEqual([
      { command: "fileHistoryOpen", request: 1, path: "src/new.ts", start: null }
    ]);
    expect(menu!(cdvFile({ origin: "untracked" }))).toEqual([]);
  });

  it("lists each commit with the path the file had there, and how it came to have it", () => {
    hear(page());

    expect(panel().querySelector(".fhTitle")!.textContent).toBe("History of new.ts");
    expect(panel().querySelector(".fhPath")!.textContent).toBe("src/new.ts · up to fffffff");
    expect(rows().map((row) => row.querySelector(".fhSubject")!.textContent)).toEqual(
      ENTRIES.map((e) => e.subject)
    );
    expect(rows()[0].querySelector(".fhMeta")!.textContent).toBe("1111111 · Alice · day 1");
    expect(rows().map((row) => row.querySelector(".fhNote")?.textContent ?? null)).toEqual([
      null,
      "Merge",
      "Renamed from src/old.ts",
      "As src/old.ts",
      "Added · As src/old.ts"
    ]);
  });

  it("asks for an entry's diff by what the host needs to read it, the old path with it", () => {
    hear(page());
    mock.clearMessages();

    rows()[2].click();

    expect(sent()).toEqual([
      {
        command: "fileHistoryDiff",
        entry: {
          hash: ENTRIES[2].hash,
          change: "R",
          path: "src/new.ts",
          oldPath: "src/old.ts",
          submodule: null
        }
      }
    ]);
    expect(rows()[2].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(rows()[2]);
  });

  it("moves through the entries with the arrow keys, opening one on Enter", () => {
    hear(page());
    mock.clearMessages();
    expect(document.activeElement).toBe(rows()[0]);

    key(rows()[0], "ArrowDown");
    key(rows()[1], "ArrowDown");
    expect(document.activeElement).toBe(rows()[2]);
    key(rows()[2], "End");
    expect(document.activeElement).toBe(rows()[4]);
    key(rows()[4], "ArrowUp");
    key(rows()[3], "Enter");

    expect(sent()).toEqual([
      { command: "fileHistoryDiff", entry: expect.objectContaining({ hash: ENTRIES[3].hash }) }
    ]);
  });

  it("keeps the keys pressed in it from the graph, and closes on Escape's way up", () => {
    hear(page());
    const heard: string[] = [];
    document.addEventListener("keydown", (e) => heard.push(e.key));
    document.addEventListener("keyup", (e) => heard.push(e.key));
    document.getElementById("graphThing")!.focus();

    key(rows()[0], "ArrowDown");
    key(rows()[1], "Escape");
    expect(panel().hidden).toBe(false);
    key(rows()[1], "Escape", "keyup");

    expect(heard).toEqual([]);
    expect(panel().hidden).toBe(true);
    expect(document.body.classList.contains("fileHistoryOpen")).toBe(false);
  });

  it("gives the keyboard back to what had it before it opened", () => {
    hear({ command: "fileHistoryStrings", strings: STRINGS });
    const before = document.getElementById("graphThing")!;
    before.focus();
    (menu!(cdvFile())[0] as ContextMenuItem).onClick();
    hear(page());

    panel().querySelector<HTMLButtonElement>(".fhClose")!.click();

    expect(document.activeElement).toBe(before);
  });

  it("loads the next page of the history shown, adding to the list", () => {
    hear(page({ entries: ENTRIES.slice(0, 2), more: true }));
    mock.clearMessages();
    const more = panel().querySelector<HTMLButtonElement>(".fhMore")!;
    expect(more.textContent).toBe("Load More");

    more.click();
    // Pressed twice while the page is out: asked once.
    panel().querySelector<HTMLButtonElement>(".fhMore")!.click();

    expect(sent()).toEqual([{ command: "fileHistoryMore", request: null }]);
    expect(panel().getAttribute("aria-busy")).toBe("true");

    hear(page({ first: false, entries: ENTRIES.slice(2), more: false }));

    expect(rows().map((row) => row.dataset.hash)).toEqual(ENTRIES.map((e) => e.hash));
    expect(panel().querySelector(".fhMore")).toBeNull();
    expect(panel().hasAttribute("aria-busy")).toBe(false);
  });

  it("drops a later page of a history it no longer shows", () => {
    hear(page({ entries: ENTRIES.slice(0, 2), more: true }));
    panel().querySelector<HTMLButtonElement>(".fhMore")!.click();
    hear(
      page({ path: "other.ts", entries: [entry(9, { path: "other.ts", oldPath: "other.ts" })] })
    );

    hear(page({ first: false, entries: ENTRIES.slice(2) }));

    expect(rows().map((row) => row.dataset.hash)).toEqual([entry(9).hash]);
  });

  it("shows the history opened last, though the one opened before it answers after it", () => {
    hear({ command: "fileHistoryStrings", strings: STRINGS });
    (menu!(cdvFile({ filePath: "a.ts" }))[0] as ContextMenuItem).onClick();
    (menu!(cdvFile({ filePath: "b.ts" }))[0] as ContextMenuItem).onClick();
    const b = entry(8, { path: "b.ts", oldPath: "b.ts" });
    const a = entry(9, { path: "a.ts", oldPath: "a.ts" });

    // B's git is quicker than A's.
    hear(page({ request: 2, path: "b.ts", entries: [b], more: true }));
    hear(page({ request: 1, path: "a.ts", entries: [a] }));
    // Nor does a later page of A's land on B.
    hear(page({ request: 1, path: "a.ts", first: false, entries: [a] }));

    expect(panel().querySelector(".fhTitle")!.textContent).toBe("History of b.ts");
    expect(rows().map((row) => row.dataset.hash)).toEqual([b.hash]);
  });

  it("drops the first page of every history it asked for once the host opens one of its own", () => {
    hear({ command: "fileHistoryStrings", strings: STRINGS });
    (menu!(cdvFile({ filePath: "a.ts" }))[0] as ContextMenuItem).onClick();
    const picked = entry(8, { path: "picked.ts", oldPath: "picked.ts" });

    hear(page({ path: "picked.ts", entries: [picked] }));
    hear(page({ request: 1, path: "a.ts", entries: [entry(9)] }));

    expect(rows().map((row) => row.dataset.hash)).toEqual([picked.hash]);
  });

  it("tells the host when it closes, so the history's git stops", () => {
    hear(page());
    mock.clearMessages();

    panel().querySelector<HTMLButtonElement>(".fhClose")!.click();

    expect(sent()).toEqual([{ command: "fileHistoryClose" }]);
  });

  it("says when no commit changed the file, and why when it could not be read", () => {
    hear(page({ entries: [] }));
    expect(panel().querySelector(".fhEmpty")!.textContent).toBe("No commit changed this file.");

    hear(page({ entries: [], error: "bad revision" }));
    expect(panel().querySelector(".fhError")!.textContent).toBe("bad revision");
    expect(panel().querySelector(".fhEmpty")).toBeNull();
  });

  it("names a submodule's moves by their commits, and opens no diff of them", () => {
    hear(
      page({
        path: "sub",
        entries: [
          entry(1, {
            path: "sub",
            oldPath: "sub",
            submodule: { from: "a".repeat(40), to: "b".repeat(40) }
          }),
          entry(2, {
            path: "sub",
            oldPath: "sub",
            change: "A",
            submodule: { from: null, to: "a".repeat(40) }
          })
        ]
      })
    );
    mock.clearMessages();

    expect(rows().map((row) => row.querySelector(".fhNote")!.textContent)).toEqual([
      "Submodule aaaaaaa → bbbbbbb",
      "Submodule — → aaaaaaa"
    ]);
    expect(rows()[0].getAttribute("aria-disabled")).toBe("true");
    rows()[0].click();
    expect(sent()).toEqual([]);
  });
});
