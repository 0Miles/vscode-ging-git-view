import { describe, expect, it } from "vitest";

import {
  ConfigScope,
  PruneTagsMigrationDeps,
  pruneTagsScopesToClear,
  runPruneTagsMigration
} from "@/extension/pruneTagsMigration";

describe("pruneTagsScopesToClear", () => {
  it("clears every scope holding an explicit true when prune was never chosen", () => {
    // `prune` carries no explicit value, so it only just inherited the new `true`
    // default — the gate that kept these opted-in tags safe has come off (#34).
    expect(pruneTagsScopesToClear({}, { globalValue: true, workspaceValue: true })).toEqual<
      ConfigScope[]
    >(["global", "workspace"]);
    expect(pruneTagsScopesToClear({}, { workspaceFolderValue: true })).toEqual<ConfigScope[]>([
      "workspaceFolder"
    ]);
  });

  it("leaves the setting alone when the user chose prune for themselves", () => {
    // Turning prune on with pruneTags already true is opting into both.
    expect(pruneTagsScopesToClear({ globalValue: true }, { globalValue: true })).toEqual([]);
    // Turning prune off keeps pruneTags inert, so there is nothing to rescue.
    expect(pruneTagsScopesToClear({ workspaceValue: false }, { globalValue: true })).toEqual([]);
  });

  it("has nothing to clear when pruneTags was never turned on", () => {
    expect(pruneTagsScopesToClear({}, {})).toEqual([]);
    expect(pruneTagsScopesToClear({}, { globalValue: false })).toEqual([]);
    expect(pruneTagsScopesToClear(undefined, undefined)).toEqual([]);
  });
});

/** Records what the migration did, standing in for settings + globalState + UI. */
function spyDeps(inspections: Record<string, unknown>, alreadyRun = false) {
  const record = { disabled: [] as ConfigScope[], marked: false, notified: 0 };
  const deps: PruneTagsMigrationDeps = {
    inspect: (key) => inspections[key] as never,
    disablePruneTags: (scope) => {
      record.disabled.push(scope);
      return Promise.resolve();
    },
    hasRun: () => alreadyRun,
    markRun: () => {
      record.marked = true;
    },
    notify: () => {
      record.notified += 1;
    }
  };
  return { deps, record };
}

describe("runPruneTagsMigration", () => {
  it("turns pruneTags off at each affected scope, then says so once", async () => {
    const { deps, record } = spyDeps({
      "fetch.prune": {},
      "fetch.pruneTags": { globalValue: true, workspaceValue: true }
    });

    expect(await runPruneTagsMigration(deps)).toEqual<ConfigScope[]>(["global", "workspace"]);
    expect(record.disabled).toEqual<ConfigScope[]>(["global", "workspace"]);
    expect(record.notified).toBe(1);
    expect(record.marked).toBe(true);
  });

  it("marks itself done even with nothing to clear, and stays quiet", async () => {
    // Without this the check would run again on the next activation and undo a
    // pruneTags the user had by then turned on deliberately.
    const { deps, record } = spyDeps({ "fetch.prune": {}, "fetch.pruneTags": {} });

    expect(await runPruneTagsMigration(deps)).toEqual([]);
    expect(record.disabled).toEqual([]);
    expect(record.notified).toBe(0);
    expect(record.marked).toBe(true);
  });

  it("keeps going, and still finishes, when one scope refuses the write", async () => {
    // This runs during activation. A rejected `update` must not escape as an
    // unhandled rejection, strand the remaining scopes, or skip `markRun` and
    // leave the migration retrying on every launch.
    const { deps, record } = spyDeps({
      "fetch.prune": {},
      "fetch.pruneTags": { globalValue: true, workspaceValue: true }
    });
    const failing: PruneTagsMigrationDeps = {
      ...deps,
      disablePruneTags: (scope) =>
        scope === "global" ? Promise.reject(new Error("no")) : deps.disablePruneTags(scope)
    };

    expect(await runPruneTagsMigration(failing)).toEqual<ConfigScope[]>(["workspace"]);
    expect(record.disabled).toEqual<ConfigScope[]>(["workspace"]);
    expect(record.notified).toBe(1);
    expect(record.marked).toBe(true);
  });

  it("does nothing at all once it has run", async () => {
    const { deps, record } = spyDeps(
      { "fetch.prune": {}, "fetch.pruneTags": { globalValue: true } },
      true
    );

    expect(await runPruneTagsMigration(deps)).toEqual([]);
    expect(record.disabled).toEqual([]);
    expect(record.notified).toBe(0);
  });
});
