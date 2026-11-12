import { describe, expect, it } from "vitest";

import { buildGraphViewState } from "@ging/core/extension/graphViewState";
import type { HostConfig } from "@ging/core/host/ports";
import { DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY } from "@ging/shared/backend/utils/contextMenuVisibility";

import { fakePorts } from "@ging/core/tests/helpers";

const dialogMemory = { merge: { squash: "true" } };

function build(opts: { config?: HostConfig; avatarStorage?: boolean } = {}) {
  const { ports } = fakePorts();
  return buildGraphViewState({
    config: opts.config ?? ports.config,
    repoSource: ports.repoSource,
    extensionState: {
      getDialogMemory: () => dialogMemory,
      isAvatarStorageAvailable: () => opts.avatarStorage ?? true
    }
  });
}

describe("buildGraphViewState", () => {
  it("assembles the graph's view state from the host's settings, repos and remembered state", () => {
    expect(build()).toStrictEqual({
      autoCenterCommitDetailsView: true,
      commitDetailsViewLocation: "Docked to Bottom",
      referenceLabelAlignment: "Branches (on the left) & Tags (on the right)",
      combineLocalAndRemoteBranchLabels: true,
      dialogDeleteBranchForceDelete: false,
      dialogCherryPickNoCommit: true,
      dialogAddTagType: "lightweight",
      dialogCreateBranchCheckOut: true,
      dialogMergeNoFastForward: false,
      dialogMergeSquash: true,
      dialogResetMode: "hard",
      dialogMemory: { merge: { squash: "true" } },
      contextMenuActionsVisibility: DEFAULT_CONTEXT_MENU_ACTIONS_VISIBILITY,
      customBranchGlobPatterns: [{ name: "Features", glob: "feature/*" }],
      customEmojiShortcodeMappings: { ship: "🚢" },
      dateFormat: "ISO Date Only",
      dateCustomFormat: "YYYY-MM-DD",
      defaultColumnVisibility: { date: true, author: false, commit: true },
      enhancedAccessibility: false,
      fetchAvatars: true,
      fileTreeCompactFolders: false,
      fileViewType: "File List",
      graphColours: ["#0085d9", "#d9008f"],
      graphStyle: "angular",
      initialLoadCommits: 300,
      issueLinkingRegex: "#(\\d+)",
      issueLinkingUrl: "https://example.com/issues/$1",
      keybindings: { find: "f", refresh: "r", scrollToHead: null, scrollToStash: "s" },
      lastActiveRepo: "/a",
      loadMoreAutomatically: true,
      loadMoreCount: 100,
      markdown: false,
      muteCommitsNotAncestorsOfHead: true,
      muteMergeCommits: false,
      signCommits: false,
      onLoadScrollToHead: true,
      referenceInputSpaceSubstitution: "Hyphen",
      repos: { "/a": { columnWidths: null } },
      scmMultiRepoSelection: true,
      showCurrentBranchByDefault: false,
      uncommittedChangesAtHead: true,
      showSpecificBranches: ["main"],
      showRemoteBranches: false,
      repoSettingDefaults: {
        onlyFollowFirstParent: false,
        includeReflogCommits: false,
        showStashes: false,
        showTagOnlyCommits: false,
        showRemoteHeads: false,
        showInactiveBranches: false,
        showMergedBranches: false
      },
      showTags: false
    });
  });

  it("reads each setting-backed field from the setting of its own name", () => {
    const { ports } = fakePorts();
    // Every setting answers with its own name, so a field wired to the wrong
    // one shows it — which two fields of equal value would not.
    const named = Object.fromEntries(
      Object.keys(ports.config).map((key) => [key, () => `setting:${key}`])
    ) as unknown as HostConfig;
    const state = build({ config: named });
    // Not settings, or (`fetchAvatars`) not the setting alone: see below.
    const notSettings = new Set(["dialogMemory", "lastActiveRepo", "repos", "fetchAvatars"]);
    for (const [field, value] of Object.entries(state)) {
      if (notSettings.has(field)) continue;
      expect(value, field).toBe(`setting:${field}`);
    }
  });

  it("fetches avatars only when the setting asks and there is somewhere to keep them", () => {
    const { ports } = fakePorts();
    const off: HostConfig = { ...ports.config, fetchAvatars: () => false };
    expect(build().fetchAvatars).toBe(true);
    expect(build({ avatarStorage: false }).fetchAvatars).toBe(false);
    expect(build({ config: off }).fetchAvatars).toBe(false);
  });
});
