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
  const raw = error instanceof Error ? error.message : String(error);
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
