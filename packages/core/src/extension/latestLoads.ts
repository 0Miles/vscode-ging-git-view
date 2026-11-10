/**
 * Values `load` finds for what is asked for, loaded once per `key` and kept —
 * for what never changes (a commit's change, say), so a value is only ever
 * dropped to make room, the least recently used first, `size` at most. A
 * failure (null, or a rejection) is not kept: it may not happen again, so the
 * next request loads again.
 *
 * Only the latest request loads: at most one load is in flight, and asking for
 * any other key — or `cancel` — aborts it through its signal, which settles it
 * at once and sends its git processes a kill (best-effort, see `killTree` in
 * `gitSpawn.ts`) rather than leaving them to run to their deadline. An aborted
 * load is not kept either.
 */
export function createLatestLoads<A, V>(deps: {
  key: (ask: A) => string;
  load: (ask: A, signal: AbortSignal) => Promise<V | null>;
  size: number;
}): { get: (ask: A) => Promise<V | null>; cancel: () => void } {
  const entries = new Map<string, Promise<V | null>>();
  let inFlight: { key: string; abort: AbortController } | undefined;

  function cancel() {
    if (inFlight === undefined) return;
    inFlight.abort.abort();
    // Gone at once, so nothing asked for meanwhile gets its null.
    entries.delete(inFlight.key);
    inFlight = undefined;
  }

  function get(ask: A): Promise<V | null> {
    const key = deps.key(ask);
    if (inFlight?.key !== key) cancel();
    const cached = entries.get(key);
    if (cached !== undefined) {
      // Most recently used goes last, so the first is the one to drop.
      entries.delete(key);
      entries.set(key, cached);
      return cached;
    }
    const abort = new AbortController();
    const flight = { key, abort };
    inFlight = flight;
    const value: Promise<V | null> = deps
      .load(ask, abort.signal)
      .catch(() => null)
      .then((result) => {
        if (inFlight === flight) inFlight = undefined;
        // Only this load's own entry: a newer one may have taken its key.
        if (result === null && entries.get(key) === value) entries.delete(key);
        return result;
      });
    entries.set(key, value);
    if (entries.size > deps.size) entries.delete(entries.keys().next().value!);
    return value;
  }

  return { get, cancel };
}
