import { describe, expect, it, vi } from "vitest";

import {
  type BranchFactsDeps,
  type BranchSnapshot,
  createBranchFacts
} from "@/extension/branchFacts";

const DAY = 86_400;

/** A branch-filter store good enough for the module's narrow view of one. */
function fakeFilterStore(seed?: Record<string, string[]>) {
  const filters = new Map<string, string[]>(Object.entries(seed ?? {}));
  return {
    has: (repo: string) => filters.has(repo),
    get: (repo: string) => filters.get(repo) ?? [],
    set: (repo: string, branches: readonly string[]) => {
      filters.set(repo, [...branches]);
      return true;
    }
  };
}

function snapshot(over: Partial<BranchSnapshot> = {}): BranchSnapshot {
  return {
    branches: ["main", "done", "wip"],
    head: "main",
    isRepo: true,
    dates: {},
    merged: ["main", "done"],
    defaultBranch: "main",
    ...over
  };
}

function makeFacts(over: Partial<BranchFactsDeps> = {}) {
  const deps: BranchFactsDeps = {
    readSnapshot: async () => snapshot(),
    filterStore: fakeFilterStore(),
    resolveShowRemote: () => false,
    resolveExemptPatterns: () => [],
    resolveInactiveThresholdDays: () => 0,
    resolveShowSpecificBranches: () => [],
    resolveShowCurrentBranchByDefault: () => false,
    nowMs: () => 1_000_000_000_000,
    ...over
  };
  // Spy on whichever reader ended up in the deps, so every test can assert on
  // how many real reads its scenario provoked.
  const readSnapshot = vi.fn(deps.readSnapshot);
  return { facts: createBranchFacts({ ...deps, readSnapshot }), readSnapshot };
}

describe("branchFacts classification", () => {
  it("pairs each rule's fact set with its hidable subset", async () => {
    const nowMs = 1_000_000_000_000;
    const nowSec = Math.floor(nowMs / 1000);
    const { facts } = makeFacts({
      readSnapshot: async () =>
        snapshot({ dates: { main: nowSec, done: nowSec - 100 * DAY, wip: nowSec - 100 * DAY } }),
      resolveInactiveThresholdDays: () => 30,
      nowMs: () => nowMs
    });

    const result = await facts.facts("/repo");

    // `done` is both merged and inactive; `wip` only inactive; `main` is the
    // default branch (never merged into itself) and is the head (exempt).
    expect([...result.merged.matched]).toEqual(["done"]);
    expect([...result.inactive.matched].toSorted()).toEqual(["done", "wip"]);
    expect([...result.hidable].toSorted()).toEqual(["done", "wip"]);
  });

  it("keeps the fact set even when every match is exempt (ADR-0003)", async () => {
    const { facts } = makeFacts({ resolveExemptPatterns: () => ["done"] });

    const result = await facts.facts("/repo");

    expect([...result.merged.matched]).toEqual(["done"]);
    expect([...result.merged.hidable]).toEqual([]);
    expect([...result.hidable]).toEqual([]);
  });

  it("exempts the branches the seeded filter selected", async () => {
    // The bug this module exists to kill: the side-view used to read the filter
    // store directly, so a `develop` seeded into the filter by the graph's load
    // was exempt on one surface and hidable on the other until the next reload.
    const { facts } = makeFacts({
      readSnapshot: async () =>
        snapshot({ branches: ["main", "develop"], merged: ["main", "develop"] }),
      resolveShowSpecificBranches: () => ["develop"]
    });

    const result = await facts.facts("/repo");

    expect(result.filter).toEqual(["develop"]);
    expect([...result.merged.matched]).toEqual(["develop"]);
    expect([...result.merged.hidable]).toEqual([]);
  });

  it("seeds the resolved filter back into the store", async () => {
    const filterStore = fakeFilterStore();
    const { facts } = makeFacts({
      filterStore,
      resolveShowCurrentBranchByDefault: () => true
    });

    await facts.facts("/repo");

    expect(filterStore.get("/repo")).toEqual(["main"]);
  });

  it("does not seed a filter when the read produced no branches", async () => {
    // A failed or non-repo read must not clobber a stored selection with the
    // "nothing survived, fall back to the default" empty filter.
    const filterStore = fakeFilterStore({ "/repo": ["wip"] });
    const { facts } = makeFacts({
      filterStore,
      readSnapshot: async () =>
        snapshot({ branches: [], head: null, isRepo: false, merged: [], defaultBranch: null })
    });

    await facts.facts("/repo");

    expect(filterStore.get("/repo")).toEqual(["wip"]);
  });
});

describe("branchFacts caching", () => {
  it("coalesces concurrent reads of the same repo into one", async () => {
    const { facts, readSnapshot } = makeFacts();

    await Promise.all([facts.facts("/repo"), facts.facts("/repo")]);

    expect(readSnapshot).toHaveBeenCalledTimes(1);
  });

  it("serves a second read from the cache inside the TTL", async () => {
    let now = 1_000_000_000_000;
    const { facts, readSnapshot } = makeFacts({ nowMs: () => now });

    await facts.facts("/repo");
    now += 500;
    await facts.facts("/repo");

    expect(readSnapshot).toHaveBeenCalledTimes(1);
  });

  it("re-reads once the TTL has elapsed", async () => {
    let now = 1_000_000_000_000;
    const { facts, readSnapshot } = makeFacts({ nowMs: () => now });

    await facts.facts("/repo");
    now += 1_500;
    await facts.facts("/repo");

    expect(readSnapshot).toHaveBeenCalledTimes(2);
  });

  it("bypasses the cache for a hard read", async () => {
    // The user pressing Refresh must always get a real read, however recently
    // the cache was filled.
    const { facts, readSnapshot } = makeFacts();

    await facts.facts("/repo");
    await facts.facts("/repo", { hard: true });

    expect(readSnapshot).toHaveBeenCalledTimes(2);
  });

  it("re-reads after invalidate()", async () => {
    const { facts, readSnapshot } = makeFacts();

    await facts.facts("/repo");
    facts.invalidate();
    await facts.facts("/repo");

    expect(readSnapshot).toHaveBeenCalledTimes(2);
  });

  it("keeps one entry per repo", async () => {
    const { facts, readSnapshot } = makeFacts();

    await facts.facts("/a");
    await facts.facts("/b");
    await facts.facts("/a");

    expect(readSnapshot).toHaveBeenCalledTimes(2);
  });

  it("re-reads when the repo's show-remote state changed", async () => {
    // Nothing invalidates on the toggle: the entry records what it was read
    // with, so a changed answer can't be served from it.
    const state = { showRemote: false };
    const { facts, readSnapshot } = makeFacts({ resolveShowRemote: () => state.showRemote });

    await facts.facts("/repo");
    state.showRemote = true;
    await facts.facts("/repo");

    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(readSnapshot).toHaveBeenLastCalledWith("/repo", true);
  });

  it("does not cache a failed read", async () => {
    const readSnapshot = vi
      .fn<(repo: string, showRemote: boolean) => Promise<BranchSnapshot>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(snapshot());
    const { facts } = makeFacts({ readSnapshot });

    await expect(facts.facts("/repo")).rejects.toThrow("boom");
    await expect(facts.facts("/repo")).resolves.toBeDefined();
    expect(readSnapshot).toHaveBeenCalledTimes(2);
  });
});

describe("branchFacts freshness of the classification", () => {
  it("re-applies the exemption patterns on a cached snapshot", async () => {
    // The whole point of caching only the read: a config edit takes effect on
    // the next call, with no invalidation edge to remember to wire up.
    const state = { patterns: [] as string[] };
    const { facts, readSnapshot } = makeFacts({ resolveExemptPatterns: () => state.patterns });

    const before = await facts.facts("/repo");
    state.patterns = ["done"];
    const after = await facts.facts("/repo");

    expect([...before.merged.hidable]).toEqual(["done"]);
    expect([...after.merged.hidable]).toEqual([]);
    expect(readSnapshot).toHaveBeenCalledTimes(1);
  });

  it("re-applies the current filter selection on a cached snapshot", async () => {
    const filterStore = fakeFilterStore();
    const { facts, readSnapshot } = makeFacts({ filterStore });

    const before = await facts.facts("/repo");
    filterStore.set("/repo", ["done"]);
    const after = await facts.facts("/repo");

    expect([...before.merged.hidable]).toEqual(["done"]);
    expect([...after.merged.hidable]).toEqual([]);
    expect(readSnapshot).toHaveBeenCalledTimes(1);
  });

  it("re-evaluates inactivity against the current clock, not the snapshot's", async () => {
    // Inactivity is the relation that expires with no filesystem event behind
    // it: the identical snapshot yields a different verdict two days later. A
    // cached `hidable` would go stale here with nothing to detect it.
    const start = 1_000_000_000_000;
    const startSec = Math.floor(start / 1000);
    const clock = { now: start };
    const { facts } = makeFacts({
      readSnapshot: async () =>
        snapshot({
          branches: ["main", "wip"],
          merged: ["main"],
          dates: { wip: startSec - 29 * DAY }
        }),
      resolveInactiveThresholdDays: () => 30,
      nowMs: () => clock.now
    });

    const before = await facts.facts("/repo");
    clock.now = start + 2 * DAY * 1000;
    const after = await facts.facts("/repo");

    expect([...before.inactive.matched]).toEqual([]);
    expect([...after.inactive.matched]).toEqual(["wip"]);
  });
});
