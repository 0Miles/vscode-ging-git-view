import { describe, expect, it, vi } from "vitest";

import type { WelcomeContent, WindowStateMessage } from "@ging/webview/desktop/window/protocol";

import { createVscodeMock } from "./setup";
import { startDesktop } from "./startDesktop";

// The desktop entry on the window's own page (#393): the tab strip, drawn from
// what the host sends and asking it to focus or close a Tab, and the Welcome
// page under it, with the host prompt listener the Welcome page asks through.
// The webview E2E (e2e/webview/windowPage.spec.ts) drives it in a real browser.

async function load() {
  vi.resetModules();
  const mock = createVscodeMock();
  document.documentElement.dataset.gingPage = "window";
  document.body.innerHTML = '<div id="tabStrip" hidden></div><main id="welcome"></main>';
  await startDesktop();
  return mock;
}

const STATE: WindowStateMessage = {
  command: "windowState",
  tabs: [
    { id: 3, title: "alpha", tooltip: "/repos/alpha", focused: false, asking: true },
    { id: 7, title: "<beta>", tooltip: "/repos/beta", focused: true, asking: false }
  ],
  notice: null,
  welcome: null,
  strings: { closeTab: "Close Tab" }
};

const WELCOME: WelcomeContent = {
  recent: [
    { path: "/repos/beta", name: "<beta>", missing: false },
    { path: "/gone/alpha", name: "alpha", missing: true }
  ],
  strings: {
    openFolder: "Open Folder...",
    initRepo: "Initialize Repository...",
    recent: "Recent",
    noRecent: "Repositories you open are listed here.",
    missing: "Not found",
    forget: "Remove from Recent"
  }
};

function hear(data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { data }));
}

const strip = () => document.getElementById("tabStrip")!;
const tabs = () => Array.from(strip().querySelectorAll<HTMLElement>(".tab"));

describe("the desktop entry on the window's page", () => {
  it("says it listens, for the tab strip and for the Welcome page's prompts", async () => {
    const mock = await load();
    expect(mock.sentMessages).toEqual([{ command: "windowReady" }, { command: "hostPromptReady" }]);
  });

  it("draws the Tabs the host sends, the focused one and the one asking marked", async () => {
    await load();
    hear(STATE);

    expect(strip().hidden).toBe(false);
    expect(tabs().map((tab) => tab.querySelector(".tabTitle")!.textContent)).toEqual([
      "alpha",
      "<beta>"
    ]);
    expect(tabs().map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    expect(tabs()[0].title).toBe("/repos/alpha");
    expect(tabs()[0].querySelector(".tabAsking")).not.toBeNull();
    expect(tabs()[1].querySelector(".tabAsking")).toBeNull();
    expect(tabs()[1].querySelector(".tabClose")!.getAttribute("aria-label")).toBe("Close Tab");
  });

  it("asks the host to focus a Tab clicked, and to close one whose close button is", async () => {
    const mock = await load();
    hear(STATE);
    mock.sentMessages.length = 0;

    tabs()[0].querySelector<HTMLElement>(".tabTitle")!.click();
    tabs()[1].querySelector<HTMLElement>(".tabClose")!.click();
    tabs()[0].dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    tabs()[1].dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));

    expect(mock.sentMessages).toEqual([
      { command: "focusTab", id: 3 },
      { command: "closeTab", id: 7 },
      { command: "closeTab", id: 3 },
      { command: "focusTab", id: 7 }
    ]);
    // Asked, not done: the strip changes when the host says it has.
    expect(tabs()).toHaveLength(2);
  });

  it("hides the strip with no Tab, and says on the Welcome page why, when there is a why", async () => {
    await load();
    hear(STATE);
    hear({
      ...STATE,
      tabs: [],
      notice: { title: "Unable to load GING", detail: "Cannot open <x>." }
    });

    expect(strip().hidden).toBe(true);
    const welcome = document.getElementById("welcome")!;
    expect(welcome.querySelector("h2")!.textContent).toBe("Unable to load GING");
    expect(welcome.querySelector("p")!.textContent).toBe("Cannot open <x>.");
  });

  it("offers Open Folder, Initialize Repository and the recent list, a folder that is gone marked", async () => {
    await load();
    hear({ ...STATE, tabs: [], welcome: WELCOME });

    const welcome = document.getElementById("welcome")!;
    expect(
      Array.from(welcome.querySelectorAll(".welcomeAction")).map((b) => b.textContent)
    ).toEqual(["Open Folder...", "Initialize Repository..."]);
    expect(welcome.querySelector("h3")!.textContent).toBe("Recent");
    const rows = Array.from(welcome.querySelectorAll<HTMLElement>(".recentRepo"));
    expect(
      rows.map((row) => ({
        name: row.querySelector(".recentName")!.textContent,
        path: row.querySelector(".recentPath")!.textContent,
        missing: row.querySelector(".recentMissing")?.textContent ?? null,
        marked: row.classList.contains("missing")
      }))
    ).toEqual([
      { name: "<beta>", path: "/repos/beta", missing: null, marked: false },
      { name: "alpha", path: "/gone/alpha", missing: "Not found", marked: true }
    ]);
    expect(rows[0].querySelector(".recentForget")!.getAttribute("aria-label")).toBe(
      "Remove from Recent"
    );
  });

  it("says the recent list is empty when it is", async () => {
    await load();
    hear({ ...STATE, tabs: [], welcome: { ...WELCOME, recent: [] } });

    const welcome = document.getElementById("welcome")!;
    expect(welcome.querySelector(".recentList")).toBeNull();
    expect(welcome.querySelector(".recentEmpty")!.textContent).toBe(
      "Repositories you open are listed here."
    );
  });

  it("asks the host to open a folder, initialize one, open or forget a recent repository", async () => {
    const mock = await load();
    hear({ ...STATE, tabs: [], welcome: WELCOME });
    mock.sentMessages.length = 0;
    const welcome = document.getElementById("welcome")!;

    welcome.querySelector<HTMLElement>('[data-welcome="openFolder"] span')!.click();
    welcome.querySelector<HTMLElement>('[data-welcome="initRepo"]')!.click();
    welcome.querySelectorAll<HTMLElement>(".recentName")[1].click();
    welcome.querySelectorAll<HTMLElement>(".recentForget")[0].click();
    welcome.querySelector<HTMLElement>("h3")!.click();

    expect(mock.sentMessages).toEqual([
      { command: "openFolder" },
      { command: "initRepo" },
      { command: "openRecent", path: "/gone/alpha" },
      { command: "forgetRecent", path: "/repos/beta" }
    ]);
  });

  it("ignores messages that are not the window's state", async () => {
    await load();
    hear(STATE);
    hear({ command: "loadRepos", repos: {}, lastActiveRepo: null });

    expect(tabs()).toHaveLength(2);
  });
});

describe("the desktop entry on a window page missing its parts", () => {
  it("reports the host's mistake instead of starting nothing in silence", async () => {
    vi.resetModules();
    const mock = createVscodeMock();
    document.documentElement.dataset.gingPage = "window";
    document.body.innerHTML = "";
    await startDesktop();

    expect(mock.sentMessages).toEqual([
      {
        command: "reportError",
        report: expect.objectContaining({ message: expect.stringContaining("window page") })
      }
    ]);
  });
});
