import type { SimpleGit } from "simple-git";

import { gitClientFactory } from "@/backend/gitClient";
import { loadBranches } from "@/backend/queries/loadBranches";

/**
 * Supplies branch data and git instances to the Branches side-view, decoupled
 * from the Graph panel's shared `gitClient` (whose single "current repo" is
 * driven by the webview's `selectRepo`). The side-view can query and operate on
 * any repo without racing the panel: each call builds a short-lived client for
 * the target repo via the same `gitClientFactory` (so colour-off config and the
 * askpass env are applied identically).
 */
export function createBranchDataService(deps: {
  gitPath: () => string;
  gitEnv?: NodeJS.ProcessEnv;
}) {
  const instanceFor = (repo: string): SimpleGit =>
    gitClientFactory(repo, deps.gitPath(), undefined, deps.gitEnv).getInstance();

  return {
    /** A configured git instance bound to `repo`, for side-view git operations. */
    getGitInstance: instanceFor,

    /** The repo's branches and checked-out head; `isRepo` is false when the
     *  path isn't a git repository. `branchDates` maps each ref to its last
     *  commit time (unix seconds) for inactive-branch classification. */
    async listBranches(
      repo: string,
      showRemoteBranches: boolean
    ): Promise<{
      branches: string[];
      head: string | null;
      isRepo: boolean;
      branchDates: Record<string, number>;
    }> {
      const result = await loadBranches(instanceFor(repo), {
        showRemoteBranches,
        hard: true,
        currentRepo: repo,
        gitPath: deps.gitPath(),
        includeDates: true
      });
      return {
        branches: result.branches,
        head: result.head,
        isRepo: result.isRepo,
        branchDates: result.branchDates ?? {}
      };
    }
  };
}

export type BranchDataService = ReturnType<typeof createBranchDataService>;
