import type { SimpleGit } from "simple-git";

import { type GitCommandHandler, gitClientFactory } from "@/backend/gitClient";

/**
 * Configured git instances for arbitrary repos, decoupled from the Graph
 * panel's shared `gitClient` (whose single "current repo" is driven by the
 * webview's `selectRepo`). The side-views and `BranchFacts` can read and
 * operate on any repo without racing the panel: each call builds a short-lived
 * client for the target repo through the same `gitClientFactory`, so colour-off
 * config, the askpass env and the command log all apply identically.
 */
export function createRepoGitClients(deps: {
  gitPath: () => string;
  gitEnv?: NodeJS.ProcessEnv;
  /** Command logger, so reads made outside the graph panel are visible in the
   *  Output Channel too. */
  onCommand?: GitCommandHandler;
}) {
  return {
    gitClientFor: (repo: string): SimpleGit =>
      gitClientFactory(repo, deps.gitPath(), deps.onCommand, deps.gitEnv).getInstance()
  };
}

export type RepoGitClients = ReturnType<typeof createRepoGitClients>;
