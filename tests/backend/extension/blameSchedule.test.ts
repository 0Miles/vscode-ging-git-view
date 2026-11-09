import { describe, expect, it } from "vitest";

import { updateDelay } from "@/extension/blameSchedule";

describe("updateDelay", () => {
  it("waits for the cursor to settle when the document was never edited", () => {
    expect(updateDelay({ now: 10_000, lastEditAt: undefined })).toBe(150);
  });

  it("waits 500 ms after an edit", () => {
    expect(updateDelay({ now: 10_000, lastEditAt: 10_000 })).toBe(500);
  });

  // Typing moves the cursor too, right after each keystroke's edit: that move
  // must not bring the annotation back while the user is still typing.
  it("holds a cursor move made while typing until 500 ms after the last edit", () => {
    expect(updateDelay({ now: 10_100, lastEditAt: 10_000 })).toBe(400);
  });

  it("falls back to the cursor settle once typing has stopped long enough", () => {
    expect(updateDelay({ now: 10_400, lastEditAt: 10_000 })).toBe(150);
    expect(updateDelay({ now: 20_000, lastEditAt: 10_000 })).toBe(150);
  });
});
