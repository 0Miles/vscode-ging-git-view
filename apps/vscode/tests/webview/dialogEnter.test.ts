import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createVscodeMock, makeViewState, setupHtml } from "./setup";

const viewState = makeViewState();

function openFakeDialog(): () => void {
  const dialog = document.getElementById("dialog")!;
  dialog.classList.add("active");
  const action = document.createElement("div");
  action.id = "dialogAction";
  dialog.appendChild(action);
  return () => {
    dialog.classList.remove("active");
    action.remove();
  };
}

describe("dialog Enter submission", () => {
  beforeAll(async () => {
    vi.resetModules();
    createVscodeMock();
    setupHtml(viewState);
    await import("@/webview/main");
  });

  let cleanup: () => void;
  afterEach(() => cleanup?.());

  it("submits the primary action on Enter when not composing", () => {
    cleanup = openFakeDialog();
    const spy = vi.fn();
    document.getElementById("dialogAction")!.addEventListener("click", spy);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not submit while an IME composition is in progress", () => {
    cleanup = openFakeDialog();
    const spy = vi.fn();
    document.getElementById("dialogAction")!.addEventListener("click", spy);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true }));
    expect(spy).not.toHaveBeenCalled();
  });
});
