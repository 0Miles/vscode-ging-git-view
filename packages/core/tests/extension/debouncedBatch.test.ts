import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { debouncedBatch } from "@ging/core/extension/debouncedBatch";

const DELAY = 1000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("debouncedBatch", () => {
  it("handles the queued paths once they stop arriving for the delay", async () => {
    const handle = vi.fn(async (_path: string) => false);
    const batch = debouncedBatch(handle, () => {}, DELAY);

    batch.add("/a");
    await vi.advanceTimersByTimeAsync(600);
    batch.add("/b");
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    expect(handle).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(handle.mock.calls).toEqual([["/a"], ["/b"]]);
  });
});
