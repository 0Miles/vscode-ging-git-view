import { describe, expect, it, vi } from "vitest";

import { createLatestLoads } from "@ging/core/extension/latestLoads";

/** What is asked for: a name, the key, and what to load for it. */
type Ask = { name: string };
const ask = (name: string): Ask => ({ name });
const key = ({ name }: Ask) => name;
const VALUE = { loaded: true };

/** A load whose every call can be settled by hand, and whose signals are kept.
 *  Like the real ones, an aborted load resolves null. */
function manualLoad() {
  const calls: { signal: AbortSignal; settle: (value: typeof VALUE | null) => void }[] = [];
  const load = vi.fn(
    (_ask: Ask, signal: AbortSignal) =>
      new Promise<typeof VALUE | null>((resolve) => {
        calls.push({ signal, settle: resolve });
        signal.addEventListener("abort", () => resolve(null));
      })
  );
  return { load, calls };
}

describe("createLatestLoads", () => {
  it("loads each key once", async () => {
    const load = vi.fn(async () => VALUE);
    const { get } = createLatestLoads({ key, load, size: 10 });

    expect(await get(ask("a"))).toBe(VALUE);
    expect(await get(ask("a"))).toBe(VALUE);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("tells keys apart", async () => {
    const load = vi.fn(async () => VALUE);
    const { get } = createLatestLoads({ key, load, size: 10 });

    await get(ask("a"));
    await get(ask("b"));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("loads again after a failure", async () => {
    const load = vi.fn<() => Promise<typeof VALUE | null>>().mockResolvedValueOnce(null);
    load.mockResolvedValue(VALUE);
    const { get } = createLatestLoads({ key, load, size: 10 });

    expect(await get(ask("a"))).toBeNull();
    expect(await get(ask("a"))).toBe(VALUE);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("drops the least recently used value to make room", async () => {
    const load = vi.fn(async () => VALUE);
    const { get } = createLatestLoads({ key, load, size: 2 });

    await get(ask("a"));
    await get(ask("b"));
    await get(ask("a")); // a is now the most recent
    await get(ask("c")); // so b goes
    load.mockClear();

    await get(ask("a"));
    expect(load).not.toHaveBeenCalled();
    await get(ask("b"));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("resolves null when the load rejects", async () => {
    const { get } = createLatestLoads({
      key,
      load: () => Promise.reject(new Error("boom")),
      size: 10
    });
    expect(await get(ask("a"))).toBeNull();
  });

  describe("only the latest request loads", () => {
    it("aborts the load in flight when another key is asked for", async () => {
      const { load, calls } = manualLoad();
      const { get } = createLatestLoads({ key, load, size: 10 });

      const a = get(ask("a"));
      const b = get(ask("b"));

      expect(calls[0].signal.aborted).toBe(true);
      expect(calls[1].signal.aborted).toBe(false);
      expect(await a).toBeNull();
      calls[1].settle(VALUE);
      expect(await b).toBe(VALUE);
    });

    it("lets the load in flight run when the same key is asked for again", () => {
      const { load, calls } = manualLoad();
      const { get } = createLatestLoads({ key, load, size: 10 });

      const first = get(ask("a"));
      const again = get(ask("a"));

      expect(again).toBe(first);
      expect(load).toHaveBeenCalledTimes(1);
      expect(calls[0].signal.aborted).toBe(false);
    });

    it("aborts the load in flight when a key already loaded is asked for", async () => {
      const { load, calls } = manualLoad();
      const { get } = createLatestLoads({ key, load, size: 10 });
      const loaded = get(ask("a"));
      calls[0].settle(VALUE);
      await loaded;

      void get(ask("b"));
      expect(await get(ask("a"))).toBe(VALUE);
      expect(calls[1].signal.aborted).toBe(true);
    });

    it("aborts the load in flight on cancel", () => {
      const { load, calls } = manualLoad();
      const loads = createLatestLoads({ key, load, size: 10 });

      void loads.get(ask("a"));
      loads.cancel();

      expect(calls[0].signal.aborted).toBe(true);
    });

    it("keeps nothing of an aborted load: asked again, it loads again", async () => {
      const { load, calls } = manualLoad();
      const { get } = createLatestLoads({ key, load, size: 10 });

      void get(ask("a"));
      void get(ask("b")); // aborts a
      const again = get(ask("a")); // aborts b, loads a anew

      expect(load).toHaveBeenCalledTimes(3);
      calls[2].settle(VALUE);
      expect(await again).toBe(VALUE);
    });

    it("never lets a late failure of an older load drop a newer one", async () => {
      const { load, calls } = manualLoad();
      const { get } = createLatestLoads({ key, load, size: 10 });

      void get(ask("a"));
      void get(ask("b"));
      const second = get(ask("a"));
      calls[2].settle(VALUE);
      expect(await second).toBe(VALUE);
      calls[0].settle(null); // the aborted first load reports late

      expect(await get(ask("a"))).toBe(VALUE);
      expect(load).toHaveBeenCalledTimes(3);
    });
  });
});
