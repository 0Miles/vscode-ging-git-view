import { describe, expect, it, vi } from "vitest";

import type { WindowStateMessage } from "@ging/webview/desktop/window/protocol";

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
  strings: { closeTab: "Close Tab" }
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
