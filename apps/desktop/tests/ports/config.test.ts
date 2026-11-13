import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { createDesktopConfig } from "@ging/desktop/ports/config";
import { openDesktopSettings } from "@ging/desktop/settings/schema";
import { DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY } from "@ging/shared/backend/utils/contextMenuVisibility";

import { makeTempDir, rmrf } from "@ging/core/tests/helpers";

/** The desktop HostConfig over the settings file of a fresh user data folder;
 *  `set` writes the file, by the setting names after `ging-git-view.`. */
function subject() {
  const dir = makeTempDir("ging-desktop-config-");
  onTestFinished(() => rmrf(dir));
  const file = path.join(dir, "settings.json");
  const config = createDesktopConfig(openDesktopSettings(dir));
  const set = (values: Record<string, unknown>) =>
    fs.writeFileSync(
      file,
      JSON.stringify(
        Object.fromEntries(Object.entries(values).map(([k, v]) => [`ging-git-view.${k}`, v]))
      )
    );
  return { config, set };
}

describe("the desktop HostConfig", () => {
  it("answers every method from a setting the desktop app has", () => {
    const { config } = subject();
    for (const [name, method] of Object.entries(config)) {
      expect(() => (method as () => unknown)(), name).not.toThrow();
    }
  });

  it("answers the extension's defaults when nothing is set", () => {
    const { config } = subject();
    expect(config.fetchAndPrune()).toBe(true);
    expect(config.fetchAndPruneTags()).toBe(false);
    expect(config.graphStyle()).toBe("rounded");
    expect(config.dateFormat()).toBe("Date & Time");
    expect(config.dialogMergeNoFastForward()).toBe(true);
    expect(config.inactiveBranchAlwaysShow()).toEqual([
      "main",
      "master",
      "develop",
      "dev",
      "trunk"
    ]);
    expect(config.keybindings()).toEqual({
      find: "f",
      refresh: "r",
      scrollToHead: "h",
      scrollToStash: "s"
    });
    expect(config.contextMenuActionsVisibility()).toEqual(DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY);
    expect(config.defaultColumnVisibility()).toEqual({ date: true, author: true, commit: true });
    expect(config.graphColours()).toHaveLength(12);
    expect(config.repoSettingDefaults()).toEqual({
      onlyFollowFirstParent: false,
      includeReflogCommits: false,
      showStashes: true,
      showTagOnlyCommits: true,
      showRemoteHeads: true,
      showInactiveBranches: false,
      showMergedBranches: false
    });
  });

  it("reads a setting when it is asked for, so a change reaches the next request", () => {
    const { config, set } = subject();
    set({ "signing.commits": true });
    expect(config.signCommits()).toBe(true);
    set({ "signing.commits": false });
    expect(config.signCommits()).toBe(false);
  });

  it("maps the settings whose values are worded for the Settings editor", () => {
    const { config, set } = subject();
    set({
      "detailsPanel.position": "Docked to Bottom",
      "graph.uncommittedMarker": "Open Circle at the Checked Out Commit",
      "dialogDefaults.mergeSquashMessageFormat": "Git SQUASH_MSG",
      "shortcuts.find": "CTRL/CMD + K",
      "shortcuts.refresh": "UNASSIGNED"
    });
    expect(config.commitDetailsViewLocation()).toBe("Docked to Bottom");
    expect(config.uncommittedChangesAtHead()).toBe(true);
    expect(config.squashMergeMessageFormat()).toBe("Git SQUASH_MSG");
    expect(config.keybindings()).toMatchObject({ find: "k", refresh: null });
  });

  it("keeps only the well-formed entries of the list settings", () => {
    const { config, set } = subject();
    set({
      customBranchGlobs: [
        { name: "Features", glob: "feature/*" },
        { name: "Empty", glob: "" },
        { name: 3, glob: "x/*" }
      ],
      customEmojiShortcodes: [{ shortcode: ":ship:", emoji: "🚢" }, { shortcode: "x" }],
      "graph.palette": ["#0085d9", "not a colour", "rgb(1, 2, 3)"],
      "onOpen.branchSelection": ["main", 7, "develop"],
      "pullRequests.providers": [
        { host: "git.example.com", type: "gitlab" },
        { host: "", type: "github" }
      ]
    });
    expect(config.customBranchGlobPatterns()).toEqual([{ name: "Features", glob: "feature/*" }]);
    expect(config.customEmojiShortcodeMappings()).toEqual({ ship: "🚢" });
    expect(config.graphColours()).toEqual(["#0085d9", "rgb(1, 2, 3)"]);
    expect(config.showSpecificBranches()).toEqual(["main", "develop"]);
    expect(config.pullRequestProviders()).toEqual([{ host: "git.example.com", type: "gitlab" }]);
  });

  it("merges a partial column choice over the defaults", () => {
    const { config, set } = subject();
    set({ columnVisibility: { author: false } });
    expect(config.defaultColumnVisibility()).toEqual({ date: true, author: false, commit: true });
  });

  it("answers the repo defaults from their own settings", () => {
    const { config, set } = subject();
    set({ "history.firstParentOnly": true, "show.stashes": false, "show.remoteBranches": false });
    expect(config.repoSettingDefaults()).toMatchObject({
      onlyFollowFirstParent: true,
      showStashes: false
    });
    expect(config.showRemoteBranches()).toBe(false);
  });

  it("answers the defaults for a settings file it cannot parse, and reports it", () => {
    const dir = makeTempDir("ging-desktop-config-");
    onTestFinished(() => rmrf(dir));
    fs.writeFileSync(path.join(dir, "settings.json"), '{ "ging-git-view.show.tags": false, }');
    const errors: string[] = [];
    const config = createDesktopConfig(
      openDesktopSettings(dir, { onError: (message) => errors.push(message) })
    );
    expect(config.showTags()).toBe(true);
    expect(errors).toEqual([expect.stringContaining("settings.json")]);
  });

  it("offers no repo dropdown in the graph: a desktop tab is one repository", () => {
    expect(subject().config.scmMultiRepoSelection()).toBe(false);
  });
});
