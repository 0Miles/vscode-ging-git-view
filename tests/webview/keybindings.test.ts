import { beforeAll, describe, expect, it, vi } from "vitest";

import { createVscodeMock, makeViewState, setupHtml } from "./setup";

function pressCtrl(key: string) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true }));
}

describe("keyboard shortcuts", () => {
  describe("with the default Find binding (CTRL/CMD + F)", () => {
    beforeAll(async () => {
      vi.resetModules();
      createVscodeMock();
      setupHtml(
        makeViewState({
          keybindings: { find: "f", refresh: "r", scrollToHead: "h", scrollToStash: "s" }
        })
      );
      await import("@/webview/main");
    });

    it("opens the Find Widget on Ctrl+F", () => {
      const findWidget = document.getElementById("findWidget")!;
      expect(findWidget.classList.contains("active")).toBe(false);
      pressCtrl("f");
      expect(findWidget.classList.contains("active")).toBe(true);
    });
  });

  describe("with the Find binding set to UNASSIGNED", () => {
    beforeAll(async () => {
      vi.resetModules();
      createVscodeMock();
      setupHtml(
        makeViewState({
          keybindings: { find: null, refresh: "r", scrollToHead: "h", scrollToStash: "s" }
        })
      );
      await import("@/webview/main");
    });

    it("does not open the Find Widget on Ctrl+F", () => {
      const findWidget = document.getElementById("findWidget")!;
      pressCtrl("f");
      expect(findWidget.classList.contains("active")).toBe(false); // shortcut disabled
    });
  });
});
