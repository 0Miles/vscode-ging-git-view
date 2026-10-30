/** Everything git (via simple-git) said about a failure — the text the
 *  classifiers below read before `formatGitError` narrows it to one line. */
function rawGitErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Several git commands of one action that failed on their own, each under
 *  the name of what it was run for (a remote, say). The message is every
 *  failure's raw text, so the classifiers below see all of them; and
 *  `formatGitError` gives one labelled line per failure rather than picking
 *  one failure's line for all. */
export class LabelledGitErrors extends Error {
  constructor(readonly failures: readonly { label: string; error: unknown }[]) {
    super(failures.map((f) => rawGitErrorText(f.error)).join("\n"));
  }
}

/** Turn a noisy git / simple-git error into a concise, human-readable message.
 *
 *  simple-git concatenates the failed command's stdout and stderr into
 *  `Error.message`, so the cause the user actually cares about is usually one
 *  of a few well-known line shapes buried in a wall of output (progress lines,
 *  hints, decorative separators). Rather than surface the whole dump, we pick
 *  the most informative line, preferring — in order — a remote-provided reason
 *  (push hooks, branch protection), a push/fetch rejection reason, then git's
 *  own `fatal:` / `error:` line. Falls back to the first meaningful line. */
export function formatGitError(error: unknown): string {
  if (error instanceof LabelledGitErrors) {
    return error.failures.map((f) => f.label + ": " + formatGitError(f.error)).join("\n");
  }
  const raw = rawGitErrorText(error);
  const lines = raw
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return raw.trim();

  // 1. Reasons the remote reported (pre-receive hook, branch protection, server
  //    policy). Strip the "remote:" prefix and drop decorative separator lines.
  const remote = lines
    .filter((line) => line.startsWith("remote:"))
    .map((line) => line.slice("remote:".length).trim())
    .filter((line) => line.length > 0 && !/^[=\-*!_.\s]+$/.test(line));
  if (remote.length > 0) return remote.join("\n");

  // 2. A push/fetch rejection carries its reason in parentheses, e.g.
  //    "! [rejected] main -> main (non-fast-forward)".
  const rejected = lines.find(
    (line) => line.includes("[rejected]") || line.includes("[remote rejected]")
  );
  if (rejected !== undefined) return rejected.replace(/^!\s*/, "");

  // 3. git's primary error line wins (strip the redundant prefix).
  const fatal = lines.find((line) => /^(fatal|error):/i.test(line));
  if (fatal !== undefined) return fatal.replace(/^(fatal|error):\s*/i, "");

  // 4. Nothing recognisable — surface the first non-empty line.
  return lines[0];
}

/** Whether git refused an operation only because a branch is not fully merged
 *  (so the same delete with `-D` would succeed).
 *
 *  git puts the branch name and the refusal on its `error:` line, but the hint
 *  that identifies the case — the literal command `git branch -D`, which stays
 *  in English across locales — on the *next* line:
 *
 *      error: The branch 'x' is not fully merged.
 *      If you are sure you want to delete it, run 'git branch -D x'.
 *
 *  `formatGitError` keeps only the first of those, so this must be read off the
 *  **raw** error, before formatting — a caller that classifies the formatted
 *  message can never match. */
export function isNotFullyMergedError(error: unknown): boolean {
  return rawGitErrorText(error).includes("git branch -D");
}

/** Whether a force-with-lease push was refused because the remote tip is not
 *  integrated into the local branch (`push.useForceIfIncludes`, ADR-0025):
 *
 *      ! [rejected]        x -> x (remote ref updated since checkout)
 *
 *  The reason in parentheses is not translated by git, unlike the hints that
 *  follow it, so it is what this matches. Read off the raw error like
 *  {@link isNotFullyMergedError}. It does not mean the remote has new commits:
 *  a branch with no reflog is refused the same way. */
export function isRemoteUpdatedSinceCheckoutError(error: unknown): boolean {
  return rawGitErrorText(error).includes("remote ref updated since checkout");
}

/** Whether a force-with-lease push was refused before the integration check
 *  ever ran, because the local remote-tracking ref does not match the remote:
 *  there is none while the remote has the branch, or it is out of date (behind,
 *  or the remote was rewound or has diverged).
 *
 *      ! [rejected]        x -> x (stale info)
 *
 *  Untranslated like {@link isRemoteUpdatedSinceCheckoutError}'s reason. */
export function isStaleLeaseInfoError(error: unknown): boolean {
  return rawGitErrorText(error).includes("(stale info)");
}
