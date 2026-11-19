import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDesktopStorage } from "@ging/desktop/ports/storage";
import { createSideViewLayoutStore } from "@ging/desktop/sideViewLayout";

// The side views' column layout (#459): the app's, kept in the desktop
// host's own state file, so a new Tab and the next launch open with it.

let userData: string;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "ging-side-view-layout-"));
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

/** The store over the state file as it is on disk now: a launch of the app. */
const launch = () => {
  const storage = openDesktopStorage(userData);
  return { storage, layout: createSideViewLayoutStore(storage.global) };
};

describe("the side views' column layout", () => {
  it("is 260 pixels wide and shown until the user says otherwise", () => {
    expect(launch().layout.get()).toEqual({ width: 260, shown: true });
  });

  it("keeps the width dragged to and whether it is shown, for the next launch", async () => {
    const first = launch();
    first.layout.setWidth(420);
    first.layout.setShown(false);
    expect(first.layout.get()).toEqual({ width: 420, shown: false });
    await first.storage.flush();

    expect(launch().layout.get()).toEqual({ width: 420, shown: false });
  });

  it("holds a width to between 160 and 600 pixels, on the way in and out", async () => {
    const { storage, layout } = launch();
    layout.setWidth(90);
    expect(layout.get().width).toBe(160);
    layout.setWidth(1200);
    expect(layout.get().width).toBe(600);

    // Written by hand, or by a later version: held to the bounds all the same.
    storage.global.update("desktopSideViewWidth", 2);
    expect(layout.get().width).toBe(160);
    storage.global.update("desktopSideViewWidth", "wide");
    storage.global.update("desktopSideViewShown", "no");
    expect(layout.get()).toEqual({ width: 260, shown: true });
    await storage.flush();
  });

  it("tells every listener of a change that moved something, and only then", () => {
    const { layout } = launch();
    const heard: unknown[] = [];
    const sub = layout.onDidChange((changed) => heard.push(changed));

    layout.setShown(true);
    layout.setWidth(260);
    layout.setWidth(300);
    layout.setShown(false);
    sub.dispose();
    layout.setShown(true);

    expect(heard).toEqual([
      { width: 300, shown: true },
      { width: 300, shown: false }
    ]);
  });
});
