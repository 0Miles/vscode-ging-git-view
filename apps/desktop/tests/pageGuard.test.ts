import { describe, expect, it } from "vitest";

import { keepPageInPlace } from "@ging/desktop/pageGuard";

// A page of the app stays the page the main process put there (#393): a Tab's
// view navigated to another Tab's URL would draw that Tab's graph while its
// messages still reach its own instance.

function fakeContents() {
  let openHandler: ((details: { url: string }) => { action: string }) | null = null;
  const listeners = new Map<string, (event: { preventDefault(): void }) => void>();
  const contents = {
    setWindowOpenHandler: (handler: typeof openHandler) => {
      openHandler = handler;
    },
    on: (name: string, listener: (event: { preventDefault(): void }) => void) => {
      listeners.set(name, listener);
      return contents;
    }
  };
  return {
    contents: contents as unknown as Parameters<typeof keepPageInPlace>[0],
    open: (url: string) => openHandler!({ url }),
    navigate: () => {
      let prevented = false;
      listeners.get("will-navigate")!({ preventDefault: () => (prevented = true) });
      return prevented;
    }
  };
}

describe("keepPageInPlace", () => {
  it("opens no window: a link to the web goes to the opener, anything else nowhere", () => {
    const opened: string[] = [];
    const page = fakeContents();
    keepPageInPlace(page.contents, { openExternalUrl: (url) => void opened.push(url) });

    expect(page.open("https://example.com/a")).toEqual({ action: "deny" });
    expect(page.open("ging://app/tab?id=2")).toEqual({ action: "deny" });
    expect(opened).toEqual(["https://example.com/a"]);
  });

  it("refuses every navigation the page asks for", () => {
    const page = fakeContents();
    keepPageInPlace(page.contents, { openExternalUrl: () => {} });

    expect(page.navigate()).toBe(true);
  });
});
