/**
 * A conflict, as a host with no merge editor of its own works it (#410): a
 * conflicted file handed to the merge tool the user configured for git, and
 * the question to ask before a file still holding conflict markers is marked
 * resolved. Host-neutral; the desktop host is today's only caller — its
 * `Opener.openMergeEditor`, the Mark Resolved of the graph's conflict banner,
 * and its working tree panel. VS Code opens its own merge editor instead, and
 * its Mark Resolved asks nothing.
 */

import type { SimpleGit } from "simple-git";

import {
  configuredMergeTool,
  type MergeToolRun,
  mergeToolCanName,
  runMergeTool
} from "@ging/core/backend/actions/mergeTool";
import { filesWithConflictMarkers } from "@ging/core/backend/queries/conflictMarkers";
import { unmergedFiles } from "@ging/core/backend/queries/unmergedFiles";
import { formatGitError } from "@ging/core/backend/utils/gitError";
import type { HostLogger, L10n, Prompts, RunRepoMutation } from "@ging/core/host/ports";

export type ConflictCommandsDeps = {
  prompts: Pick<Prompts, "showInformation" | "showWarning" | "showError" | "choose">;
  l10n: L10n;
  logger: Pick<HostLogger, "log">;
  /** The repository's git client, for what is read and asked of git. */
  git: () => SimpleGit;
  /** Where and with what `git mergetool` runs: the repository's top, the
   *  client's git and environment. */
  mergeToolRun: () => MergeToolRun;
  /** The repository, for `runRepoMutation` and for reading its files. */
  repo: () => string;
  /** How the host makes a change to the repository outside the graph's
   *  bridge, the graph refreshed after it (ADR-0013). */
  runRepoMutation: RunRepoMutation;
};

export type ConflictCommands = {
  /**
   * Hand the conflicted `file`, repository-relative, to the merge tool the
   * user configured, and say what came of it once the tool has closed: that
   * it is still in conflict, or nothing when it is resolved — the graph and
   * the panel, refreshed, show that. Says why when it runs nothing: the file
   * is in no conflict, no tool is configured, or one is still open.
   */
  mergeTool(file: string): Promise<void>;
  /** Whether to go on marking `files` resolved: `true` straight away when
   *  none still holds a conflict marker, the user's answer otherwise. */
  confirmResolve(files: readonly string[]): Promise<boolean>;
};

export function createConflictCommands(deps: ConflictCommandsDeps): ConflictCommands {
  const { prompts, l10n, logger } = deps;
  /** The file whose merge tool is open: one at a time. Two would each stage
   *  their file when done, and race for the index. */
  let open: string | null = null;

  const mergeTool = async (file: string): Promise<void> => {
    if (open !== null) {
      void prompts.showInformation(l10n.t("mergeTool.busy", open));
      return;
    }
    open = file;
    try {
      const git = deps.git();
      if (!(await unmergedFiles(git)).includes(file)) {
        void prompts.showInformation(l10n.t("mergeTool.notConflicted", file));
        return;
      }
      if (!mergeToolCanName(file)) {
        void prompts.showError(l10n.t("mergeTool.cannotName", file));
        return;
      }
      const tool = await configuredMergeTool(git);
      if (tool === null) {
        // `git mergetool` would guess one: a program the user never chose.
        void prompts.showError(l10n.t("mergeTool.notConfigured"));
        return;
      }
      // Not muted while it is open: that is the user's own session, minutes
      // long it may be, and the watcher is a flag a mute would hold down for
      // all of it (repoMutation.ts). What it did is read after, refreshed.
      const run = deps.mergeToolRun();
      logger.log(`mergeTool: ${tool} on ${file} in ${run.repoPath}`);
      const outcome = await runMergeTool(run, tool, file);
      let resolved = false;
      // Judged by the working tree, not by what git said (ADR-0030).
      await deps.runRepoMutation(deps.repo(), async () => {
        resolved = !(await unmergedFiles(git)).includes(file);
      });
      logger.log(
        `mergeTool: ${tool} on ${file} exited ${outcome.exitCode}; ${resolved ? "resolved" : "still in conflict"}`
      );
      if (!resolved) void prompts.showWarning(l10n.t("mergeTool.unresolved", file, tool));
    } catch (e: unknown) {
      void prompts.showError(l10n.t("mergeTool.failed", formatGitError(e)));
    } finally {
      open = null;
    }
  };

  const confirmResolve = async (files: readonly string[]): Promise<boolean> => {
    const marked = await filesWithConflictMarkers(deps.repo(), files);
    if (marked.length === 0) return true;
    const answer = await prompts.choose(
      marked.length === 1
        ? l10n.t("conflict.markersRemain", marked[0])
        : l10n.t("conflict.markersRemainMany", marked.length),
      {
        ...(marked.length > 1 && { detail: marked.join("\n") }),
        actions: [{ label: l10n.t("conflict.markResolvedAnyway"), value: true }]
      }
    );
    return answer === true;
  };

  return { mergeTool, confirmResolve };
}
