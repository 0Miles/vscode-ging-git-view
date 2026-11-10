/**
 * A queue of paths waiting for the debounce to fire, deduplicated while they
 * wait.
 *
 * The array keeps the order, because the drain is ordered and re-entrant —
 * each path is awaited, so more events arrive mid-drain. The Set answers
 * membership in O(1): a branch switch, a build or an `npm install` reports tens
 * of thousands of paths, each one a membership check on the host's shared
 * thread.
 */
export function pathQueue() {
  const queue: string[] = [];
  const queued = new Set<string>();
  return {
    /** Queue the path, reporting whether it was not already waiting. */
    add(path: string): boolean {
      if (queued.has(path)) return false;
      queued.add(path);
      queue.push(path);
      return true;
    },
    /** The next path to process, or `undefined` when the queue is empty. */
    next(): string | undefined {
      const path = queue.shift();
      if (path !== undefined) queued.delete(path);
      return path;
    },
    /** Empty the queue. */
    clear(): void {
      queue.length = 0;
      queued.clear();
    }
  };
}

/** Work that has started and not yet settled, for a flush to wait out. */
export function inFlightWork() {
  const running = new Set<Promise<void>>();
  return {
    track(work: Promise<void>): void {
      running.add(work);
      // A failure leaves the set and still surfaces as an unhandled rejection:
      // `finally` passes it on to a promise nothing handles.
      void work.finally(() => running.delete(work));
    },
    /** Settle once nothing tracked is running, including work tracked meanwhile. */
    async settled(): Promise<void> {
      // eslint-disable-next-line no-await-in-loop -- each pass waits out what the last one missed
      while (running.size > 0) await Promise.allSettled(running);
    }
  };
}

/**
 * Paths handled together once they stop arriving for `delay`: each is passed to
 * `handle` in turn, including any queued while the batch runs, and `onChanged`
 * is called once at the end if any of them reported a change.
 *
 * Drains never overlap: each is chained after the one before it, so a timer
 * that fires mid-drain queues the next drain rather than starting a second one
 * on the same queue.
 */
export function debouncedBatch(
  handle: (path: string) => Promise<boolean>,
  onChanged: () => void,
  delay: number
) {
  const paths = pathQueue();
  let timeout: NodeJS.Timeout | null = null;
  /** The last drain started; it settles, never rejects, once that drain ends. */
  let running: Promise<void> = Promise.resolve();

  async function drain() {
    let path;
    let changes = false;
    while ((path = paths.next())) {
      if (await handle(path)) changes = true; // eslint-disable-line no-await-in-loop -- ordered drain, one path at a time
    }
    if (changes) onChanged();
  }

  function run() {
    // `timeout` only ever holds a timer still waiting to fire, so a path queued
    // mid-drain sets a fresh timer instead of being left behind a spent one.
    timeout = null;
    const drained = running.then(drain);
    // The next drain waits for this one however it ends. A failure still
    // surfaces as an unhandled rejection (see `inFlightWork().track` for how),
    // while the chain itself carries on.
    running = new Promise((resolve) => void drained.finally(() => resolve()));
  }

  return {
    /** Queue the path and restart the debounce, unless it is already queued. */
    add(path: string): void {
      if (!paths.add(path)) return;
      if (timeout !== null) clearTimeout(timeout);
      timeout = setTimeout(run, delay);
    },
    /** Run the batch now if it is waiting out its debounce, and settle once no
     *  batch is waiting or running. */
    async flush(): Promise<void> {
      let awaited: Promise<void>;
      do {
        if (timeout !== null) {
          clearTimeout(timeout);
          run();
        }
        awaited = running;
        await awaited; // eslint-disable-line no-await-in-loop -- each wait re-checks for later drains
        // A path queued meanwhile has set a timer, or one that already fired
        // has chained another drain.
      } while (timeout !== null || running !== awaited);
    },
    /** Drop the waiting paths and the timer that would run them. A drain
     *  already running stops after the path it is on. */
    cancel(): void {
      if (timeout !== null) clearTimeout(timeout);
      timeout = null;
      paths.clear();
    }
  };
}
