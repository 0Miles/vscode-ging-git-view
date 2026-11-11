/**
 * View Reflog: browse the current repository's reflog, and the commits
 * dangling beyond it, and recover one — branch from it, reset to it, or copy
 * its hash. The two changes run inside the host's `runRepoMutation`; an answer
 * dismissed or left blank changes nothing.
 */

import type { SimpleGit } from "simple-git";

import { createBranch } from "@ging/core/backend/actions/branch";
import { resetToCommit } from "@ging/core/backend/actions/commit";
import {
  loadDanglingCommits,
  loadReflog,
  type ReflogEntry
} from "@ging/core/backend/queries/loadReflog";
import {
  type CommandKitDeps,
  confirm,
  createMutatingCommandKit,
  type MutationDeps
} from "@ging/core/extension/commandKit";
import type { Clipboard, Prompts } from "@ging/core/host/ports";

export type ReflogCommandDeps = CommandKitDeps &
  MutationDeps & {
    prompts: Pick<Prompts, "pick" | "choose" | "input" | "showInformation" | "showError">;
    clipboard: Clipboard;
  };

export type ReflogCommand = ReturnType<typeof createReflogCommand>;

const FAILED = "reflog.unableTo";

/** The reflog, newest first, then the commits not even it reaches. */
async function loadEntries(git: SimpleGit): Promise<ReflogEntry[]> {
  const [reflog, dangling] = await Promise.all([loadReflog(git), loadDanglingCommits(git)]);
  return [...reflog, ...dangling];
}

export function createReflogCommand(deps: ReflogCommandDeps) {
  const { prompts, l10n } = deps;
  const kit = createMutatingCommandKit(deps);

  /** A branch at `entry`, under a name asked for, not checked out. */
  const branchFrom = async (repo: string, { hash }: ReflogEntry): Promise<void> => {
    const branchName = (await prompts.input({ prompt: l10n.t("reflog.branchNamePrompt") }))?.trim();
    if (!branchName) return;
    await kit.mutateOrToast(FAILED, repo, (git) =>
      createBranch(git, { commitHash: hash, branchName, checkout: false, force: false })
    );
  };

  const resetTo = async (repo: string, { hash, shortHash }: ReflogEntry): Promise<void> => {
    const message = l10n.t("reflog.resetConfirm", shortHash);
    if (!(await confirm(prompts, message, l10n.t("reflog.resetConfirmYes")))) return;
    await kit.mutateOrToast(FAILED, repo, (git) =>
      resetToCommit(git, { commitHash: hash, resetMode: "hard" })
    );
  };

  /** Changes nothing, so it runs outside the hook. */
  const copyHash = async (_repo: string, { hash }: ReflogEntry): Promise<void> => {
    await kit.tryOrToast(FAILED, () => deps.clipboard.writeText(hash));
  };

  /** One of `entries`, searchable by its selector; a dangling one is marked
   *  as a warning, since git's garbage collection may remove it. */
  const pickEntry = (entries: ReflogEntry[]) => {
    const danglingTag = l10n.t("reflog.danglingTag");
    return prompts.pick(
      entries.map((entry) => ({
        label: `${entry.shortHash}  ${entry.subject}`,
        description: entry.dangling ? danglingTag : entry.selector,
        warning: entry.dangling,
        value: entry
      })),
      { placeholder: l10n.t("reflog.pickPrompt"), matchOnDescription: true }
    );
  };

  /** What to do with the entry whose short hash is `shortHash`. */
  const pickAction = (shortHash: string) =>
    prompts.pick(
      [
        { label: l10n.t("reflog.createBranch"), value: branchFrom },
        { label: l10n.t("reflog.resetHard"), value: resetTo },
        { label: l10n.t("reflog.copyHash"), value: copyHash }
      ],
      { placeholder: l10n.t("reflog.actionPrompt", shortHash) }
    );

  /** On the current repository: pick an entry, then what to do with it. */
  const viewReflog = async (): Promise<void> => {
    const repo = kit.currentRepoOrSay();
    if (repo === null) return;
    // The client is built inside: building one throws for a repo deleted
    // since it was last seen.
    const entries = await kit.tryOrToast(FAILED, () => loadEntries(deps.gitClientFor(repo)));
    if (entries === undefined) return;
    if (entries.length === 0) {
      prompts.showInformation(l10n.t("reflog.empty"));
      return;
    }
    const entry = await pickEntry(entries);
    if (entry === undefined) return;
    const action = await pickAction(entry.shortHash);
    await action?.(repo, entry);
  };

  return { viewReflog };
}
