import { describe, expect, it, vi } from "vitest";

import type { BranchFilterChange } from "@ging/core/extension/branchFilter";
import { createBranchFilterStore } from "@ging/core/extension/branchFilterStore";

// Characterization of the store as it was in apps/vscode, where its event
// emitter was VS Code's (#385): those tests ran against a mock modelling that
// emitter, and now run against the store's own.

function storeWithLog() {
  const store = createBranchFilterStore();
  const fired: BranchFilterChange[] = [];
  store.onDidChangeFilter((change) => fired.push(change));
  return { store, fired };
}

describe("branchFilterStore", () => {
  it("knows no selection for a repo it was never told about, and reads it as show-all", () => {
    const { store } = storeWithLog();
    expect(store.has("/repo")).toBe(false);
    expect(store.get("/repo")).toEqual([]);
  });

  it("records a selection and announces it", () => {
    const { store, fired } = storeWithLog();
    expect(store.set("/repo", ["main", "dev"])).toBe(true);
    expect(store.has("/repo")).toBe(true);
    expect(store.get("/repo")).toEqual(["main", "dev"]);
    expect(fired).toEqual([{ repo: "/repo", branches: ["main", "dev"] }]);
  });

  it("records an empty selection as a selection: show-all, chosen", () => {
    const { store, fired } = storeWithLog();
    expect(store.set("/repo", [])).toBe(true);
    expect(store.has("/repo")).toBe(true);
    expect(fired).toEqual([{ repo: "/repo", branches: [] }]);
  });

  it("ignores a selection equal to the one held, in any order", () => {
    const { store, fired } = storeWithLog();
    store.set("/repo", ["main", "dev"]);
    expect(store.set("/repo", ["dev", "main"])).toBe(false);
    expect(store.get("/repo")).toEqual(["main", "dev"]);
    expect(fired).toHaveLength(1);
  });

  it("records a silent selection without announcing it", () => {
    const { store, fired } = storeWithLog();
    expect(store.set("/repo", ["main"], { silent: true })).toBe(true);
    expect(store.get("/repo")).toEqual(["main"]);
    expect(fired).toEqual([]);
  });

  it("keeps each repo's selection apart", () => {
    const { store, fired } = storeWithLog();
    store.set("/a", ["main"]);
    store.set("/b", ["main"]);
    expect(store.get("/a")).toEqual(["main"]);
    expect(store.get("/b")).toEqual(["main"]);
    expect(fired).toEqual([
      { repo: "/a", branches: ["main"] },
      { repo: "/b", branches: ["main"] }
    ]);
  });

  it("keeps its own copy, out of reach of the caller and the listeners", () => {
    const store = createBranchFilterStore();
    store.onDidChangeFilter(({ branches }) => branches.push("from-listener"));
    const given = ["main"];
    store.set("/repo", given);
    given.push("from-caller");
    expect(store.get("/repo")).toEqual(["main"]);
  });

  it("announces to every listener, synchronously, until each lets go", () => {
    const store = createBranchFilterStore();
    const first: string[][] = [];
    const second: string[][] = [];
    const sub = store.onDidChangeFilter(({ branches }) => first.push(branches));
    store.onDidChangeFilter(({ branches }) => second.push(branches));
    store.set("/repo", ["main"]);
    expect(first).toEqual([["main"]]);
    sub.dispose();
    store.set("/repo", ["dev"]);
    expect(first).toEqual([["main"]]);
    expect(second).toEqual([["main"], ["dev"]]);
  });

  it("tells a listener that subscribes mid-announcement of the next change, not this one", () => {
    const store = createBranchFilterStore();
    const late: string[][] = [];
    store.onDidChangeFilter(() => {
      store.onDidChangeFilter(({ branches }) => late.push(branches));
    });
    store.set("/repo", ["main"]);
    expect(late).toEqual([]);
    store.set("/repo", ["dev"]);
    expect(late).toEqual([["dev"]]);
  });

  it("tells a listener that lets go mid-announcement nothing more, this change included", () => {
    const store = createBranchFilterStore();
    const heard: string[][] = [];
    let second: { dispose(): void } | undefined;
    store.onDidChangeFilter(() => second?.dispose());
    second = store.onDidChangeFilter(({ branches }) => heard.push(branches));
    store.set("/repo", ["main"]);
    expect(heard).toEqual([]);
  });

  it("still records and announces to the rest when a listener throws", () => {
    vi.useFakeTimers();
    try {
      const store = createBranchFilterStore();
      const heard: string[][] = [];
      store.onDidChangeFilter(() => {
        throw new Error("listener broke");
      });
      store.onDidChangeFilter(({ branches }) => heard.push(branches));
      expect(store.set("/repo", ["main"])).toBe(true);
      expect(store.get("/repo")).toEqual(["main"]);
      expect(heard).toEqual([["main"]]);
      // The error is not swallowed: it surfaces on its own, after `set`.
      expect(() => vi.runAllTimers()).toThrow("listener broke");
    } finally {
      vi.useRealTimers();
    }
  });

  it("announces nothing once disposed, but still holds the selections", () => {
    const { store, fired } = storeWithLog();
    store.set("/repo", ["main"]);
    store.dispose();
    expect(store.set("/repo", ["dev"])).toBe(true);
    expect(store.get("/repo")).toEqual(["dev"]);
    expect(fired).toHaveLength(1);
    const late: BranchFilterChange[] = [];
    store.onDidChangeFilter((change) => late.push(change));
    store.set("/repo", ["main"]);
    expect(late).toEqual([]);
  });
});
