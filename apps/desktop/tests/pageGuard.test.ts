import { describe, expect, it } from "vitest";

import { keepPageInPlace } from "@ging/desktop/pageGuard";
import { openWebUrl } from "@ging/desktop/ports/opener";

// A page of the app stays the page the main process put there (#393): a Tab's
// view navigated to another Tab's URL would draw that Tab's graph while its
// messages still reach its own instance. What it asked for goes to the
// opener, which alone lets web addresses out (#391).

function fakeContents() {
  let openHandler: ((details: { url: string }) => { action: string }) | null = null;
  const listeners = new Map<string, (event: { url: string; preventDefault(): void }) => void>();
  const contents = {
    setWindowOpenHandler: (handler: typeof openHandler) => {
      openHandler = handler;
    },
    on: (name: string, listener: (event: { url: string; preventDefault(): void }) => void) => {
      listeners.set(name, listener);
      return contents;
    }
  };
  return {
    contents: contents as unknown as Parameters<typeof keepPageInPlace>[0],
    open: (url: string) => openHandler!({ url }),
    navigate: (url: string) => {
      let prevented = false;
      listeners.get("will-navigate")!({ url, preventDefault: () => (prevented = true) });
      return prevented;
    }
  };
}

/** The app's own link handling over a browser that records what it opened. */
function linksOut() {
  const opened: string[] = [];
  const logged: string[] = [];
  const opener = {
    openExternalUrl: (url: string) =>
      openWebUrl(
        {
          openExternal: async (href) => {
            opened.push(href);
          }
        },
        { log: (line) => logged.push(line), logError: (line) => logged.push(line) },
        url
      )
  };
  return { opener, opened, logged };
}

describe("keepPageInPlace", () => {
  it("opens no window: a link to the web goes to the browser, anything else nowhere", () => {
    const { opener, opened } = linksOut();
    const page = fakeContents();
    keepPageInPlace(page.contents, opener);

    expect(page.open("https://example.com/a")).toEqual({ action: "deny" });
    expect(page.open("ging://app/tab?id=2")).toEqual({ action: "deny" });
    expect(page.open("file:///C:/Windows/System32/calc.exe")).toEqual({ action: "deny" });
    expect(opened).toEqual(["https://example.com/a"]);
  });

  it("refuses every navigation the page asks for, and sends one to the web to the browser", () => {
    const { opener, opened, logged } = linksOut();
    const page = fakeContents();
    keepPageInPlace(page.contents, opener);

    expect(page.navigate("ging://app/tab?id=2")).toBe(true);
    expect(page.navigate("https://example.com/b")).toBe(true);

    expect(opened).toEqual(["https://example.com/b"]);
    expect(logged).toEqual(["opener: not opening ging://app/tab?id=2: not a web address"]);
  });
});
