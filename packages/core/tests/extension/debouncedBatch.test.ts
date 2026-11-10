import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { debouncedBatch, inFlightWork } from "@ging/core/extension/debouncedBatch";

const DELAY = 1000;

/** Let the promise callbacks already due run, without moving the clock. */
const settle = () => vi.advanceTimersByTimeAsync(0);

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Whether `promise` has settled yet, read after a `settle()`. */
function watch(promise: Promise<unknown>) {
  const state = { settled: false };
  void promise.then(
    () => (state.settled = true),
    () => (state.settled = true)
  );
  return state;
}

/** A `handle` whose calls stay pending until the test answers them, oldest first. */
function answeredByHand() {
  const waiting: ReturnType<typeof deferred<boolean>>[] = [];
  const handle = vi.fn((_path: string) => {
    const answer = deferred<boolean>();
    waiting.push(answer);
    return answer.promise;
  });
  return {
    handle,
    /** The paths handled so far, in order. */
    handled: () => handle.mock.calls.map(([path]) => path),
    /** Answer the oldest call still waiting, and let the drain move on. */
    async answer(changed: boolean) {
      waiting.shift()!.resolve(changed);
      await settle();
    },
    /** Fail the oldest call still waiting, and let the drain move on. */
    async fail(reason: unknown) {
      waiting.shift()!.reject(reason);
      await settle();
    }
  };
}

/** A `handle` for which no path is a change; a fresh mock per test. */
const noChange = () => vi.fn(async (_path: string) => false);

/**
 * Collect the unhandled rejections raised from here on, instead of letting
 * vitest fail the run over them. Its own listeners are back after the test.
 */
function catchUnhandledRejections(): unknown[] {
  const reasons: unknown[] = [];
  const listener = (reason: unknown) => void reasons.push(reason);
  const theirs = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", listener);
  onTestFinished(() => {
    process.off("unhandledRejection", listener);
    for (const l of theirs) process.on("unhandledRejection", l);
  });
  return reasons;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("debouncedBatch", () => {
  it("handles the queued paths once they stop arriving for the delay", async () => {
    const handle = noChange();
    const batch = debouncedBatch(handle, () => {}, DELAY);

    batch.add("/a");
    await vi.advanceTimersByTimeAsync(600);
    batch.add("/b");
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    expect(handle).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(handle.mock.calls).toEqual([["/a"], ["/b"]]);
  });

  it("queues a path already waiting only once, without restarting the debounce", async () => {
    const handle = noChange();
    const batch = debouncedBatch(handle, () => {}, DELAY);

    batch.add("/a");
    await vi.advanceTimersByTimeAsync(600);
    batch.add("/a");
    await vi.advanceTimersByTimeAsync(DELAY - 600);
    expect(handle.mock.calls).toEqual([["/a"]]);

    // Only while it waits: once handled, the same path is queued again.
    batch.add("/a");
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(handle.mock.calls).toEqual([["/a"], ["/a"]]);
  });

  it("handles the paths one at a time, in the order they were queued", async () => {
    const { handle, handled, answer } = answeredByHand();
    const batch = debouncedBatch(handle, () => {}, DELAY);

    batch.add("/a");
    batch.add("/b");
    batch.add("/c");
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(handled()).toEqual(["/a"]);

    await answer(false);
    expect(handled()).toEqual(["/a", "/b"]);

    await answer(false);
    expect(handled()).toEqual(["/a", "/b", "/c"]);
  });

  it("sets a fresh timer for a path queued mid-drain, and handles it once", async () => {
    const { handle, handled, answer } = answeredByHand();
    const onChanged = vi.fn();
    const batch = debouncedBatch(handle, onChanged, DELAY);

    batch.add("/a");
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(vi.getTimerCount()).toBe(0);

    batch.add("/b");
    expect(vi.getTimerCount()).toBe(1);

    // The running drain takes /b too, so the fresh timer finds nothing left.
    await answer(true);
    await answer(false);
    await vi.runAllTimersAsync();
    expect(handled()).toEqual(["/a", "/b"]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("calls onChanged once at the end of a drain in which some path reported a change", async () => {
    const { handle, answer } = answeredByHand();
    const onChanged = vi.fn();
    const batch = debouncedBatch(handle, onChanged, DELAY);

    batch.add("/a");
    batch.add("/b");
    batch.add("/c");
    await vi.advanceTimersByTimeAsync(DELAY);
    await answer(false);
    await answer(true);
    expect(onChanged).not.toHaveBeenCalled();

    await answer(true);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("does not call onChanged when no path reported a change", async () => {
    const onChanged = vi.fn();
    const batch = debouncedBatch(noChange(), onChanged, DELAY);

    batch.add("/a");
    batch.add("/b");
    await vi.runAllTimersAsync();

    expect(onChanged).not.toHaveBeenCalled();
  });

  it("never overlaps drains: a timer firing mid-drain waits for the drain before it", async () => {
    const { handle, handled, answer } = answeredByHand();
    const batch = debouncedBatch(handle, () => {}, DELAY);

    batch.add("/a");
    await vi.advanceTimersByTimeAsync(DELAY);
    batch.add("/b");
    await vi.advanceTimersByTimeAsync(DELAY);
    // A second drain started by that timer would already be handling /b.
    expect(handled()).toEqual(["/a"]);

    await answer(false);
    expect(handled()).toEqual(["/a", "/b"]);

    await answer(false);
    await vi.runAllTimersAsync();
    expect(handled()).toEqual(["/a", "/b"]);
  });

  it("surfaces a failing path as an unhandled rejection, and later drains still run", async () => {
    const rejections = catchUnhandledRejections();
    const failure = new Error("handle failed");
    const handle = vi.fn(async (path: string) => {
      if (path === "/bad") throw failure;
      return true;
    });
    const onChanged = vi.fn();
    const batch = debouncedBatch(handle, onChanged, DELAY);

    batch.add("/bad");
    await vi.advanceTimersByTimeAsync(DELAY);
    await settle();
    expect(rejections).toEqual([failure]);
    expect(onChanged).not.toHaveBeenCalled();

    batch.add("/good");
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(handle.mock.calls).toEqual([["/bad"], ["/good"]]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(rejections).toEqual([failure]);
  });

  describe("flush", () => {
    it("runs a batch waiting out its debounce at once, and settles once it has run", async () => {
      const { handle, handled, answer } = answeredByHand();
      const onChanged = vi.fn();
      const batch = debouncedBatch(handle, onChanged, DELAY);

      batch.add("/a");
      const flushed = watch(batch.flush());
      await settle();
      expect(handled()).toEqual(["/a"]);
      expect(flushed.settled).toBe(false);

      await answer(true);
      expect(onChanged).toHaveBeenCalledTimes(1);
      expect(flushed.settled).toBe(true);
    });

    it("settles at once when nothing is waiting or running", async () => {
      const batch = debouncedBatch(noChange(), () => {}, DELAY);

      const flushed = watch(batch.flush());
      await settle();

      expect(flushed.settled).toBe(true);
    });

    it("waits for a drain set off by a path queued at the end of the one it awaited", async () => {
      const { handle, handled, answer } = answeredByHand();
      // Queued from inside the drain, once its loop is done: only a fresh
      // timer, and so a second drain, can pick it up.
      const onChanged = vi.fn(() => batch.add("/c"));
      const batch = debouncedBatch(handle, onChanged, DELAY);

      batch.add("/a");
      const flushed = watch(batch.flush());
      await settle();
      await answer(true);
      expect(handled()).toEqual(["/a", "/c"]);
      expect(flushed.settled).toBe(false);

      await answer(false);
      expect(flushed.settled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("waits for a drain a fired timer chained, with no timer left waiting", async () => {
      const rejections = catchUnhandledRejections();
      const { handle, handled, answer, fail } = answeredByHand();
      const batch = debouncedBatch(handle, () => {}, DELAY);

      batch.add("/a");
      await vi.advanceTimersByTimeAsync(DELAY);
      const flushed = watch(batch.flush());
      // Fires while /a is still being handled, chaining a second drain.
      batch.add("/b");
      await vi.advanceTimersByTimeAsync(DELAY);
      expect(vi.getTimerCount()).toBe(0);

      // The first drain stops at its failure, leaving /b to the chained one.
      await fail(new Error("handle failed"));
      expect(handled()).toEqual(["/a", "/b"]);
      expect(flushed.settled).toBe(false);

      await answer(false);
      expect(flushed.settled).toBe(true);
      expect(rejections).toHaveLength(1);
    });
  });

  describe("cancel", () => {
    it("drops the waiting paths and the timer that would run them", async () => {
      const handle = vi.fn(async (_path: string) => true);
      const onChanged = vi.fn();
      const batch = debouncedBatch(handle, onChanged, DELAY);

      batch.add("/a");
      batch.add("/b");
      batch.cancel();
      expect(vi.getTimerCount()).toBe(0);
      await vi.runAllTimersAsync();

      expect(handle).not.toHaveBeenCalled();
      expect(onChanged).not.toHaveBeenCalled();
    });

    it("lets a running drain finish the path it is on, then stop", async () => {
      const { handle, handled, answer } = answeredByHand();
      const onChanged = vi.fn();
      const batch = debouncedBatch(handle, onChanged, DELAY);

      batch.add("/a");
      batch.add("/b");
      await vi.advanceTimersByTimeAsync(DELAY);
      batch.cancel();

      await answer(true);
      await vi.runAllTimersAsync();
      expect(handled()).toEqual(["/a"]);
      // The path it finished did change something, and that is still reported.
      expect(onChanged).toHaveBeenCalledTimes(1);
    });
  });
});

describe("inFlightWork", () => {
  it("settles at once when nothing is tracked", async () => {
    const work = inFlightWork();

    const settled = watch(work.settled());
    await settle();

    expect(settled.settled).toBe(true);
  });

  it("settles once the tracked work has, including work tracked meanwhile", async () => {
    const work = inFlightWork();
    const first = deferred<void>();
    const second = deferred<void>();

    work.track(first.promise);
    const settled = watch(work.settled());
    work.track(second.promise);

    first.resolve();
    await settle();
    expect(settled.settled).toBe(false);

    second.resolve();
    await settle();
    expect(settled.settled).toBe(true);
  });

  it("surfaces failed work as an unhandled rejection without holding up settled", async () => {
    const rejections = catchUnhandledRejections();
    const work = inFlightWork();
    const failing = deferred<void>();
    const failure = new Error("work failed");

    work.track(failing.promise);
    const settled = watch(work.settled());
    failing.reject(failure);
    await settle();

    expect(settled.settled).toBe(true);
    expect(rejections).toEqual([failure]);
  });
});
