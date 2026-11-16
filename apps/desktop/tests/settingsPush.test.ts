import { describe, expect, it } from "vitest";

import { pushSettingChange } from "@ging/desktop/settingsPush";
import type { ResponseMessage } from "@ging/shared/types";

import { fakePorts } from "@ging/core/tests/helpers";

// What a graph instance is told after the desktop host writes a setting
// (#397), as VS Code's onDidChangeConfiguration handlers tell the extension's.

function target() {
  const told = { restarts: 0, posted: [] as ResponseMessage[] };
  return {
    told,
    target: {
      restartAutoFetch: () => {
        told.restarts++;
      },
      post: (message: ResponseMessage) => {
        told.posted.push(message);
      }
    }
  };
}

const { config } = fakePorts().ports;

describe("pushing a setting change to a graph instance", () => {
  it.each(["ging-git-view.autoFetch.enabled", "ging-git-view.autoFetch.intervalMinutes"])(
    "re-arms the auto-fetch timer for %s, and posts nothing",
    (key) => {
      const { told, target: t } = target();
      pushSettingChange(key, t, config);
      expect(told).toEqual({ restarts: 1, posted: [] });
    }
  );

  it.each([
    "ging-git-view.fetch.prune",
    "ging-git-view.graph.edgeStyle",
    "ging-git-view.autoFetchX",
    "ging-git-view.dates.format"
  ])("leaves the timer and the graph alone for %s", (key) => {
    const { told, target: t } = target();
    pushSettingChange(key, t, config);
    expect(told).toEqual({ restarts: 0, posted: [] });
  });

  it.each([
    ["ging-git-view.history.firstParentOnly", "onlyFollowFirstParent"],
    ["ging-git-view.history.includeReflogCommits", "includeReflogCommits"],
    ["ging-git-view.show.stashes", "showStashes"],
    ["ging-git-view.show.tagOnlyCommits", "showTagOnlyCommits"],
    ["ging-git-view.show.remoteHeads", "showRemoteHeads"],
    ["ging-git-view.branches.showInactiveByDefault", "showInactiveBranches"],
    ["ging-git-view.branches.showMergedByDefault", "showMergedBranches"],
    ["ging-git-view.show.remoteBranches", "showRemoteBranches"],
    ["ging-git-view.history.commitOrder", "commitOrdering"]
  ])("tells the graph a Repository Setting default moved for %s", (key, field) => {
    const { told, target: t } = target();
    pushSettingChange(key, t, config);
    expect(told.restarts).toBe(0);
    expect(told.posted).toEqual([
      {
        command: "setRepoSettingDefaults",
        defaults: config.repoSettingDefaults(),
        showRemoteBranches: config.showRemoteBranches(),
        changed: [field]
      }
    ]);
  });
});
