/**
 * Spell a path so a POSIX shell runs it as a program.
 *
 * git hands some hooks to the shell rather than exec'ing them — GIT_EDITOR and
 * GIT_SEQUENCE_EDITOR are command *strings*, not program paths (GIT_ASKPASS, by
 * contrast, is exec'd, which is why the askpass helper needs none of this). A
 * Windows path handed over raw is destroyed on the way: the shell reads every
 * backslash as an escape, so `D:\a\out\x.sh` arrives as `D:aoutx.sh` and git
 * reports the editor as "command not found".
 *
 * Forward slashes are understood by the shell git ships on Windows and are not
 * escapes; the quotes carry paths containing spaces.
 */
export function shellCommandPath(filePath: string): string {
  return '"' + filePath.split("\\").join("/") + '"';
}
