import type { CommitOrdering } from "@/backend/types";
import type { GitRepoState } from "@/types";

/** Path (relative to the repo root) of the shareable GING config file. */
export const EXTERNAL_CONFIG_RELATIVE_PATH = ".vscode/ging-git-view.json";

/** The subset of a repo's GING configuration that is shared via the file. */
export type ExternalRepoConfig = {
  commitOrder?: CommitOrdering;
  showRemoteBranches?: boolean;
  hiddenRemotes?: string[];
};

const COMMIT_ORDERS = new Set<string>(["date", "author-date", "topo"]);

/** Build the shareable configuration from a repo's state. */
export function generateExternalConfig(state: GitRepoState): ExternalRepoConfig {
  const config: ExternalRepoConfig = {};
  if (state.commitOrdering !== null && state.commitOrdering !== undefined) {
    config.commitOrder = state.commitOrdering;
  }
  if (typeof state.showRemoteBranches === "boolean") {
    config.showRemoteBranches = state.showRemoteBranches;
  }
  if (Array.isArray(state.hiddenRemotes) && state.hiddenRemotes.length > 0) {
    config.hiddenRemotes = state.hiddenRemotes;
  }
  return config;
}

/**
 * Parse and validate an external config file's content. Returns null
 * when the content is not a JSON object; individual fields with the wrong type
 * are dropped rather than failing the whole file.
 */
export function parseExternalConfig(content: string): ExternalRepoConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const config: ExternalRepoConfig = {};
  if (typeof obj.commitOrder === "string" && COMMIT_ORDERS.has(obj.commitOrder)) {
    config.commitOrder = obj.commitOrder as CommitOrdering;
  }
  if (typeof obj.showRemoteBranches === "boolean")
    config.showRemoteBranches = obj.showRemoteBranches;
  if (Array.isArray(obj.hiddenRemotes) && obj.hiddenRemotes.every((x) => typeof x === "string")) {
    config.hiddenRemotes = obj.hiddenRemotes as string[];
  }
  return config;
}

/** Merge an external config's fields into a repo state, returning a new state. */
export function applyExternalConfig(config: ExternalRepoConfig, state: GitRepoState): GitRepoState {
  const merged: GitRepoState = { ...state };
  if (config.commitOrder !== undefined) merged.commitOrdering = config.commitOrder;
  if (config.showRemoteBranches !== undefined)
    merged.showRemoteBranches = config.showRemoteBranches;
  if (config.hiddenRemotes !== undefined) merged.hiddenRemotes = config.hiddenRemotes;
  return merged;
}

/** Serialise a config for writing to the file (pretty JSON + trailing newline). */
export function serializeExternalConfig(config: ExternalRepoConfig): string {
  return JSON.stringify(config, null, 2) + "\n";
}
